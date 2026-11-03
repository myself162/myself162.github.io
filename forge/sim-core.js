// 模擬器核心（v3 基準版）。sim.js（Node）和 sim.html（瀏覽器）共用。
// 內建一個笨 AI：回合開始逛商店（買得起就買、劍幣不夠就投入多的劍、商人回合補劍和鱗片），鍛造時看配額差多少決定上貢。
// 瀏覽器：window.ForgeSim；Node：module.exports。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ForgeSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function runSim(cfg, E, opts) {
    opts = opts || {};
    const RUNS = opts.runs || 2000, SEED = opts.seed == null ? 1 : opts.seed, TH = opts.th == null ? 0.35 : opts.th;
    const PICK = opts.pick || (opts.build && opts.build.length ? 'build' : 'random');
    const BUILD = opts.build || [];
    const MAXR = opts.maxRounds || 40;
    const MAXG = opts.maxGrade || 60;
    const prio = id => { const i = BUILD.indexOf(id); return i < 0 ? 999 : i; };

    function wantedIndex(s) {
      if (PICK === 'none') return -1;
      const open = s.offers.map((o, i) => o.sold || s.relics.includes(o.id) ? -1 : i).filter(i => i >= 0);
      if (!open.length) return -1;
      if (PICK === 'random') return open[Math.floor(s.rng() * open.length)];
      let best = -1, bp = 999;
      for (const i of open) { const p = prio(s.offers[i].id); if (p < bp) { bp = p; best = i; } }
      return best;
    }
    function buyWithReplace(s, idx) {
      let r = E.buyRelic(s, idx);
      if (!r.ok && r.needReplace) {
        const victim = s.relics.slice().sort((a, b) => prio(b) - prio(a))[0];
        if (PICK === 'build' && prio(victim) < prio(s.offers[idx].id)) return false;
        r = E.buyRelic(s, idx, victim);
      }
      return r.ok;
    }
    function pickStarter(s) {
      const idx = wantedIndex(s);
      if (idx < 0) E.skipStarter(s); else E.buyRelic(s, idx);
    }
    function shopAI(s) {
      // 遺物：劍幣夠就買；差幾枚而劍有多（鐵砧上那把沒敲過），就投入換劍幣。
      let idx = wantedIndex(s);
      if (idx >= 0) {
        const o = s.offers[idx];
        while (s.credits < o.price && s.swords.length > 2 && s.weapon && s.weapon.strikes === 0) { E.depositCurrent(s); E.takeSword(s); }
        if (s.credits >= o.price) buyWithReplace(s, idx);
      }
      if (PICK === 'build' && wantedIndex(s) < 0 && s.relics.length < cfg.relicSlots && s.wallet >= E.rerollPrice(s) * 3 && E.rerollPrice(s) > 0) {
        E.reroll(s); idx = wantedIndex(s);
        if (idx >= 0 && s.credits >= s.offers[idx].price) buyWithReplace(s, idx);
      }
      // 商人：先補劍到 3 把以上，再看鱗片。
      if (s.merchant) {
        const offers = s.merchant.offers;
        const si = offers.findIndex(o => o.id === 'sword');
        while (si >= 0 && E.merchantRemaining(offers[si]) > 0 && s.wallet >= offers[si].price && s.swords.length < 4) { if (!E.buyMerchant(s, si).ok) break; }
        const wi = offers.findIndex(o => o.id === 'ward');
        if (wi >= 0 && E.merchantRemaining(offers[wi]) > 0 && s.wallet >= offers[wi].price * 2) E.buyMerchant(s, wi);
        const ri = offers.findIndex(o => o.id === 'rewind');
        if (ri >= 0 && E.merchantRemaining(offers[ri]) > 0 && s.wallet >= offers[ri].price * 2) E.buyMerchant(s, ri);
      }
    }
    function forgeAI(s) {
      const w = s.weapon, e = w.effects;
      const fever = E.inFever(s, w);
      const ticks = E.chances(s, w, fever), pBreak = ticks[0] / 1000;
      const q = E.quota(s), need = q - s.delivered, val = w.value, last = E.pendingSwords(s) === 0;
      if (w.strikes > 400) return E.deliver(s);
      if (fever) return E.strike(s);
      if (s.consumables.ward > 0 && !e.wardArmed && w.grade >= 8 && pBreak >= 0.3 && e.charge < 10) E.useConsumable(s, 'ward');
      if (need > 0 && val >= need) return E.deliver(s);
      if (need <= 0) return (w.grade > 0 && pBreak >= TH) ? E.deliver(s) : E.strike(s);
      if (!last) return (w.grade > 0 && pBreak >= TH && val >= need * 0.3) ? E.deliver(s) : E.strike(s);
      return (w.grade > 0 && pBreak >= Math.max(TH, 0.5)) ? E.deliver(s) : E.strike(s);
    }

    const perGrade = Array.from({ length: MAXG + 1 }, () => ({ strikes: 0, breaks: 0 }));
    const scores = [], rounds = [], bestGrades = [], breaks = [], fevers = [], bought = [], relicsBought = [], tributes = [], golds = [], used = [], rewinds = [];
    let cleared = 0;
    const relicPicks = {}, diedAt = {};
    for (let n = 0; n < RUNS; n++) {
      const s = E.newRun(cfg, { seed: SEED * 1000003 + n });
      let guard = 0, shopRound = 0;
      while (!s.ended && guard++ < 400000) {
        if (s.phase === 'settle') { if (s.round >= MAXR) { E.endRun(s); break; } E.nextRound(s); continue; }
        if (s.starterPending) { pickStarter(s); continue; }
        if (shopRound !== s.round) { shopRound = s.round; shopAI(s); continue; }
        if (!s.weapon) {
          if (E.canRewind(s) && s.undo) { const u = s.undo.swords.find(w => w.serial === s.undo.serial); if (u && u.grade >= 8) { E.rewind(s); continue; } }
          if (E.pendingSwords(s) > 0) { E.takeSword(s); continue; }
          E.settle(s); continue;
        }
        const g = Math.min(MAXG, s.weapon.grade);
        const before = s.stats.strikes;
        const r = forgeAI(s);
        if (s.stats.strikes > before) { perGrade[g].strikes++; if (r && r.raw === 'break') perGrade[g].breaks++; }
      }
      const sm = E.summary(s);
      scores.push(sm.score); rounds.push(sm.round); bestGrades.push(sm.bestGrade); breaks.push(sm.breaks); fevers.push(sm.fevers);
      bought.push(sm.swordsBought); relicsBought.push(sm.route.filter(r => r.picked && r.at === 'shop').length); tributes.push(sm.totalTribute); golds.push(sm.wallet); used.push(sm.consumablesUsed); rewinds.push(sm.rewinds);
      if (sm.cleared) cleared++;
      if (sm.endReason === 'misses') diedAt[sm.round] = (diedAt[sm.round] || 0) + 1;
      for (const id of sm.relics) relicPicks[id] = (relicPicks[id] || 0) + 1;
    }
    return { cfg, opts: { runs: RUNS, seed: SEED, th: TH, pick: PICK, build: BUILD, maxRounds: MAXR }, scores, rounds, bestGrades, breaks, fevers, bought, relicsBought, tributes, golds, used, rewinds, cleared, perGrade, relicPicks, diedAt };
  }

  function formatReport(res, withHist) {
    const { scores, bestGrades, breaks, fevers, bought, relicsBought, golds, used, rewinds, cleared, perGrade, relicPicks, diedAt, opts, cfg } = res;
    const RUNS = scores.length;
    const sorted = scores.slice().sort((a, b) => a - b);
    const q = (xs, p) => { const z = xs.slice().sort((a, b) => a - b); return z[Math.max(0, Math.ceil(p * z.length) - 1)]; };
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    const P = t => (100 * scores.filter(x => x >= t).length / RUNS).toFixed(1) + '%';
    const lines = [];
    lines.push(`config ${cfg.version} | runs=${RUNS} seed=${opts.seed} deliver-th=${opts.th} pick=${opts.pick}${opts.build.length ? ' build=' + opts.build.join(',') : ''} maxRounds=${opts.maxRounds}`);
    lines.push(`達標回合數（分數）  p50=${q(scores, 0.5)} p75=${q(scores, 0.75)} p90=${q(scores, 0.9)} p99=${q(scores, 0.99)} max=${sorted[RUNS - 1]}`);
    lines.push(`P(分數>=5)=${P(5)}  >=10 ${P(10)}  >=15 ${P(15)}  >=${cfg.contractRound} ${P(cfg.contractRound)}   契約完成 ${(100 * cleared / RUNS).toFixed(1)}%`);
    lines.push(`最高武器  p50=+${q(bestGrades, 0.5)} p90=+${q(bestGrades, 0.9)} p99=+${q(bestGrades, 0.99)}   每局破壞 ${mean(breaks).toFixed(1)}  入神 ${mean(fevers).toFixed(1)}  買劍 ${mean(bought).toFixed(1)}  買遺物 ${mean(relicsBought).toFixed(1)}  用消耗品 ${mean(used).toFixed(1)}  回溯 ${mean(rewinds).toFixed(2)}  結束時金幣 p50=${q(golds, 0.5).toLocaleString('en-US')}`);
    lines.push('結束時持有遺物: ' + Object.entries(relicPicks).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${(100 * v / RUNS).toFixed(0)}%`).join('  '));
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
