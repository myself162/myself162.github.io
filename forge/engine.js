// 鍛造原型 v3「基準版」規則引擎：ForgeTax 的籤模型、價值公式、遺物效果、回合與經濟 1:1 移植。
// 純邏輯，沒有畫面；index.html 和 sim-core.js 共用。瀏覽器：window.ForgeEngine；Node：module.exports。
//
// 一局 = 連續回合。每回合：發劍 → 鍛造／商店（同時開放）→ 搖鈴結算 → 下一回合。
// 原作的即時節奏（0.64 秒一鎚、入神 4 秒）換算成鎚數；其餘規則照抄。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 結果順序與原作 ForgeOutcome 相同：0 破壞、1 損傷、2 維持、3 成功、4 大成功。
  const OUTCOMES = ['break', 'damage', 'hold', 'success', 'great'];
  const OUT_INDEX = { break: 0, damage: 1, hold: 2, success: 3, great: 4 };
  const LABEL = { break: '破壞', damage: '損傷', hold: '維持', success: '成功', great: '大成功', saved: '護盾擋下', deliver: '上貢', deposit: '投入販賣機', settle: '結算', rewind: '回溯' };
  const BASELINE = [9, 2, 5, 12, 2];
  const STRIKE_SECONDS = 0.64; // 原作每鎚間隔，用來把入神秒數換成鎚數

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const round0 = v => Math.round(v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const inc = (v, n) => Math.min(2147483647, Math.max(0, v) + Math.max(0, n == null ? 1 : n));

  function item(cfg, id) { return cfg.itemsById[id] || null; }
  function rank(s, id) { return s.relics.includes(id) ? 1 : 0; }

  // ---------- 配額 ----------
  function baseQuota(cfg, round) {
    const q = cfg.quotas;
    if (round <= q.length) return q[Math.max(0, round - 1)];
    return round0(q[q.length - 1] * Math.pow(cfg.endlessGrowth, round - q.length));
  }
  function quota(s) {
    const num = baseQuota(s.cfg, s.round) * (rank(s, 'letter') ? 0.9 : 1.0);
    return Math.max(0, round0(num - Math.min(s.tributeCredit, num * 0.3)));
  }
  function gradeCap(cfg) { return cfg.maxGrade; }

  // ---------- 價值 ----------
  function basis(s, w, grade) {
    const e = w.effects;
    return (s.cfg.baseValue + e.baseBonus + e.seedBase + e.growthBase) * Math.pow(s.cfg.gradeMultiplier, grade);
  }
  function valueOf(s, w) {
    const e = w.effects;
    return round0(Math.min(1e100, Math.max(0, (basis(s, w, w.grade) + e.flat) * e.multiplier * e.greatMultiplier * e.valueScale)));
  }
  function swordRisk(s, e) {
    if (!e) return 1.0;
    return (rank(s, 'brace') ? Math.max(0.82, 1.0 - 0.03 * clamp(e.brace, 0, 6)) : 1.0) *
      (rank(s, 'repair') ? Math.max(0.4, 1.0 - 0.15 * clamp(e.temperScars, 0, 4)) : 1.0);
  }
  function refreshValue(s, w) {
    if (!w || w.broken) return;
    const e = w.effects;
    e.baseBonus = 80 * rank(s, 'coal') + 20 * Math.max(0, s.successfulTributes) * rank(s, 'hearth');
    e.valueScale = (rank(s, 'thorn') ? 1.1 : 1.0) * (rank(s, 'token') ? 1.15 : 1.0) * ((w.grade >= 8 && rank(s, 'blackstone')) ? 1.3 : 1.0) * ((w.grade >= 12 && rank(s, 'dragonseal')) ? 1.5 : 1.0);
    if (!rank(s, 'repair')) e.repairBank = 0;
    if (!rank(s, 'royalseal')) { e.retaliation = 0; e.damageGreatTickets = 0; }
    if (!rank(s, 'still')) e.stillHolds = 0;
    if (!rank(s, 'oath')) e.oathDamages = 0;
    if (!rank(s, 'rage')) e.rageHolds = 0;
    if (!rank(s, 'spine')) { e.spineLosses = 0; e.spineShield = false; }
    if (!rank(s, 'star')) e.starReady = false;
    if (!rank(s, 'dice')) e.diceReady = false;
    if (!rank(s, 'bellows')) e.bellowsHits = 0;
    if (!rank(s, 'endlessaxle')) e.axleSuccesses = 0;
    e.risk = swordRisk(s, e);
    w.value = valueOf(s, w);
    e.peak = Math.max(e.peak, w.value);
  }

  // ---------- 籤 ----------
  function runTickets(s, i) { return Math.max(0, s.ossuaryTickets[i] || 0); }
  // run 層級的籤（籤紙上黑色的部分）
  function fillDeck(s, t) {
    const sickle = rank(s, 'sicklehammer') > 0;
    t[0] = Math.max(1, (sickle ? 5 : 9) - 2 * rank(s, 'rivet') + 3 * rank(s, 'butterfingers'));
    t[1] = Math.max(0, (sickle ? 5 : 2) - rank(s, 'mallet') + 2 * rank(s, 'thorn') + 3 * rank(s, 'deeppearl'));
    t[2] = Math.max(0, 5 - 2 * rank(s, 'file') + 2 * rank(s, 'hold') + 3 * rank(s, 'patience') - 2 * rank(s, 'thorn') + 6 * rank(s, 'eternalseed'));
    t[3] = (sickle ? 5 : 12) + 4 * rank(s, 'nail') + 2 * rank(s, 'file') + rank(s, 'mallet') + 6 * rank(s, 'royalnail') + Math.max(0, s.ossuarySuccessTickets);
    t[4] = (sickle ? 5 : 2) + 5 * rank(s, 'butterfingers') + 2 * rank(s, 'pin') + rank(s, 'spark') + 4 * rank(s, 'oracledie') + (rank(s, 'grudge') ? Math.max(0, s.grudgeTickets) : 0) + Math.max(0, s.mourningGreatTickets);
    for (let i = 0; i < 5; i++) t[i] += runTickets(s, i);
  }
  // 加上這把劍專屬的籤（籤紙上紫色的部分）
  function fillSwordDeck(s, grade, e, fever, w) {
    fillDeck(s, w);
    if (fever) w[4] += 6 * rank(s, 'perfectcore');
    if (grade >= 8 && rank(s, 'obsidian')) { const n = Math.min(2, w[3]); w[3] -= n; w[4] += n; }
    if (e) {
      w[3] += clamp(e.inheritedSuccess, 0, 4);
      if (rank(s, 'royalseal')) w[4] += clamp(e.damageGreatTickets, 0, 8);
      if (rank(s, 'kingcup')) w[4] += Math.max(0, e.kingTickets);
      if (rank(s, 'gear')) w[3] += Math.max(0, e.bronzeTickets);
      if (e.diceReady && rank(s, 'dice')) w[4] += 3;
      if (e.chalkArmed) w[4] *= 2;
      if (e.hasPreviousOutcome && e.previousOutcome === 'hold' && rank(s, 'thirdeye')) w[3] += 4;
    }
  }
  function applyDeckOverride(e, fever, w) {
    if (fever) w[0] = 0;
    else if (e && e.powderArmed) { w[0] = w[0] + w[1] + w[2]; w[4] = w[3] + w[4]; w[1] = w[2] = w[3] = 0; }
  }
  function danger(cfg, grade) {
    const bc = cfg.breakCurve;
    const p = bc[clamp(grade, 0, bc.length - 1)];
    return p / (1 - p) * 21 / 9;
  }
  // 真正抽籤用的 1000 張籤（原作 ForgeEconomy.Chances）
  function chances(s, w, fever) {
    const grade = w ? w.grade : 0, e = w ? w.effects : null;
    let risk = w ? swordRisk(s, e) : 1.0;
    fever = !!fever || (!!w && e.charge >= 10);
    const a = [0, 0, 0, 0, 0];
    fillSwordDeck(s, grade, e, fever, a);
    if (e) {
      if (e.starReady && rank(s, 'star')) risk *= 0.6;
      if (e.threadReady && rank(s, 'thread')) risk *= 0.8;
    }
    a[0] *= danger(s.cfg, grade);
    const rest = a[1] + a[2] + a[3] + a[4];
    const frac = a[0] / (a[0] + rest) * clamp(risk, 0, 1) * (rank(s, 'seal') ? 0.9 : 1.0) * ((grade >= 6 && rank(s, 'tongs')) ? 0.75 : 1.0);
    a[0] = frac <= 0 ? 0 : rest * frac / Math.max(1e-12, 1 - frac);
    applyDeckOverride(e, fever, a);
    const sum = a.reduce((x, y) => x + y, 0);
    const ticks = [0, 0, 0, 0, 0], f = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) { const v = sum > 0 ? a[i] / sum * 1000 : (i === 2 ? 1000 : 0); ticks[i] = Math.floor(v); f[i] = v - ticks[i]; }
    let left = 1000 - ticks.reduce((x, y) => x + y, 0);
    const order = [0, 1, 2, 3, 4].sort((i, j) => (f[j] - f[i]) || (i - j));
    for (let k = 0; k < left; k++) ticks[order[k % 5]]++;
    return ticks;
  }
  function rollOutcome(ticks, ticket) {
    ticket = clamp(ticket, 0, 999);
    let acc = 0;
    for (let i = 0; i < 5; i++) { acc += ticks[i]; if (ticket < acc) return OUTCOMES[i]; }
    return 'great';
  }
  // 籤紙資料：deck（含這把劍）、common（run 層級）、baseline、seal、grudge。
  function ticketPaper(s, w) {
    const common = [0, 0, 0, 0, 0]; fillDeck(s, common);
    const deck = [0, 0, 0, 0, 0];
    const fever = !!w && (inFever(s, w) || w.effects.charge >= 10);
    if (w) { fillSwordDeck(s, w.grade, w.effects, fever, deck); applyDeckOverride(w.effects, fever, deck); }
    else fillDeck(s, deck);
    return { deck, common, baseline: BASELINE.slice(), seal: rank(s, 'seal') > 0, grudge: rank(s, 'grudge') ? s.grudgeTickets : 0, fever };
  }

  // ---------- 入神 ----------
  // 原作：每鎚間隔 0.64 秒 ÷ 速度；入神 4 秒（長芯 +2、紅漏 +1），期間破壞籤 0。
  // 有時鐘（介面）就用真實時間；沒有（模擬器）就換算成鎚數：觸發那一鎚 + floor(秒數 × 速度 ÷ 0.64)。
  function feverSeconds(s) { return 4 + 2 * rank(s, 'everwick') + 1 * rank(s, 'redglass'); }
  function speedOf(s, fever) { return 1 + 0.15 * rank(s, 'speed') + (fever ? 0.3 * rank(s, 'bellows') : 0.2 * rank(s, 'loop')); }
  function strikeInterval(s, fever) { return STRIKE_SECONDS / speedOf(s, fever); }
  function feverStrikes(s) { return 1 + Math.max(0, Math.floor(feverSeconds(s) * speedOf(s, true) / STRIKE_SECONDS + 1e-9)); }
  function inFever(s, w) {
    if (!w) return false;
    if (s.clock) return w.feverUntil > 0 && s.clock() < w.feverUntil;
    return w.feverLeft > 0;
  }
  function feverRemaining(s, w) {
    if (!w) return 0;
    if (s.clock) return Math.max(0, w.feverUntil - s.clock());
    return w.feverLeft;
  }
  function startFever(s, w) {
    const e = w.effects;
    if (w.broken || e.charge < 10 || inFever(s, w)) return false;
    e.charge = 0;
    if (s.clock) { w.feverUntil = s.clock() + feverSeconds(s); w.feverTotal = feverSeconds(s); w.feverLeft = 0; }
    else { w.feverLeft = feverStrikes(s); w.feverTotal = w.feverLeft; w.feverUntil = 0; }
    e.feverStartGrade = w.grade; e.feverEndBonus = 0; e.bellowsHits = 0; e.feverActivations++;
    s.feverEvents++; s.stats.fevers++;
    return true;
  }
  function finishFever(s, w, procs) {
    const e = w.effects;
    w.feverLeft = 0; w.feverUntil = 0;
    e.bellowsHits = 0; e.feverEndBonus = 0;
    if (!w.broken && rank(s, 'headless')) {
      const g = w.grade;
      addGrade(s, w, 'headless', 1, procs);
      w.value = valueOf(s, w); e.peak = Math.max(e.peak, w.value);
      e.feverEndBonus = w.grade - g;
    }
  }
  // 時鐘模式：時間到了就結束入神（介面每幀呼叫；敲擊前也會呼叫）。回傳 true 表示剛結束。
  function expireFever(s) {
    const w = anvilSword(s);
    if (!w || !s.clock || !(w.feverUntil > 0) || s.clock() < w.feverUntil) return false;
    const procs = [];
    finishFever(s, w, procs);
    procs.push({ item: 'fever', text: '入神結束', before: w.value, after: w.value });
    pushLog(s, { kind: 'fever', outcome: 'fever', serial: w.serial, procs });
    return true;
  }

  // ---------- 劍 ----------
  function newEffects() {
    return {
      successStreak: 0, holdStreak: 0, successes: 0, brace: 0, phoenix: 0, feverActivations: 0, rageHolds: 0, bellowsHits: 0,
      cornerstoneUses: 0, pearlUses: 0, axleSuccesses: 0, temperScars: 0, damageGreatTickets: 0, heldGreatLevels: 0, kingTickets: 0,
      stillHolds: 0, oathDamages: 0, inheritedSuccess: 0, royalLevels: 0, chimeLevels: 0, bronzeTickets: 0, growthBase: 0,
      hasPreviousOutcome: false, threadReady: false, previousOutcome: null, seedBase: 0, wardArmed: false, charge: 0,
      normalHits: 0, normalSuccesses: 0, normalDamageCount: 0, repairBank: 0, lostLevels: 0, damageCount: 0, spineLosses: 0,
      retaliation: 0, holdsTotal: 0, milestones: 0, feverStartGrade: 0, feverEndBonus: 0, starReady: false, diceReady: false,
      spineShield: false, chalkArmed: false, powderArmed: false, primed: false, baseBonus: 0, valueScale: 1.0,
      multiplier: 1.0, greatMultiplier: 1.0, risk: 1.0, peak: 320, flat: 0,
    };
  }
  function newSword(s, grade) {
    const w = { serial: ++s.swordSerial, grade: grade || 0, value: 320, strikes: 0, broken: false, lastOutcome: null, resultStreak: 0, feverLeft: 0, feverTotal: 0, effects: newEffects(), procs: [] };
    refreshValue(s, w);
    return w;
  }
  // 原作 PrimeSword：第一鎚前套用繼承。
  function primeSword(s, w, procs) {
    const e = w.effects;
    const g0 = w.grade, c0 = e.charge;
    if (!e.primed && w.strikes === 0 && w.grade === 0) {
      e.primed = true;
      if (s.inheritGrade > 0 && (rank(s, 'holy') || rank(s, 'dawnsheath'))) { w.grade = Math.min(gradeCap(s.cfg), s.inheritGrade); s.inheritGrade = 0; }
      if (s.inheritanceChargeGrant > 0 && (rank(s, 'holy') || rank(s, 'dawnsheath'))) { e.charge = Math.max(e.charge, Math.min(10, s.inheritanceChargeGrant)); s.inheritanceChargeGrant = 0; }
      if (s.inheritFlat > 0 && rank(s, 'tooth')) { e.flat += s.inheritFlat; s.inheritFlat = 0; }
      if (s.inheritSuccess > 0 && rank(s, 'tooth')) { e.inheritedSuccess = clamp(s.inheritSuccess, 0, 4); s.inheritSuccess = 0; }
    }
    refreshValue(s, w);
    const dg = w.grade - g0, dc = e.charge - c0;
    if (dg > 0 || dc > 0) procs.push({ item: rank(s, 'holy') ? 'holy' : 'dawnsheath', text: '繼承' + (dg > 0 ? ' +' + dg : '') + (dc > 0 ? ' 充能 +' + dc : ''), before: w.value, after: w.value });
  }

  // ---------- 觸發（原作 Proc / AddGrade / Flat / Multiply / BaseGrowth） ----------
  function proc(s, w, id, text, before, procs) { procs.push({ item: id, text, before, after: valueOf(s, w) }); }
  function stateProc(s, w, id, text, procs) { const v = valueOf(s, w); procs.push({ item: id, text, before: v, after: v }); }
  function addGrade(s, w, id, count, procs) {
    const before = valueOf(s, w), g = w.grade;
    w.grade = Math.min(gradeCap(s.cfg), w.grade + Math.max(0, count));
    if (w.grade > g) proc(s, w, id, '+' + (w.grade - g), before, procs);
  }
  function flat(s, w, id, amount, procs) {
    const e = w.effects, before = valueOf(s, w);
    e.flat += amount / (e.multiplier * e.greatMultiplier * e.valueScale);
    proc(s, w, id, '+' + money(amount) + ' G', before, procs);
  }
  function multiply(s, w, id, scale, procs) {
    const before = valueOf(s, w);
    w.effects.multiplier *= scale;
    proc(s, w, id, '×' + (Math.round(scale * 1000) / 1000), before, procs);
  }
  function baseGrowth(s, w, id, amount, procs) {
    const before = valueOf(s, w);
    w.effects.growthBase += amount;
    proc(s, w, id, '+' + money(amount) + ' G', before, procs);
  }
  function isValueProc(p) {
    if (!p.item || !(p.after > p.before) || p.text.startsWith('+')) {
      if (p.item && p.after > p.before) return p.text.endsWith(' G');
      return false;
    }
    return true;
  }
  function money(v) { return Math.round(v).toLocaleString('en-US'); }

  // ---------- 一鎚的結算（原作 ForgeEconomy.Apply 逐行移植） ----------
  function apply(s, w, raw, inFever, procs) {
    if (w.broken) return;
    primeSword(s, w, procs);
    const e = w.effects, cfg = s.cfg, random = s.rng;
    const value = w.value, grade = w.grade;
    const hasPrev = e.hasPreviousOutcome, prev = e.previousOutcome;
    const wardArmed = e.wardArmed;
    e.wardArmed = false; e.starReady = false; e.threadReady = false; e.diceReady = false; e.chalkArmed = false;
    if (!inFever) {
      e.powderArmed = false;
      e.normalHits++;
      e.charge = Math.min(10, e.charge + 1 + (w.strikes === 0 ? 2 * rank(s, 'locket') : 0));
    }
    w.strikes++;
    let outcome = raw, spineFlag = false;
    if (raw === 'break') {
      e.successStreak = e.holdStreak = 0;
      if (wardArmed) { proc(s, w, 'ward', '鱗片擋下破壞', value, procs); return; }
      if (rank(s, 'cornerstone') && e.cornerstoneUses === 0) { e.cornerstoneUses++; outcome = 'damage'; proc(s, w, 'cornerstone', '破壞改為損傷', value, procs); }
      else if (rank(s, 'insurance') && !s.insured) { s.insured = true; outcome = 'damage'; proc(s, w, 'insurance', '破壞改為損傷', value, procs); }
      else if (rank(s, 'spine') && e.spineShield) { e.spineShield = false; outcome = 'damage'; spineFlag = true; proc(s, w, 'spine', '破壞改為損傷', value, procs); }
      else if (rank(s, 'phoenix') && e.phoenix === 0) { e.phoenix = 1; multiply(s, w, 'phoenix', 0.6, procs); w.value = valueOf(s, w); return; }
      else {
        s.brokenSwords++; s.stats.breaks++;
        if (w.grade >= 7 && rank(s, 'funeralledger') && s.funeralClaims < 2) { s.funeralClaims++; s.funeralPending++; procs.push({ item: 'funeralledger', text: '下回合多發 1 把', before: value, after: value }); }
        if (w.grade > 0) {
          if (rank(s, 'grudge')) s.grudgeTickets = inc(s.grudgeTickets, w.grade);
          const n = Math.floor(w.grade * (30 * rank(s, 'holy') + 40 * rank(s, 'dawnsheath')) / 100);
          s.inheritGrade = Math.max(s.inheritGrade, n);
          if (n > 0) s.inheritanceChargeGrant = Math.max(s.inheritanceChargeGrant, 3 * rank(s, 'holy') + 4 * rank(s, 'dawnsheath'));
          if (w.grade >= 4 && rank(s, 'tooth')) s.inheritSuccess = 4;
        }
        if (w.grade >= 7 && rank(s, 'ossuary') && hasPrev && prev) {
          const i = OUT_INDEX[prev]; s.ossuaryTickets[i] = inc(s.ossuaryTickets[i]);
          procs.push({ item: 'ossuary', text: '本局「' + LABEL[prev] + '」籤 +1', before: value, after: value });
        }
        if (rank(s, 'sieve')) { s.wallet += 500; s.goldEarned += 500; s.breakGoldEarned += 500; procs.push({ item: 'sieve', text: '+500 G', before: value, after: value }); }
        e.charge = 0; w.feverLeft = 0;
        e.rageHolds = e.retaliation = e.heldGreatLevels = e.damageGreatTickets = e.royalLevels = e.chimeLevels = e.kingTickets = e.bronzeTickets = 0;
        w.broken = true; w.lastOutcome = raw; w.resultStreak = 0;
        w.value = round0(e.peak * 0.3 * rank(s, 'shard'));
        if (rank(s, 'grudge') && w.grade > 0) procs.push({ item: 'grudge', text: '怨籤 +' + w.grade, before: value, after: value });
        if (w.value > 0) procs.push({ item: 'shard', text: '廢鐵 +' + money(w.value) + ' G', before: 0, after: w.value });
        return;
      }
    }
    w.resultStreak = (!hasPrev || prev !== outcome) ? 1 : w.resultStreak + 1;
    w.lastOutcome = outcome; e.hasPreviousOutcome = true; e.previousOutcome = outcome;
    const isSuccess = outcome === 'success' || outcome === 'great';
    e.successStreak = isSuccess ? e.successStreak + 1 : 0;
    e.holdStreak = outcome === 'hold' ? e.holdStreak + 1 : 0;
    if (isSuccess) { e.successes++; if (!inFever) e.normalSuccesses++; }
    let delta = outcome === 'great' ? 2 : outcome === 'success' ? 1 : outcome === 'damage' ? -1 : 0;
    const pearl = outcome === 'damage' && rank(s, 'deeppearl') && e.pearlUses < 2;
    if (pearl) { e.pearlUses++; delta = 0; proc(s, w, 'deeppearl', '損傷不掉級', value, procs); }
    const basisBefore = basis(s, w, w.grade) + e.flat;
    w.grade = clamp(w.grade + delta, 0, gradeCap(cfg));
    if (outcome === 'great') {
      e.greatMultiplier *= cfg.greatMultiplier * basisBefore / (basis(s, w, w.grade) + e.flat);
      s.greatEvents++; s.grudgeTickets = 0; e.damageGreatTickets = 0;
    }
    procs.push({ item: '', text: LABEL[raw], before: value, after: valueOf(s, w) });
    if (outcome === 'damage') {
      const lost = grade - w.grade, lostForCrown = pearl ? Math.min(1, grade) : lost;
      e.lostLevels += lost; e.damageCount++; s.damageEvents++;
      if (rank(s, 'repair') && e.temperScars < 4) { e.temperScars++; procs.push({ item: 'repair', text: '破壞率 −' + 15 * e.temperScars + '%', before: value, after: value }); }
      if (rank(s, 'crown')) { const b = valueOf(s, w); e.flat += (basis(s, w, grade) - basis(s, w, grade - lostForCrown)) * 0.5; proc(s, w, 'crown', '保留傷痕', b, procs); }
      if (rank(s, 'ironcomb')) { const b = valueOf(s, w); e.flat += basis(s, w, grade) * 0.05; proc(s, w, 'ironcomb', '保留傷痕', b, procs); }
      if (rank(s, 'spine') && !spineFlag) { e.spineLosses++; if (e.spineLosses >= 2) { e.spineLosses %= 2; e.spineShield = true; } }
      if (rank(s, 'royalseal')) { e.royalLevels = inc(e.royalLevels); procs.push({ item: 'royalseal', text: '儲存 +' + e.royalLevels, before: value, after: value }); }
      if (rank(s, 'apron')) flat(s, w, 'apron', 140, procs);
      if (rank(s, 'oath') && random() < 0.7) addGrade(s, w, 'oath', 1, procs);
      if (!inFever) { e.normalDamageCount++; if (rank(s, 'watch')) e.charge = Math.min(10, e.charge + 1); }
    }
    if (outcome === 'hold') {
      if (rank(s, 'eternalseed')) { const b = valueOf(s, w); e.seedBase += 40; proc(s, w, 'eternalseed', '+40 G', b, procs); }
      e.holdsTotal++; s.holdEvents++;
      if (rank(s, 'rage') && e.heldGreatLevels < 4) { e.heldGreatLevels++; procs.push({ item: 'rage', text: '儲存 +' + e.heldGreatLevels, before: value, after: value }); }
      if (rank(s, 'hold') && e.holdStreak % 2 === 0) addGrade(s, w, 'hold', 1, procs);
      if (rank(s, 'still') && random() < 0.7) addGrade(s, w, 'still', 1, procs);
      if (rank(s, 'mold')) flat(s, w, 'mold', 180, procs);
      if (rank(s, 'cup')) multiply(s, w, 'cup', 1.06, procs);
      if (rank(s, 'kingcup')) { const k = e.kingTickets; e.kingTickets = inc(e.kingTickets); if (e.kingTickets > k) stateProc(s, w, 'kingcup', '大成功籤 +1，累計 ' + e.kingTickets, procs); }
      if (rank(s, 'chime') && e.chimeLevels < 2) { e.chimeLevels++; procs.push({ item: 'chime', text: '儲存 +' + e.chimeLevels, before: value, after: value }); }
      e.threadReady = rank(s, 'thread') > 0;
      if (!inFever && rank(s, 'hourglass') && random() < 0.5) e.charge = Math.min(10, e.charge + 1);
    }
    if (isSuccess) {
      if (outcome === 'success' && rank(s, 'endlessaxle') && ++e.axleSuccesses % 2 === 0) addGrade(s, w, 'endlessaxle', 1, procs);
      if (grade >= 7 && rank(s, 'dragonheart')) multiply(s, w, 'dragonheart', 1.15, procs);
      if (rank(s, 'rage') && e.rageHolds >= 2) { addGrade(s, w, 'rage', Math.floor(e.rageHolds / 2), procs); e.rageHolds %= 2; }
      if (rank(s, 'repair') && e.repairBank > 0) { addGrade(s, w, 'repair', e.repairBank, procs); e.lostLevels = Math.max(0, e.lostLevels - e.repairBank); e.repairBank = 0; }
      if (rank(s, 'royalseal') && e.retaliation > 0) { addGrade(s, w, 'royalseal', e.retaliation, procs); e.retaliation = 0; }
      if (rank(s, 'glove') && e.successStreak % 2 === 0) addGrade(s, w, 'glove', 1, procs);
      if (rank(s, 'echo') && random() < 0.25) addGrade(s, w, 'echo', 1, procs);
      if (rank(s, 'coin')) flat(s, w, 'coin', 100, procs);
      if (rank(s, 'firstseal') && w.strikes === 1) addGrade(s, w, 'firstseal', 2, procs);
      if (outcome === 'success') {
        if (rank(s, 'gear')) { e.bronzeTickets = inc(e.bronzeTickets); procs.push({ item: 'gear', text: '這把劍成功籤 +1', before: value, after: value }); }
        if (rank(s, 'goldgear')) baseGrowth(s, w, 'goldgear', 30, procs);
        if (rank(s, 'chime') && e.chimeLevels > 0) { addGrade(s, w, 'chime', e.chimeLevels, procs); e.chimeLevels = 0; }
      }
      if (hasPrev && prev === 'damage' && rank(s, 'scales')) addGrade(s, w, 'scales', 2, procs);
      if (rank(s, 'knot') && e.successStreak % 2 === 0) multiply(s, w, 'knot', 1.1, procs);
      if (!inFever && rank(s, 'brace') && e.brace < 6) { e.brace++; stateProc(s, w, 'brace', '破壞率降低 ' + e.brace + '/6', procs); }
    }
    if (outcome === 'great') {
      if (rank(s, 'rage') && e.heldGreatLevels > 0) { addGrade(s, w, 'rage', e.heldGreatLevels, procs); e.heldGreatLevels = 0; }
      if (rank(s, 'royalseal') && e.royalLevels > 0) { addGrade(s, w, 'royalseal', e.royalLevels, procs); e.royalLevels = 0; }
      if (inFever && rank(s, 'glass')) addGrade(s, w, 'glass', 1, procs);
      if (rank(s, 'bell')) multiply(s, w, 'bell', 1.2, procs);
      if (!inFever && rank(s, 'fork')) addGrade(s, w, 'fork', 1, procs);
      e.starReady = !inFever && rank(s, 'star') > 0;
    }
    e.diceReady = (outcome === 'damage' || outcome === 'hold') && rank(s, 'dice') > 0;
    if (e.diceReady) stateProc(s, w, 'dice', '下一鎚大成功籤 +3', procs);
    if (hasPrev && prev !== outcome && rank(s, 'incense')) baseGrowth(s, w, 'incense', 20, procs);
    if (w.resultStreak % 2 === 0 && rank(s, 'wax')) flat(s, w, 'wax', 150, procs);
    if (inFever && rank(s, 'collar')) multiply(s, w, 'collar', 1.05, procs);
    for (let i = 0; i < Math.floor(gradeCap(cfg) / 4); i++) {
      if (w.grade >= 4 * (i + 1) && (e.milestones & (1 << i)) === 0) {
        e.milestones |= 1 << i;
        if (rank(s, 'idol')) multiply(s, w, 'idol', 1.15, procs);
      }
    }
    const valueProcs = procs.filter(isValueProc);
    if (w.resultStreak % 2 === 0 && rank(s, 'mirror') && valueProcs.length > 0) { const p = valueProcs[valueProcs.length - 1]; flat(s, w, 'mirror', p.after - p.before, procs); }
    refreshValue(s, w);
  }

  // ---------- 一局 ----------
  // 劍是實體：沒上貢、沒碎的劍會帶到下一回合（原作 PrepareRound preserveStored）。
  // 放進貢品窗的劍在搖鈴前可以拿回來。鐵砧上一次一把，自己選哪一把。
  function newRun(cfg, opts) {
    opts = opts || {};
    const s = {
      cfg, rng: opts.seed == null ? Math.random : mulberry32(opts.seed),
      clock: opts.clock || null,
      phase: 'round', round: 1, misses: 0, totalMisses: 0, cleared: false, endless: false, ended: false, endReason: null, won: false,
      wallet: 0, credits: 0, goldEarned: 0, breakGoldEarned: 0,
      relics: [], offers: [], starterPending: false, shopping: false, rerolls: 0, paidRerolls: 0, freeRerollUsedRound: 0, hookUsed: false,
      merchant: null, consumables: { ward: 0, rewind: 0, chalk: 0, powder: 0, starshard: 0 },
      deliveryBonus: 0, supplyBonus: 0, supplyGrade: 0, nextSupplyGrade: 0, supplyAllGrade: 0, successfulTributes: 0, previousTributeSucceeded: true,
      funeralClaims: 0, funeralPending: 0, funeralSupplied: 0, tributeCredit: 0, nextTributeCredit: 0, insured: false, pardonTriggered: false,
      taxSuccesses: 0, oblivionBought: 0, oblivionUsed: 0, brokenSwords: 0, damageEvents: 0, holdEvents: 0, greatEvents: 0, feverEvents: 0,
      inheritGrade: 0, inheritanceChargeGrant: 0, inheritFlat: 0, inheritSuccess: 0,
      grudgeTickets: 0, mourningGreatTickets: 0, ossuaryTickets: [0, 0, 0, 0, 0], ossuarySuccessTickets: 0,
      roundOfferedGrade: 0, highestOfferedGrade: 0,
      swords: [], offered: [], anvil: null, ordersLeft: 0, delivered: 0, swordSerial: 0, undo: null, lastSettle: null,
      bestGrade: 0, totalTribute: 0, roundsCleared: 0, score: 0, history: [], route: [], log: [],
      stats: { strikes: 0, breaks: 0, fevers: 0, delivered: 0, deposits: 0, saves: 0, rerolls: 0, swordsBought: 0, consumablesUsed: 0, rewinds: 0, takebacks: 0 },
    };
    Object.defineProperty(s, 'weapon', { get() { return anvilSword(s); }, enumerable: false });
    beginRound(s);
    return s;
  }
  function pushLog(s, e) { s.log.unshift(e); if (s.log.length > 40) s.log.pop(); }
  function finishRun(s, reason) { if (s.ended) return s; s.ended = true; s.endReason = reason; s.phase = 'ended'; s.score = s.roundsCleared; return s; }
  function inRound(s) { return s.phase === 'round' && !s.ended; }

  function swordSupply(s) { return 3 + rank(s, 'supply') + s.supplyBonus; }
  function findSword(s, serial) { return s.swords.find(w => w.serial === serial) || null; }
  function anvilSword(s) { return s.anvil == null ? null : findSword(s, s.anvil); }
  function rackSwords(s) { return s.swords.filter(w => w.serial !== s.anvil); }
  function pendingSwords(s) { return rackSwords(s).length; }
  function bestRackSword(s) { return rackSwords(s).slice().sort((a, b) => b.grade - a.grade || b.value - a.value)[0] || null; }

  function beginRound(s) {
    s.rerolls = s.paidRerolls = 0; s.hookUsed = false;
    s.supplyBonus = s.deliveryBonus; s.deliveryBonus = 0;
    s.funeralSupplied = s.funeralPending; s.supplyBonus += s.funeralSupplied; s.funeralPending = 0; s.funeralClaims = 0;
    s.tributeCredit = s.nextTributeCredit; s.nextTributeCredit = 0; s.pardonTriggered = false;
    s.supplyAllGrade = (s.round > 1 && s.previousTributeSucceeded && rank(s, 'badge')) ? 2 : 0;
    if (rank(s, 'lifecontract')) s.supplyAllGrade = Math.max(s.supplyAllGrade, 7);
    s.supplyGrade = Math.max(s.supplyAllGrade, s.nextSupplyGrade); s.nextSupplyGrade = 0;
    s.roundOfferedGrade = 0; s.insured = false;
    s.offers = []; s.starterPending = false;
    s.shopping = s.round >= 2;
    if (s.round === 1) openStarterRelics(s); else generateOffers(s);
    prepareMerchantStock(s);
    s.ordersLeft = swordSupply(s); s.delivered = 0; s.offered = []; s.undo = null;
    for (const w of s.swords) refreshValue(s, w);
    const supply = swordSupply(s);
    for (let i = 0; i < supply; i++) {
      const w = newSword(s, i === 0 ? s.supplyGrade : s.supplyAllGrade);
      w.place = 'rack'; w.heated = false; w.issuedRound = s.round;
      s.swords.push(w);
      s.bestGrade = Math.max(s.bestGrade, w.grade);
    }
    s.phase = 'round';
  }

  // ---------- 遺物商店 ----------
  function openStarterRelics(s) {
    const pool = s.cfg.starterPool.slice();
    s.offers = [];
    for (let i = 0; i < 3 && pool.length; i++) { const k = Math.min(pool.length - 1, Math.floor(s.rng() * pool.length)); s.offers.push({ id: pool[k], price: 0, sold: false }); pool.splice(k, 1); }
    s.starterPending = true; s.shopping = true;
  }
  function offerWeight(id, round) {
    if (round >= 2 && round <= 6 && ['seal', 'rivet', 'shard', 'holy', 'repair', 'insurance'].includes(id)) return 1.75;
    if (round >= 8 && ['coin', 'mold', 'apron', 'wax', 'firstseal', 'coal', 'token'].includes(id)) return 0.45;
    return 1.0;
  }
  function generateOffers(s) {
    const round = s.round;
    const pool = s.cfg.items.filter(i => !i.consumable && !i.excluded && i.min <= round && !s.relics.includes(i.id));
    s.offers = [];
    for (let n = 0; n < 3 && pool.length; n++) {
      const r1 = s.rng();
      const p1 = round < 4 ? 0.15 : round < 7 ? 0.25 : round < 13 ? 0.35 : 0.42;
      const p2 = round < 6 ? 0 : round < 9 ? 0.05 : round < 13 ? 0.12 : round < 17 ? 0.22 : 0.3;
      const rarity = r1 < p2 ? 2 : r1 < p2 + p1 ? 1 : 0;
      let list = pool.filter(i => i.rarity === rarity);
      if (!list.length) { const mn = Math.min(...pool.map(p => p.rarity)); list = pool.filter(i => i.rarity === mn); }
      let acc = s.rng() * list.reduce((a, x) => a + offerWeight(x.id, round), 0);
      let pick = list[list.length - 1];
      for (const it of list) { acc -= offerWeight(it.id, round); if (acc < 0) { pick = it; break; } }
      s.offers.push({ id: pick.id, price: pick.price, sold: false });
      pool.splice(pool.indexOf(pick), 1);
    }
  }
  function freeRerollAvailable(s) { return rank(s, 'voucher') > 0 && s.freeRerollUsedRound !== s.round; }
  function rerollPrice(s) { return freeRerollAvailable(s) ? 0 : Math.ceil(Math.max(150, baseQuota(s.cfg, s.round) * 0.15) * Math.pow(2.5, s.paidRerolls)); }
  function shopOpen(s) { return inRound(s) && s.shopping && !s.starterPending; }
  function reroll(s) {
    if (s.starterPending) return { ok: false, reason: 'starter' };
    if (!shopOpen(s)) return { ok: false, reason: 'closed' };
    const price = rerollPrice(s);
    if (s.wallet < price) return { ok: false, reason: 'gold' };
    if (freeRerollAvailable(s)) s.freeRerollUsedRound = s.round; else s.paidRerolls++;
    s.wallet -= price; s.rerolls++; s.stats.rerolls++; s.undo = null;
    generateOffers(s);
    return { ok: true, price };
  }
  function buyRelic(s, index, replaceId) {
    if (!inRound(s) || !s.shopping) return { ok: false, reason: 'closed' };
    const o = s.offers[index];
    if (!o || o.sold) return { ok: false, reason: 'no offer' };
    if (s.relics.includes(o.id)) return { ok: false, reason: 'owned' };
    if (s.credits < o.price) return { ok: false, reason: 'credits' };
    let replaced = null;
    if (s.relics.length >= s.cfg.relicSlots) {
      if (!replaceId || !s.relics.includes(replaceId)) return { ok: false, needReplace: true };
      removeRelic(s, replaceId); replaced = replaceId;
    }
    s.relics.push(o.id); s.credits -= o.price; o.sold = true; s.undo = null;
    for (const x of s.offers) if (x.id === o.id) x.sold = true;
    const starter = s.starterPending;
    if (starter) { s.starterPending = false; s.shopping = false; for (const x of s.offers) x.sold = true; }
    clearUnownedRelicProgress(s);
    s.route.push({ round: s.round, at: starter ? 'start' : 'shop', picked: o.id, replaced, price: o.price });
    for (const w of s.swords) refreshValue(s, w);
    return { ok: true, picked: o.id, replaced };
  }
  function skipStarter(s) { if (!s.starterPending) return false; s.starterPending = false; s.shopping = false; for (const x of s.offers) x.sold = true; s.route.push({ round: 1, at: 'start', picked: null, replaced: null, price: 0 }); return true; }
  function removeRelic(s, id) {
    if (s.ended || !s.relics.includes(id)) return false;
    s.relics.splice(s.relics.indexOf(id), 1);
    clearUnownedRelicProgress(s);
    for (const w of s.swords) refreshValue(s, w);
    return true;
  }
  function clearUnownedRelicProgress(s) {
    if (!rank(s, 'grudge')) s.grudgeTickets = 0;
    if (!rank(s, 'holy') && !rank(s, 'dawnsheath')) { s.inheritGrade = 0; s.inheritanceChargeGrant = 0; }
    if (!rank(s, 'tooth')) { s.inheritFlat = 0; s.inheritSuccess = 0; }
    if (!rank(s, 'collector')) s.taxSuccesses = 0;
  }
  // 販賣機：任何一把劍投進去換劍幣（討債鉤：重抽後第一把沒敲過的 +0 劍給 2 枚）。
  function depositCredit(s, w) {
    let n = 1;
    if (rank(s, 'hook') && s.rerolls > 0 && !s.hookUsed && w.grade === 0 && w.strikes === 0) { n = 2; s.hookUsed = true; }
    s.credits += n; return n;
  }
  function depositSword(s, serial) {
    if (!inRound(s)) return null;
    const w = serial == null ? anvilSword(s) : findSword(s, serial);
    if (!w || w.broken) return null;
    const n = depositCredit(s, w);
    s.swords.splice(s.swords.indexOf(w), 1);
    if (s.anvil === w.serial) s.anvil = null;
    s.ordersLeft = Math.max(0, s.ordersLeft - 1); s.stats.deposits++; s.undo = null;
    pushLog(s, { kind: 'deposit', outcome: 'deposit', before: w.grade, credits: n, serial: w.serial, procs: [] });
    return { credits: n };
  }
  function depositCurrent(s) { return depositSword(s, null); }

  // ---------- 商人（3 的倍數回合） ----------
  function isMerchantRound(r) { return r >= 3 && r % 3 === 0; }
  function basicSwordStock(visit) { return visit > 7 ? 5 : visit > 3 ? 4 : visit > 1 ? 3 : 2; }
  function strongConsumable(id) { return id === 'rewind' || id === 'powder' || id === 'oblivion'; }
  function merchantOffer(s, id, fraction, minimum, multiplier) {
    const price = Math.ceil(Math.max(minimum, baseQuota(s.cfg, s.round) * fraction) * (multiplier || 1) / 10) * 10;
    return { id, price, firstPrice: price, stock: 1, purchases: 0, sold: false, quantity: 1 };
  }
  function prepareMerchantStock(s) {
    if (!isMerchantRound(s.round)) { s.merchant = null; return; }
    const n = (s.round < 6 ? 4 : s.round < 15 ? 5 : 6) + 2 * rank(s, 'ghostledger');
    const offers = [];
    const sword = merchantOffer(s, 'sword', 0.4, 700); sword.stock = basicSwordStock(Math.floor(s.round / 3)) + 2 * rank(s, 'silverpermit'); offers.push(sword);
    s.rng(); // 原作第二格是特殊劍，本版不做；吃掉同一個亂數保持對齊
    let list = s.cfg.items.filter(x => x.consumable && x.min <= s.round && (x.id !== 'oblivion' || (s.oblivionBought === 0 && s.oblivionUsed === 0 && s.misses > 0)));
    for (let k = 2; k < n; k++) {
      let def;
      if (s.round === 3 && k < 4) def = item(s.cfg, k === 2 ? 'ward' : 'rewind');
      else {
        if (!list.length) { const extra = merchantOffer(s, 'sword', 0.4, 700); offers.push(extra); continue; }
        let list2 = list.filter(x => x.rarity < 2 || s.rng() < 0.22);
        if (!list2.length) list2 = list;
        if (k === 2) { const l3 = list2.filter(x => x.id === 'ward' || x.id === 'rewind'); if (l3.length) list2 = l3; }
        def = list2[Math.min(list2.length - 1, Math.floor(s.rng() * list2.length))];
      }
      const strong = strongConsumable(def.id);
      const o = merchantOffer(s, def.id, def.goldFraction, def.goldMinimum, strong ? 1.8 : 1.4);
      o.stock = strong ? 1 : 3; o.quantity = def.quantity || 1;
      offers.push(o);
      list = list.filter(x => x.id !== def.id);
    }
    s.merchant = { round: s.round, offers };
  }
  function merchantRemaining(o) { return o.sold ? 0 : Math.max(0, Math.max(1, o.stock) - o.purchases); }
  function buyMerchant(s, index) {
    if (!inRound(s) || !s.merchant) return { ok: false, reason: 'closed' };
    const o = s.merchant.offers[index];
    if (!o || merchantRemaining(o) <= 0) return { ok: false, reason: 'sold out' };
    if (o.id === 'oblivion' && (s.oblivionBought > 0 || s.oblivionUsed > 0 || s.misses <= 0 || s.misses >= 3)) return { ok: false, reason: 'unavailable' };
    if (s.wallet < o.price) return { ok: false, reason: 'gold' };
    const price = o.price;
    s.wallet -= price; o.purchases++; o.sold = o.purchases >= Math.max(1, o.stock); s.undo = null;
    if (!o.sold) o.price = Math.ceil(o.firstPrice * Math.pow(3, o.purchases) / 10) * 10;
    if (o.id === 'sword') {
      const w = newSword(s, 0); w.place = 'rack'; w.heated = false; w.issuedRound = s.round; s.swords.push(w);
      s.stats.swordsBought++;
    }
    else if (o.id === 'delivery') s.deliveryBonus += 2 * o.quantity;
    else if (o.id === 'oblivion') { s.misses--; s.oblivionBought++; s.oblivionUsed++; }
    else s.consumables[o.id] = (s.consumables[o.id] || 0) + o.quantity;
    return { ok: true, price, id: o.id };
  }

  // ---------- 消耗品 ----------
  function useConsumable(s, id) {
    if (!inRound(s)) return { ok: false, reason: 'closed' };
    if (id === 'rewind') return rewind(s);
    if (!s.consumables[id]) return { ok: false, reason: 'none' };
    const w = anvilSword(s);
    if (!w || w.broken) return { ok: false, reason: 'need sword' };
    if (w.grade >= gradeCap(s.cfg)) return { ok: false, reason: 'cap' };
    const e = w.effects, fever = inFever(s, w);
    if (id === 'ward') { if (fever || e.charge >= 10 || e.wardArmed) return { ok: false, reason: 'unavailable' }; e.wardArmed = true; }
    else if (id === 'chalk') { if (e.chalkArmed) return { ok: false, reason: 'already' }; e.chalkArmed = true; }
    else {
      if (fever || e.charge >= 10) return { ok: false, reason: 'normal only' };
      if (id === 'powder') { if (e.powderArmed) return { ok: false, reason: 'already' }; e.powderArmed = true; }
      else if (id === 'starshard') e.charge = Math.min(10, e.charge + 3);
      else return { ok: false, reason: 'unknown' };
    }
    s.consumables[id]--; s.stats.consumablesUsed++; s.undo = null;
    pushLog(s, { kind: 'use', outcome: 'use', id, serial: w.serial, procs: [] });
    return { ok: true };
  }

  // ---------- 回溯（原作 rewind：只能撤銷上一鎚，離開鐵砧或買東西就失效；不還原亂數） ----------
  const SHARED_KEYS = ['insured', 'grudgeTickets', 'ossuaryTickets', 'inheritGrade', 'inheritanceChargeGrant', 'inheritFlat', 'inheritSuccess', 'brokenSwords', 'funeralClaims', 'funeralPending', 'wallet', 'goldEarned', 'breakGoldEarned', 'damageEvents', 'holdEvents', 'greatEvents', 'feverEvents', 'delivered', 'ordersLeft', 'bestGrade', 'anvil'];
  function snapshot(s) {
    const shared = {}; for (const k of SHARED_KEYS) shared[k] = JSON.parse(JSON.stringify(s[k]));
    return { serial: s.anvil, swords: JSON.parse(JSON.stringify(s.swords)), offered: JSON.parse(JSON.stringify(s.offered)), shared, stats: JSON.parse(JSON.stringify(s.stats)) };
  }
  function canRewind(s) {
    return inRound(s) && s.consumables.rewind > 0 && !!s.undo && (s.anvil == null || s.anvil === s.undo.serial) && s.wallet >= Math.max(0, s.breakGoldEarned - s.undo.shared.breakGoldEarned);
  }
  function rewind(s) {
    if (!canRewind(s)) return { ok: false, reason: 'cannot' };
    const u = s.undo; s.undo = null;
    for (const k of SHARED_KEYS) s[k] = u.shared[k];
    s.swords = u.swords; s.offered = u.offered; s.stats = u.stats;
    s.consumables.rewind--; s.stats.rewinds++;
    pushLog(s, { kind: 'rewind', outcome: 'rewind', serial: u.serial, procs: [] });
    return { ok: true };
  }

  // ---------- 劍的移動 ----------
  function putOnAnvil(s, serial) {
    if (!inRound(s)) return false;
    const w = findSword(s, serial);
    if (!w || w.broken) return false;
    if (s.anvil === serial) return true;
    const prev = anvilSword(s);
    if (prev) prev.place = 'rack';
    w.place = 'anvil'; w.heated = true; s.anvil = serial; s.undo = null;
    return true;
  }
  function rackAnvil(s) {
    const w = anvilSword(s);
    if (!w) return false;
    w.place = 'rack'; s.anvil = null; s.undo = null;
    return true;
  }
  // 給模擬器 AI 用：鐵砧空著時拿架上最高的一把。介面不用這個，玩家自己選。
  function takeSword(s) { if (anvilSword(s)) return false; const b = bestRackSword(s); return b ? putOnAnvil(s, b.serial) : false; }

  // ---------- 鍛造 ----------
  function strike(s) {
    if (!inRound(s) || s.starterPending) return null;
    const w = anvilSword(s);
    if (!w || w.broken) return null;
    if (w.grade >= gradeCap(s.cfg)) return null;
    expireFever(s);
    s.undo = snapshot(s);
    const procs = [];
    if (!inFever(s, w) && startFever(s, w)) procs.push({ item: 'fever', text: s.clock ? '入神！' + feverSeconds(s) + ' 秒內不會破壞，快敲' : '入神！接下來 ' + w.feverLeft + ' 鎚不會破壞', before: w.value, after: w.value });
    const fever = inFever(s, w);
    const ticks = chances(s, w, fever);
    const raw = rollOutcome(ticks, Math.floor(s.rng() * 1000));
    const before = w.grade, valueBefore = w.value;
    s.stats.strikes++;
    apply(s, w, raw, fever, procs);
    let shown = raw;
    if (raw === 'break' && !w.broken) shown = 'saved';
    if (!w.broken) s.bestGrade = Math.max(s.bestGrade, w.grade);
    if (w.broken) {
      s.swords.splice(s.swords.indexOf(w), 1); s.anvil = null;
      s.ordersLeft = Math.max(0, s.ordersLeft - 1);
      if (w.value > 0) { s.delivered += w.value; s.offered.push({ serial: w.serial, grade: before, value: w.value, scrap: true }); }
    } else if (fever && !s.clock) {
      w.feverLeft--;
      if (w.feverLeft === 0) { finishFever(s, w, procs); procs.push({ item: 'fever', text: '入神結束', before: w.value, after: w.value }); }
    }
    const result = { kind: 'strike', raw, outcome: shown, before, after: w.broken ? null : w.grade, valueBefore, valueAfter: w.value, broke: w.broken, inFever: fever, procs: procs.filter(p => p.item !== ''), ticks, serial: w.serial };
    pushLog(s, result);
    return result;
  }

  // 上貢：把劍放進貢品窗（搖鈴前可以拿回來）。
  function deliver(s, serial) {
    if (!inRound(s)) return null;
    const w = serial == null ? anvilSword(s) : findSword(s, serial);
    if (!w || w.broken) return null;
    s.swords.splice(s.swords.indexOf(w), 1);
    if (s.anvil === w.serial) s.anvil = null;
    w.place = 'tribute';
    s.offered.push(w);
    s.delivered += w.value; s.ordersLeft = Math.max(0, s.ordersLeft - 1); s.stats.delivered++; s.undo = null;
    s.roundOfferedGrade = Math.max(s.roundOfferedGrade, w.grade); s.highestOfferedGrade = Math.max(s.highestOfferedGrade, w.grade);
    pushLog(s, { kind: 'deliver', outcome: 'deliver', before: w.grade, value: w.value, serial: w.serial, procs: [] });
    return { grade: w.grade, value: w.value };
  }
  function takeBack(s, serial) {
    if (!inRound(s)) return null;
    const w = s.offered.find(x => x.serial === serial && !x.scrap);
    if (!w) return null;
    s.offered.splice(s.offered.indexOf(w), 1);
    s.delivered = Math.max(0, s.delivered - w.value); s.ordersLeft++; s.stats.takebacks++; s.undo = null;
    w.place = 'rack'; s.swords.push(w);
    s.roundOfferedGrade = s.offered.reduce((m, x) => x.scrap ? m : Math.max(m, x.grade), 0);
    pushLog(s, { kind: 'takeback', outcome: 'takeback', before: w.grade, value: w.value, serial: w.serial, procs: [] });
    return { grade: w.grade, value: w.value };
  }

  // ---------- 結算（搖鈴） ----------
  function settle(s) {
    if (!inRound(s)) return null;
    const q = quota(s), tribute = s.delivered;
    const won = tribute >= q;
    const carried = s.swords.length;
    if (won && s.endless) s.endlessPaidTributes = (s.endlessPaidTributes || 0) + 1;
    if (rank(s, 'royalchange')) s.nextTributeCredit = round0(Math.min(Math.max(0, tribute - q) * 0.3, baseQuota(s.cfg, s.round + 1) * (rank(s, 'letter') ? 0.9 : 1.0) * 0.3));
    if (!won) { s.misses++; s.totalMisses++; if (rank(s, 'mourning')) s.mourningGreatTickets = inc(s.mourningGreatTickets); }
    else {
      s.successfulTributes++; s.roundsCleared++;
      if (rank(s, 'collector')) { s.taxSuccesses++; s.credits++; }
      if (s.roundOfferedGrade >= 10 && rank(s, 'testament')) s.nextSupplyGrade = Math.floor(s.roundOfferedGrade * 30 / 100);
    }
    s.wallet += Math.max(0, tribute); s.goldEarned += Math.max(0, tribute); s.totalTribute += Math.max(0, tribute);
    const deadline = s.round >= s.cfg.contractRound && !s.endless;
    let dead = s.misses >= 3;
    if (dead && rank(s, 'dragonpardon')) { s.relics.splice(s.relics.indexOf('dragonpardon'), 1); s.misses = 2; dead = false; s.pardonTriggered = true; }
    if (deadline) s.cleared = !dead;
    s.previousTributeSucceeded = won;
    s.lastSettle = { round: s.round, quota: q, tribute, passed: won, gold: Math.max(0, tribute), carried, misses: s.misses, items: s.offered.map(x => ({ grade: x.grade, value: x.value, scrap: !!x.scrap })), contractDone: deadline && !dead, pardon: s.pardonTriggered, credit: s.nextTributeCredit };
    s.history.push({ round: s.round, quota: q, tribute, passed: won, best: s.roundOfferedGrade });
    pushLog(s, { kind: 'settle', outcome: 'settle', round: s.round, quota: q, tribute, passed: won, procs: [] });
    s.offered = []; s.undo = null; s.merchant = null; s.shopping = false;
    s.phase = 'settle';
    if (dead) finishRun(s, 'misses');
    return s.lastSettle;
  }
  function nextRound(s) {
    if (s.phase !== 'settle' || s.ended) return { ok: false };
    if (s.round >= s.cfg.contractRound && !s.endless) { s.endless = true; s.misses = 0; }
    s.round++;
    beginRound(s);
    return { ok: true, round: s.round };
  }
  function endRun(s) { return finishRun(s, 'quit'); }

  function summary(s) {
    return {
      score: s.roundsCleared, round: s.round, roundsCleared: s.roundsCleared, cleared: s.cleared, endless: s.endless, misses: s.misses, endReason: s.endReason,
      totalTribute: s.totalTribute, bestGrade: s.bestGrade, wallet: s.wallet, swordsLeft: s.swords.length,
      strikes: s.stats.strikes, breaks: s.stats.breaks, fevers: s.stats.fevers, delivered: s.stats.delivered, deposits: s.stats.deposits, takebacks: s.stats.takebacks,
      rerolls: s.stats.rerolls, swordsBought: s.stats.swordsBought, consumablesUsed: s.stats.consumablesUsed, rewinds: s.stats.rewinds,
      relics: s.relics.slice(), route: s.route.slice(), history: s.history.slice(),
    };
  }

  return {
    OUTCOMES, LABEL, BASELINE, mulberry32, item, rank, money,
    quota, baseQuota, valueOf, chances, ticketPaper, feverStrikes, feverSeconds, speedOf, strikeInterval, inFever, feverRemaining, expireFever,
    swordSupply, pendingSwords, anvilSword, rackSwords, findSword, bestRackSword,
    newRun, beginRound, takeSword, putOnAnvil, rackAnvil, strike, deliver, takeBack, depositSword, depositCurrent, settle, nextRound, endRun,
    buyRelic, skipStarter, reroll, rerollPrice, freeRerollAvailable, removeRelic, shopOpen,
    isMerchantRound, buyMerchant, merchantRemaining, useConsumable, canRewind, rewind, summary,
  };
});
