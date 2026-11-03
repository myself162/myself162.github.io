// 模擬器核心。sim.js（Node）和 sim.html（瀏覽器）共用。
// 瀏覽器：掛在 window.ForgeSim；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // opts: { runs, seed, th, pick: 'random'|'build'|'none', build: [ids], maxGrade }
  function runSim(cfg, E, opts) {
    opts = opts || {};
    const RUNS = opts.runs || 10000, SEED = opts.seed == null ? 1 : opts.seed, TH = opts.th == null ? 0.35 : opts.th;
    const PICK = opts.pick || (opts.build && opts.build.length ? 'build' : 'random');
    const BUILD = opts.build || [];
    const MAXG = opts.maxGrade || 40;

    function resolveOffer(s) {
      const ids = s.offer.ids;
      let idx = null;
      if (PICK === 'random') idx = Math.floor(s.rng() * ids.length);
      else if (PICK === 'build') { for (const want of BUILD) { const i = ids.indexOf(want); if (i >= 0) { idx = i; break; } } }
      if (idx == null) { E.chooseOffer(s, null); return; }
      let r = E.chooseOffer(s, idx);
      if (!r.ok && r.needReplace) {
        const prio = id => { const i = BUILD.indexOf(id); return i < 0 ? 999 : i; };
        const victim = s.relics.slice().sort((a, b) => prio(b) - prio(a))[0];
        E.chooseOffer(s, idx, victim);
      }
    }

    const perGrade = Array.from({ length: MAXG + 1 }, () => ({ strikes: 0, breaks: 0 }));
    const scores = [], touched = [], breaks = [], fevers = [], shelves = [], saves = [];
    const relicPicks = {};
    for (let n = 0; n < RUNS; n++) {
      const s = E.newRun(cfg, { seed: SEED * 1000003 + n });
      while (!s.ended) {
        if (s.offer) { resolveOffer(s); continue; }
        const w = s.weapon, t = E.tickets(s);
        if (!t.inFever && w.grade > s.bestShelved && t.pct.break >= TH) { E.shelve(s); continue; }
        const g = Math.min(MAXG, w.grade);
        const r = E.strike(s);
        perGrade[g].strikes++;
        if (r && r.raw === 'break') perGrade[g].breaks++;
      }
      const sm = E.summary(s);
      scores.push(sm.score); touched.push(sm.touched); breaks.push(sm.breaks); fevers.push(sm.fevers); shelves.push(sm.shelves); saves.push(sm.saves);
      for (const id of sm.relics) relicPicks[id] = (relicPicks[id] || 0) + 1;
    }
    return { cfg, opts: { runs: RUNS, seed: SEED, th: TH, pick: PICK, build: BUILD }, scores, touched, breaks, fevers, shelves, saves, perGrade, relicPicks };
  }

  function formatReport(res, withHist) {
    const { scores, touched, breaks, fevers, shelves, saves, perGrade, relicPicks, opts, cfg } = res;
    const RUNS = scores.length;
    const sorted = scores.slice().sort((a, b) => a - b);
    const q = p => sorted[Math.max(0, Math.ceil(p * RUNS) - 1)];
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    const pct = t => (100 * scores.filter(x => x >= t).length / RUNS).toFixed(t >= 25 ? 2 : 1) + '%';
    const lines = [];
    lines.push(`config ${cfg.version} | runs=${RUNS} seed=${opts.seed} shelve-th=${opts.th} pick=${opts.pick}${opts.build.length ? ' build=' + opts.build.join(',') : ''}`);
    lines.push(`score  p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} p99=${q(0.99)} max=${sorted[RUNS - 1]}`);
    lines.push(`P(score>=10)=${pct(10)}  >=15 ${pct(15)}  >=20 ${pct(20)}  >=25 ${pct(25)}  >=30 ${pct(30)}`);
    lines.push(`touched p50=${touched.slice().sort((a, b) => a - b)[Math.floor(RUNS / 2)]}  breaks/run=${mean(breaks).toFixed(1)}  fevers/run=${mean(fevers).toFixed(1)}  shelves/run=${mean(shelves).toFixed(1)}  saves/run=${mean(saves).toFixed(2)}`);
    lines.push('relics held at end: ' + Object.entries(relicPicks).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / RUNS).toFixed(0)}%`).join('  '));
    lines.push('');
    lines.push('grade  strikes  empirical break rate');
    perGrade.forEach((p, g) => { if (p.strikes) lines.push(`+${String(g).padStart(2)}   ${String(p.strikes).padStart(8)}   ${(100 * p.breaks / p.strikes).toFixed(1)}%`); });
    if (withHist) {
      lines.push(''); lines.push('score histogram');
      const max = sorted[RUNS - 1];
      for (let v = 0; v <= max; v++) { const c = scores.filter(x => x === v).length; if (c) lines.push(`${String(v).padStart(3)} ${'#'.repeat(Math.round(60 * c / RUNS))} ${c}`); }
    }
    return lines.join('\n');
  }

  return { runSim, formatReport };
});
