// 鍛造原型 v1 規則引擎。純邏輯，沒有畫面；index.html 和 sim.js 共用。
// 瀏覽器：掛在 window.ForgeEngine；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTCOMES = ['break', 'damage', 'hold', 'success', 'great'];
  const LABEL = { break: '破壞', damage: '損傷', hold: '維持', success: '成功', great: '大成功', saved: '護盾擋下', shelve: '收起' };

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

  function newRun(cfg, opts) {
    opts = opts || {};
    const s = {
      cfg,
      rng: opts.seed == null ? Math.random : mulberry32(opts.seed),
      strikesLeft: cfg.strikesPerRun,
      relics: [],
      weaponSerial: 0,
      weapon: null,
      shelved: [], bestShelved: 0, touched: 0,
      reached: {}, offer: null,
      ended: false, endReason: null, score: 0,
      route: [],
      stats: { strikes: 0, breaks: 0, fevers: 0, shelves: 0, saves: 0 },
      log: [],
    };
    s.weapon = newWeapon(s);
    if (cfg.starterOffer) s.offer = makeOffer(s, 'start');
    return s;
  }

  // 籤數明細。base：基礎＋等級；relic：遺物加減；weapon：只對這把武器（疤、齒輪、入神）；final：實際抽籤用。
  function tickets(s) {
    const cfg = s.cfg, w = s.weapon, b = cfg.baseTickets;
    const base = { break: b.break + w.grade * cfg.breakTicketsPerGrade, damage: b.damage, hold: b.hold, success: b.success, great: b.great };
    const relic = { break: 0, damage: 0, hold: 0, success: 0, great: 0 };
    let breakMin = 0;
    for (const id of s.relics) {
      const d = relicDef(cfg, id); if (!d) continue;
      if (d.tickets) for (const k of OUTCOMES) relic[k] += d.tickets[k] || 0;
      if (d.breakMin != null) breakMin = Math.max(breakMin, d.breakMin);
    }
    const weapon = { break: w.scar, damage: 0, hold: 0, success: w.gearTickets, great: 0 };
    const final = {};
    for (const k of OUTCOMES) final[k] = Math.max(0, base[k] + relic[k] + weapon[k]);
    // 鐵箍的「最低 1」：武器本身有破壞壓力時（等級或疤），遺物不能把破壞籤減到 0。
    if (base.break + weapon.break > 0) final.break = Math.max(breakMin, final.break);
    const inFever = w.feverLeft > 0;
    if (inFever) { weapon.break = -(base.break + relic.break + w.scar); final.break = 0; }
    const total = OUTCOMES.reduce((a, k) => a + final[k], 0);
    const pct = {};
    for (const k of OUTCOMES) pct[k] = total > 0 ? final[k] / total : 0;
    return { base, relic, weapon, final, total, pct, inFever };
  }

  function makeOffer(s, at) {
    const pool = s.cfg.relics.filter(r => !held(s, r.id)).map(r => r.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(s.rng() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const ids = pool.slice(0, s.cfg.offerSize);
    return ids.length ? { at, ids } : null;
  }

  // index：0..n-1，或 null 代表跳過。遺物格滿時要給 replaceId；拿護盾且護盾位已滿時自動換掉舊護盾。
  function chooseOffer(s, index, replaceId) {
    if (!s.offer) return { ok: false, reason: 'no offer' };
    const offer = s.offer;
    if (index == null) {
      s.route.push({ at: offer.at, offered: offer.ids.slice(), picked: null, replaced: null });
      s.offer = null;
      return { ok: true, picked: null };
    }
    const id = offer.ids[index];
    const d = relicDef(s.cfg, id);
    if (!d) return { ok: false, reason: 'bad index' };
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
    s.route.push({ at: offer.at, offered: offer.ids.slice(), picked: id, replaced });
    s.offer = null;
    return { ok: true, picked: id, replaced };
  }

  function finish(s, reason) {
    if (s.ended) return s;
    if (reason !== 'break' && s.weapon) {
      s.shelved.push(s.weapon.grade);
      s.bestShelved = Math.max(s.bestShelved, s.weapon.grade);
    }
    s.ended = true; s.endReason = reason; s.offer = null; s.score = s.bestShelved;
    return s;
  }

  function pushLog(s, entry) { s.log.unshift(entry); if (s.log.length > 30) s.log.pop(); }

  // 敲一鎚。回傳結果；不能敲時回傳 null。
  function strike(s) {
    if (s.ended || s.offer || s.strikesLeft <= 0) return null;
    const cfg = s.cfg, w = s.weapon;
    const t = tickets(s);
    const inFever = t.inFever;
    let r = s.rng() * t.total, outcome = 'great';
    for (const k of OUTCOMES) { if (r < t.final[k]) { outcome = k; break; } r -= t.final[k]; }
    const raw = outcome;
    const before = w.grade;
    s.strikesLeft--; s.stats.strikes++; w.strikes++;
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
      s.touched = Math.max(s.touched, w.grade); w.peak = Math.max(w.peak, w.grade);

      for (const m of cfg.milestones) {
        if (w.grade >= m && !s.reached[m]) {
          s.reached[m] = true;
          const o = makeOffer(s, m);
          if (o) { s.offer = o; procs.push('本局首次到達 +' + m + '：遺物三選一'); }
          break;
        }
      }

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
      raw, outcome: shown, before, after: broke ? null : s.weapon.grade, broke, inFever, procs,
      strikesLeft: s.strikesLeft, serial: w.serial, peak: w.peak,
    };
    pushLog(s, result);

    if (broke) {
      if (cfg.onBreak === 'endRun') finish(s, 'break');
      else s.weapon = newWeapon(s);
    }
    if (!s.ended && s.strikesLeft <= 0) finish(s, 'strikes');
    return result;
  }

  // 收起目前的武器：等級永久記入本局，換一把 +0 新武器。
  function shelve(s) {
    if (s.ended || s.offer) return false;
    const w = s.weapon;
    s.shelved.push(w.grade); s.bestShelved = Math.max(s.bestShelved, w.grade); s.stats.shelves++;
    pushLog(s, { raw: 'shelve', outcome: 'shelve', before: w.grade, after: null, broke: false, inFever: false, procs: [], strikesLeft: s.strikesLeft, serial: w.serial, peak: w.peak });
    s.weapon = newWeapon(s);
    return true;
  }

  // 結束這一局：鐵砧上的武器自動收起。
  function endRun(s) { return finish(s, 'quit'); }

  function summary(s) {
    return {
      score: s.score, touched: s.touched, endReason: s.endReason,
      strikes: s.stats.strikes, breaks: s.stats.breaks, fevers: s.stats.fevers, shelves: s.stats.shelves, saves: s.stats.saves,
      relics: s.relics.slice(), route: s.route.slice(), shelved: s.shelved.slice(),
    };
  }

  return { OUTCOMES, LABEL, mulberry32, relicDef, feverParams, newRun, tickets, strike, shelve, endRun, chooseOffer, summary };
});
