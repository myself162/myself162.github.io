// 鍛造原型 v2 規則引擎。純邏輯，沒有畫面；index.html 和 sim-core.js 共用。
// 一局 = 連續回合。每回合：商店階段 → 鍛造階段 → 結算。
// 瀏覽器：掛在 window.ForgeEngine；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTCOMES = ['break', 'damage', 'hold', 'success', 'great'];
  const LABEL = { break: '破壞', damage: '損傷', hold: '維持', success: '成功', great: '大成功', saved: '護盾擋下', deliver: '上貢', deposit: '投入商店', settle: '結算' };

  // 可重現的亂數（模擬器用）。seed 為空時用 Math.random。
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

  function relicDef(cfg, id) { return cfg.relics.find(r => r.id === id) || null; }
  function held(s, id) { return s.relics.includes(id); }
  function heldByEffect(s, effect) {
    for (const id of s.relics) { const d = relicDef(s.cfg, id); if (d && d.effect === effect) return d; }
    return null;
  }
  function heldShields(s) { return s.relics.filter(id => { const d = relicDef(s.cfg, id); return d && d.shield; }); }

  // ---------- 數值 ----------
  function value(cfg, grade) { return Math.round(cfg.value.base * Math.pow(cfg.value.perGrade, Math.max(0, grade))); }
  function quota(cfg, round) {
    const q = cfg.quota, c = cfg.rounds.contract;
    let v = q.base * Math.pow(q.growth, Math.min(round, c) - 1);
    if (round > c) v *= Math.pow(q.endlessGrowth, round - c);
    return Math.round(v);
  }
  function rerollPrice(s) {
    const sh = s.cfg.shop;
    return Math.ceil(Math.max(sh.rerollMin, quota(s.cfg, s.round) * sh.rerollFraction) * Math.pow(sh.rerollGrowth, s.shop.rerollsPaid));
  }
  function swordPrice(s) {
    const m = s.cfg.merchant;
    return Math.ceil(Math.max(m.minPrice, quota(s.cfg, s.round) * m.fraction) * Math.pow(m.growth, s.shop.swordsBought));
  }

  // 入神參數（遺物可改）。
  function feverParams(s) {
    const f = s.cfg.fever;
    const p = { threshold: f.threshold, strikes: f.strikes, scar: f.scar };
    const b = heldByEffect(s, 'feverMod');
    if (b) { if (b.feverStrikes != null) p.strikes = b.feverStrikes; if (b.feverScar != null) p.scar = b.feverScar; }
    const e = heldByEffect(s, 'emberMod');
    if (e && e.feverThreshold != null) p.threshold = e.feverThreshold;
    return p;
  }

  function newWeapon(s) {
    const ember = heldByEffect(s, 'emberMod');
    return {
      serial: ++s.weaponSerial,
      grade: 0,
      charge: ember ? ember.startCharge : 0,
      scar: 0,          // 淬火疤與護盾留下的破壞籤
      feverLeft: 0,     // 入神剩餘鎚數
      bladeUsed: false, // 備用刃是否用過
      shield: 0,        // 血契儲存的護盾
      damages: 0, holds: 0,
      gearTickets: 0,   // 齒輪累積的成功籤
      strikes: 0, peak: 0,
    };
  }

  // ---------- 一局 ----------
  function newRun(cfg, opts) {
    opts = opts || {};
    const s = {
      cfg,
      rng: opts.seed == null ? Math.random : mulberry32(opts.seed),
      phase: 'shop',            // 'shop' | 'forge' | 'settle' | 'ended'
      round: 1, misses: 0, cleared: false, endless: false,
      wallet: 0, credits: 0,
      swordsLeft: cfg.rounds.supply,   // 這回合還沒拿上鐵砧的武器
      weapon: null, weaponSerial: 0,
      tribute: [], tributeTotal: 0,    // 本回合貢品
      totalTribute: 0, roundsCleared: 0, bestGrade: 0,
      relics: [], shop: null, offer: null, lastSettle: null, history: [],
      route: [],
      stats: { strikes: 0, breaks: 0, fevers: 0, delivered: 0, deposits: 0, saves: 0, rerolls: 0, swordsBought: 0 },
      log: [],
      ended: false, endReason: null, score: 0,
    };
    openShop(s);
    if (cfg.starterOffer) s.offer = makeOffer(s, 'start');
    return s;
  }

  function pushLog(s, entry) { s.log.unshift(entry); if (s.log.length > 30) s.log.pop(); }

  function finishRun(s, reason) {
    if (s.ended) return s;
    s.ended = true; s.endReason = reason; s.phase = 'ended'; s.offer = null;
    s.score = s.roundsCleared;
    return s;
  }

  // ---------- 籤 ----------
  // 籤數明細。base：基礎＋等級；relic：遺物加減；weapon：只對這把武器（疤、齒輪、入神）；final：實際抽籤用。
  function tickets(s, w) {
    w = w || s.weapon;
    const cfg = s.cfg, b = cfg.baseTickets;
    const grade = w ? w.grade : 0, scar = w ? w.scar : 0, gear = w ? w.gearTickets : 0;
    const base = { break: b.break + grade * cfg.breakTicketsPerGrade, damage: b.damage, hold: b.hold, success: b.success, great: b.great };
    const relic = { break: 0, damage: 0, hold: 0, success: 0, great: 0 };
    let breakMin = 0;
    for (const id of s.relics) {
      const d = relicDef(cfg, id); if (!d) continue;
      if (d.tickets) for (const k of OUTCOMES) relic[k] += d.tickets[k] || 0;
      if (d.breakMin != null) breakMin = Math.max(breakMin, d.breakMin);
    }
    const weapon = { break: scar, damage: 0, hold: 0, success: gear, great: 0 };
    const final = {};
    for (const k of OUTCOMES) final[k] = Math.max(0, base[k] + relic[k] + weapon[k]);
    // 鐵箍的「最低 1」：武器本身有破壞壓力時（等級或疤），遺物不能把破壞籤減到 0。
    if (base.break + weapon.break > 0) final.break = Math.max(breakMin, final.break);
    const inFever = !!w && w.feverLeft > 0;
    if (inFever) { weapon.break = -(base.break + relic.break + scar); final.break = 0; }
    const total = OUTCOMES.reduce((a, k) => a + final[k], 0);
    const pct = {};
    for (const k of OUTCOMES) pct[k] = total > 0 ? final[k] / total : 0;
    return { base, relic, weapon, final, total, pct, inFever };
  }

  // ---------- 遺物 ----------
  function shuffledPool(s) {
    const pool = s.cfg.relics.filter(r => !held(s, r.id)).map(r => r.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(s.rng() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool;
  }
  function makeOffer(s, at) {
    const ids = shuffledPool(s).slice(0, s.cfg.shop.offers);
    return ids.length ? { at, ids } : null;
  }
  function generateOffers(s) {
    return shuffledPool(s).slice(0, s.cfg.shop.offers).map(id => ({ id, price: relicDef(s.cfg, id).price || 1, sold: false }));
  }

  // 放一個遺物進格子。格滿要給 replaceId；拿護盾且護盾位已滿時自動換掉舊護盾。
  function addRelic(s, id, replaceId) {
    const d = relicDef(s.cfg, id);
    if (!d) return { ok: false, reason: 'unknown relic' };
    if (held(s, id)) return { ok: false, reason: 'already held' };
    let replaced = null;
    if (d.shield) {
      const shields = heldShields(s);
      if (shields.length >= s.cfg.shieldSlots) replaced = shields[0];
    }
    if (!replaced && s.relics.length >= s.cfg.relicSlots) {
      if (!replaceId || !held(s, replaceId)) return { ok: false, needReplace: true };
      replaced = replaceId;
    }
    if (replaced) s.relics[s.relics.indexOf(replaced)] = id; else s.relics.push(id);
    return { ok: true, picked: id, replaced };
  }

  // 開局免費三選一。index 為 null 代表跳過。
  function chooseOffer(s, index, replaceId) {
    if (!s.offer) return { ok: false, reason: 'no offer' };
    const offer = s.offer;
    if (index == null) {
      s.route.push({ round: s.round, at: 'start', picked: null, replaced: null, price: 0 });
      s.offer = null;
      return { ok: true, picked: null };
    }
    const id = offer.ids[index];
    const r = addRelic(s, id, replaceId);
    if (!r.ok) return r;
    s.route.push({ round: s.round, at: 'start', picked: id, replaced: r.replaced, price: 0 });
    s.offer = null;
    return r;
  }

  // ---------- 商店階段 ----------
  function openShop(s) {
    s.shop = { offers: generateOffers(s), rerollsPaid: 0, swordsBought: 0, swordStock: s.cfg.merchant.swordStock };
  }
  function inShop(s) { return s.phase === 'shop' && !s.offer && !s.ended; }

  function buyRelic(s, index, replaceId) {
    if (!inShop(s)) return { ok: false, reason: 'not in shop' };
    const o = s.shop.offers[index];
    if (!o || o.sold) return { ok: false, reason: 'no offer' };
    if (s.credits < o.price) return { ok: false, reason: 'credits' };
    const r = addRelic(s, o.id, replaceId);
    if (!r.ok) return r;
    s.credits -= o.price; o.sold = true;
    s.route.push({ round: s.round, at: 'shop', picked: o.id, replaced: r.replaced, price: o.price });
    return r;
  }
  function reroll(s) {
    if (!inShop(s)) return { ok: false, reason: 'not in shop' };
    const price = rerollPrice(s);
    if (s.wallet < price) return { ok: false, reason: 'gold' };
    s.wallet -= price; s.shop.rerollsPaid++; s.stats.rerolls++;
    s.shop.offers = generateOffers(s);
    return { ok: true, price };
  }
  function buySword(s) {
    if (!inShop(s)) return { ok: false, reason: 'not in shop' };
    if (s.shop.swordStock <= 0) return { ok: false, reason: 'stock' };
    const price = swordPrice(s);
    if (s.wallet < price) return { ok: false, reason: 'gold' };
    s.wallet -= price; s.shop.swordStock--; s.shop.swordsBought++; s.swordsLeft++; s.stats.swordsBought++;
    return { ok: true, price };
  }
  // 把本回合一把武器投入商店換 1 劍幣。至少留 1 把。
  function depositSword(s) {
    if (!inShop(s)) return { ok: false, reason: 'not in shop' };
    if (s.swordsLeft <= 1) return { ok: false, reason: 'last sword' };
    s.swordsLeft--; s.credits++; s.stats.deposits++;
    return { ok: true };
  }
  function startForging(s) {
    if (!inShop(s)) return { ok: false, reason: 'not in shop' };
    s.phase = 'forge';
    takeSword(s);
    return { ok: true };
  }

  // 拿下一把武器上鐵砧；沒有了就結算。
  function takeSword(s) {
    if (s.swordsLeft > 0) { s.swordsLeft--; s.weapon = newWeapon(s); return true; }
    s.weapon = null;
    settle(s);
    return false;
  }

  // ---------- 鍛造階段 ----------
  function inForge(s) { return s.phase === 'forge' && !!s.weapon && !s.ended; }

  // 敲一鎚。回傳結果；不能敲時回傳 null。
  function strike(s) {
    if (!inForge(s)) return null;
    const cfg = s.cfg, w = s.weapon;
    const t = tickets(s);
    const inFever = t.inFever;
    let r = s.rng() * t.total, outcome = 'great';
    for (const k of OUTCOMES) { if (r < t.final[k]) { outcome = k; break; } r -= t.final[k]; }
    const raw = outcome;
    const before = w.grade;
    s.stats.strikes++; w.strikes++;
    const procs = [];
    let broke = false, shown = outcome;

    if (outcome === 'break') {
      const blade = heldByEffect(s, 'shieldFirstBreak');
      const pact = heldByEffect(s, 'shieldFromDamage');
      if (blade && !w.bladeUsed) {
        w.bladeUsed = true;
        w.grade = Math.max(0, w.grade - blade.gradeLoss);
        w.scar += blade.scarAfter;
        s.stats.saves++;
        procs.push(blade.name + '：破壞改為掉 ' + blade.gradeLoss + ' 級，這把武器破壞籤 +' + blade.scarAfter);
        shown = 'saved';
      } else if (pact && w.shield > 0) {
        w.shield--; s.stats.saves++;
        procs.push(pact.name + '：破壞改為損傷');
        outcome = 'damage'; shown = 'saved';
      } else {
        broke = true;
      }
    }

    if (!broke) {
      if (outcome === 'damage') {
        w.grade = Math.max(0, w.grade + cfg.gradeDelta.damage); w.damages++;
        const pact = heldByEffect(s, 'shieldFromDamage');
        if (pact && w.damages % pact.damagesPerShield === 0 && w.shield < pact.maxShield) {
          w.shield++; procs.push(pact.name + '：儲存一次護盾');
        }
      } else if (outcome === 'hold') {
        w.grade = Math.max(0, w.grade + cfg.gradeDelta.hold); w.holds++;
      } else if (outcome === 'success' || outcome === 'great') {
        let delta = cfg.gradeDelta[outcome];
        const slow = heldByEffect(s, 'holdUpgrade');
        if (outcome === 'success' && slow && w.holds >= slow.holdsNeeded) {
          w.holds -= slow.holdsNeeded; delta = cfg.gradeDelta.great;
          procs.push(slow.name + '：成功升級為大成功'); shown = 'great';
        }
        w.grade += delta;
        const gear = heldByEffect(s, 'accumulateSuccess');
        if (gear) w.gearTickets += gear.perSuccess;
      }
      w.peak = Math.max(w.peak, w.grade);
      s.bestGrade = Math.max(s.bestGrade, w.grade);

      if (inFever) {
        w.feverLeft--;
        if (w.feverLeft === 0) {
          const sc = feverParams(s).scar; w.scar += sc;
          procs.push('入神結束：淬火疤，這把武器破壞籤 +' + sc);
        }
      } else {
        w.charge++;
        const fp = feverParams(s);
        if (w.charge >= fp.threshold) {
          w.charge = 0; w.feverLeft = fp.strikes; s.stats.fevers++;
          procs.push('入神！接下來 ' + fp.strikes + ' 鎚不會破壞');
        }
      }
    } else {
      s.stats.breaks++;
    }

    const result = {
      kind: 'strike', raw, outcome: shown, before, after: broke ? null : w.grade, broke, inFever, procs,
      serial: w.serial, peak: w.peak, swordsLeft: s.swordsLeft,
    };
    pushLog(s, result);
    if (broke) takeSword(s);
    return result;
  }

  // 上貢：這把武器進貢品堆，拿下一把。
  function deliver(s) {
    if (!inForge(s)) return null;
    const w = s.weapon, v = value(s.cfg, w.grade);
    s.tribute.push({ grade: w.grade, value: v, serial: w.serial });
    s.tributeTotal += v; s.stats.delivered++;
    pushLog(s, { kind: 'deliver', outcome: 'deliver', before: w.grade, value: v, serial: w.serial, procs: [] });
    takeSword(s);
    return { grade: w.grade, value: v };
  }

  // 沒敲過的武器可以投入商店換 1 劍幣。
  function depositCurrent(s) {
    if (!inForge(s) || s.weapon.strikes > 0) return null;
    const w = s.weapon;
    s.credits++; s.stats.deposits++;
    pushLog(s, { kind: 'deposit', outcome: 'deposit', before: 0, serial: w.serial, procs: [] });
    takeSword(s);
    return { ok: true };
  }

  // 收工：鐵砧上的武器有等級就上貢、沒敲過就換劍幣、敲過卻是 +0 就丟掉；剩下的武器全變劍幣。
  function settleEarly(s) {
    if (s.phase !== 'forge' || s.ended) return null;
    const w = s.weapon;
    if (w) {
      if (w.grade > 0) {
        const v = value(s.cfg, w.grade);
        s.tribute.push({ grade: w.grade, value: v, serial: w.serial }); s.tributeTotal += v; s.stats.delivered++;
        pushLog(s, { kind: 'deliver', outcome: 'deliver', before: w.grade, value: v, serial: w.serial, procs: [] });
      } else if (w.strikes === 0) {
        s.credits++; s.stats.deposits++;
      }
      s.weapon = null;
    }
    settle(s);
    return s.lastSettle;
  }

  // ---------- 結算 ----------
  function settle(s) {
    if (s.ended) return;
    const q = quota(s.cfg, s.round);
    const passed = s.tributeTotal >= q;
    const unused = s.swordsLeft;
    s.credits += unused; s.swordsLeft = 0; s.weapon = null;
    s.wallet += s.tributeTotal; s.totalTribute += s.tributeTotal;
    if (passed) { s.roundsCleared++; if (s.round === s.cfg.rounds.contract) s.cleared = true; }
    else s.misses++;
    s.lastSettle = { round: s.round, quota: q, tribute: s.tributeTotal, passed, gold: s.tributeTotal, unused, misses: s.misses, items: s.tribute.slice(), contractDone: passed && s.round === s.cfg.rounds.contract };
    s.history.push({ round: s.round, quota: q, tribute: s.tributeTotal, passed, best: s.tribute.reduce((m, t) => Math.max(m, t.grade), 0) });
    pushLog(s, { kind: 'settle', outcome: 'settle', round: s.round, quota: q, tribute: s.tributeTotal, passed, procs: [] });
    s.phase = 'settle';
    if (s.misses >= s.cfg.rounds.maxMisses) finishRun(s, 'misses');
  }

  function nextRound(s) {
    if (s.phase !== 'settle' || s.ended) return { ok: false };
    s.round++;
    s.endless = s.round > s.cfg.rounds.contract;
    s.tribute = []; s.tributeTotal = 0;
    s.swordsLeft = s.cfg.rounds.supply;
    openShop(s);
    s.phase = 'shop';
    return { ok: true, round: s.round };
  }

  // 主動結束這一局（放棄）。
  function endRun(s) { return finishRun(s, 'quit'); }

  function summary(s) {
    return {
      score: s.score, round: s.round, roundsCleared: s.roundsCleared, cleared: s.cleared, endless: s.endless,
      misses: s.misses, endReason: s.endReason,
      totalTribute: s.totalTribute, bestGrade: s.bestGrade,
      strikes: s.stats.strikes, breaks: s.stats.breaks, fevers: s.stats.fevers, delivered: s.stats.delivered,
      saves: s.stats.saves, rerolls: s.stats.rerolls, swordsBought: s.stats.swordsBought, deposits: s.stats.deposits,
      relics: s.relics.slice(), route: s.route.slice(), history: s.history.slice(),
    };
  }

  return {
    OUTCOMES, LABEL, mulberry32, relicDef, feverParams, value, quota, rerollPrice, swordPrice,
    newRun, tickets, chooseOffer,
    buyRelic, reroll, buySword, depositSword, startForging,
    strike, deliver, depositCurrent, settleEarly, nextRound, endRun, summary,
  };
});
