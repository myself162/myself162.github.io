// 模擬器核心（v2）。sim.js（Node）和 sim.html（瀏覽器）共用。
// 內建一個笨 AI：商店階段買得起就買、鍛造階段看配額差多少決定上貢。只看結構，不代表人會怎麼玩。
// 瀏覽器：掛在 window.ForgeSim；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // opts: { runs, seed, th, pick: 'random'|'build'|'none', build: [ids], maxRounds, maxGrade }
  function runSim(cfg, E, opts) {
    opts = opts || {};
    const RUNS = opts.runs || 10000, SEED = opts.seed == null ? 1 : opts.seed, TH = opts.th == null ? 0.35 : opts.th;
    const PICK = opts.pick || (opts.build && opts.build.length ? 'build' : 'random');
    const BUILD = opts.build || [];
    const MAXR = opts.maxRounds || 60;
    const MAXG = opts.maxGrade || 40;
    const prio = id => { const i = BUILD.indexOf(id); return i < 0 ? 999 : i; };

    function wantedIndex(s) {
      const offers = s.shop.offers;
      if (PICK === 'none') return -1;
      if (PICK === 'random') {
        const open = offers.map((o, i) => o.sold ? -1 : i).filter(i => i >= 0);
        return open.length ? open[Math.floor(s.rng() * open.length)] : -1;
      }
      let best = -1, bp = 999;
      offers.forEach((o, i) => { if (!o.sold && prio(o.id) < bp) { bp = prio(o.id); best = i; } });
      return best;
    }
    function victim(s) { return s.relics.slice().sort((a, b) => prio(b) - prio(a))[0]; }
    function buyWithReplace(s, idx) {
      let r = E.buyRelic(s, idx);
      if (!r.ok && r.needReplace) {
        const v = victim(s);
        if (PICK === 'build' && prio(v) < prio(s.shop.offers[idx].id)) return false; // 不要用更想要的換掉
        r = E.buyRelic(s, idx, v);
      }
      return r.ok;
    }
    function pickStarter(s) {
      const ids = s.offer.ids;
      let idx = null;
      if (PICK === 'random') idx = Math.floor(s.rng() * ids.length);
      else if (PICK === 'build') { let bp = 999; ids.forEach((id, i) => { if (prio(id) < bp) { bp = prio(id); idx = i; } }); }
      E.chooseOffer(s, idx);
    }

    function shopAI(s) {
      const supply = cfg.rounds.supply;
      // 1. 想要的遺物：劍幣夠就買；差一兩枚而武器有多，就投入武器湊。
      let idx = wantedIndex(s);
      if (idx >= 0) {
        const o = s.shop.offers[idx];
        while (s.credits < o.price && s.swordsLeft > 2) E.depositSword(s);
        if (s.credits >= o.price) buyWithReplace(s, idx);
      }
      // 2. 沒有想要的、金幣很多、格子沒滿：重抽一次再看。
      if (PICK === 'build' && wantedIndex(s) < 0 && s.relics.length < cfg.relicSlots && s.wallet >= E.rerollPrice(s) * 3) {
        E.reroll(s);
        idx = wantedIndex(s);
        if (idx >= 0 && s.credits >= s.shop.offers[idx].price) buyWithReplace(s, idx);
      }
      // 3. 武器少於供應量就用金幣補；金幣很多再多買一把。
      while (s.swordsLeft < supply && s.shop.swordStock > 0 && s.wallet >= E.swordPrice(s)) E.buySword(s);
      if (s.shop.swordStock > 0 && s.wallet >= E.swordPrice(s) * 2) E.buySword(s);
    }

    function forgeAI(s) {
      const w = s.weapon, t = E.tickets(s), q = E.quota(cfg, s.round);
      const need = q - s.tributeTotal, val = E.value(cfg, w.grade), last = s.swordsLeft === 0;
      if (w.strikes > 400) return E.deliver(s);
      if (t.inFever) return E.strike(s);
      if (need > 0 && val >= need) return E.deliver(s);
      if (need <= 0) return (w.grade > 0 && t.pct.break >= TH) ? E.deliver(s) : E.strike(s);
      if (!last) return (w.grade > 0 && t.pct.break >= TH && val >= need * 0.3) ? E.deliver(s) : E.strike(s);
      return (w.grade > 0 && t.pct.break >= Math.max(TH, 0.5)) ? E.deliver(s) : E.strike(s);
    }

    const perGrade = Array.from({ length: MAXG + 1 }, () => ({ strikes: 0, breaks: 0 }));
    const scores = [], rounds = [], bestGrades = [], breaks = [], fevers = [], bought = [], relicsBought = [], tributes = [];
    let cleared = 0;
    const relicPicks = {};
    const diedAt = {};
    for (let n = 0; n < RUNS; n++) {
      const s = E.newRun(cfg, { seed: SEED * 1000003 + n });
      let guard = 0;
      while (!s.ended && guard++ < 500000) {
        if (s.offer) { pickStarter(s); continue; }
        if (s.phase === 'shop') { shopAI(s); E.startForging(s); continue; }
        if (s.phase === 'settle') { if (s.round >= MAXR) { E.endRun(s); break; } E.nextRound(s); continue; }
        if (s.phase === 'forge') {
          const g = Math.min(MAXG, s.weapon.grade);
          const before = s.stats.strikes;
          const r = forgeAI(s);
          if (s.stats.strikes > before) { perGrade[g].strikes++; if (r && r.raw === 'break') perGrade[g].breaks++; }
          continue;
        }
        break;
      }
      const sm = E.summary(s);
      scores.push(sm.score); rounds.push(sm.round); bestGrades.push(sm.bestGrade); breaks.push(sm.breaks); fevers.push(sm.fevers);
      bought.push(sm.swordsBought); relicsBought.push(sm.route.filter(r => r.picked && r.at === 'shop').length); tributes.push(sm.totalTribute);
      if (sm.cleared) cleared++;
      if (sm.endReason === 'misses') diedAt[sm.round] = (diedAt[sm.round] || 0) + 1;
      for (const id of sm.relics) relicPicks[id] = (relicPicks[id] || 0) + 1;
    }
    return { cfg, opts: { runs: RUNS, seed: SEED, th: TH, pick: PICK, build: BUILD, maxRounds: MAXR }, scores, rounds, bestGrades, breaks, fevers, bought, relicsBought, tributes, cleared, perGrade, relicPicks, diedAt };
  }

  function formatReport(res, withHist) {
    const { scores, rounds, bestGrades, breaks, fevers, bought, relicsBought, cleared, perGrade, relicPicks, diedAt, opts, cfg } = res;
    const RUNS = scores.length;
    const sorted = scores.slice().sort((a, b) => a - b);
    const q = (xs, p) => { const z = xs.slice().sort((a, b) => a - b); return z[Math.max(0, Math.ceil(p * z.length) - 1)]; };
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    const P = t => (100 * scores.filter(x => x >= t).length / RUNS).toFixed(1) + '%';
    const lines = [];
    lines.push(`config ${cfg.version} | runs=${RUNS} seed=${opts.seed} deliver-th=${opts.th} pick=${opts.pick}${opts.build.length ? ' build=' + opts.build.join(',') : ''} maxRounds=${opts.maxRounds}`);
    lines.push(`達標回合數（分數）  p50=${q(scores, 0.5)} p75=${q(scores, 0.75)} p90=${q(scores, 0.9)} p99=${q(scores, 0.99)} max=${sorted[RUNS - 1]}`);
    lines.push(`P(分數>=5)=${P(5)}  >=10 ${P(10)}  >=15 ${P(15)}  >=${cfg.rounds.contract} ${P(cfg.rounds.contract)}   契約完成 ${(100 * cleared / RUNS).toFixed(1)}%`);
    lines.push(`最高武器  p50=+${q(bestGrades, 0.5)} p90=+${q(bestGrades, 0.9)} p99=+${q(bestGrades, 0.99)}   每局破壞 ${mean(breaks).toFixed(1)}  入神 ${mean(fevers).toFixed(1)}  買武器 ${mean(bought).toFixed(1)}  買遺物 ${mean(relicsBought).toFixed(1)}`);
    lines.push('結束時持有遺物: ' + Object.entries(relicPicks).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / RUNS).toFixed(0)}%`).join('  '));
    const died = Object.entries(diedAt).sort((a, b) => a[0] - b[0]);
    lines.push('死在第幾回合（怒氣滿）: ' + died.map(([r, c]) => `R${r}:${(100 * c / RUNS).toFixed(0)}%`).join(' '));
    lines.push('');
    lines.push('grade  strikes  empirical break rate');
    perGrade.forEach((p, g) => { if (p.strikes) lines.push(`+${String(g).padStart(2)}   ${String(p.strikes).padStart(8)}   ${(100 * p.breaks / p.strikes).toFixed(1)}%`); });
    if (withHist) {
      lines.push(''); lines.push('分數直方圖');
      const max = sorted[RUNS - 1];
      for (let v = 0; v <= max; v++) { const c = scores.filter(x => x === v).length; if (c) lines.push(`${String(v).padStart(3)} ${'#'.repeat(Math.round(60 * c / RUNS))} ${c}`); }
    }
    return lines.join('\n');
  }

  return { runSim, formatReport };
});
