// Review guarantee: certify which agent-coded transactions can skip line-by-line review.
//
// 1. Risk score: logistic regression on the agent's confidence plus ledger-history features,
//    fit on a TRAIN split of fully reviewed history (Apr-Jun).
// 2. Learn-then-Test (Angelopoulos et al. 2021) on a separate CALIBRATION split (Jul-Sep):
//    for a fixed grid of risk cutoffs (built from the TRAIN split only, so it is independent
//    of the calibration data), test H_j: "miscode rate among auto-pushed items > alpha" with an
//    exact binomial p-value, in a fixed sequence from strict to loose. The loosest cutoff
//    rejected before the first failure is certified: with prob >= 1 - delta over the
//    calibration draw, the miscode rate among future (exchangeable) auto-pushed items <= alpha.
// 3. Live month: a random audit sample of auto-pushed items is still reviewed. A beta-binomial
//    mixture martingale gives an anytime-valid test of "rate <= alpha" per client; when it
//    crosses 1/delta_mon the guarantee is treated as broken and auto-push is paused.

import { sigmoid, logit, mulberry32 } from './sim.js';

// ---------- special functions ----------
const LG = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += LG[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export const lbeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);
const lchoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

/** P(Bin(n,p) <= k), summed in log space (k is small relative to n here). */
export function binomCdf(k, n, p) {
  if (k >= n) return 1;
  if (k < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let mx = -Infinity;
  const terms = [];
  for (let i = 0; i <= k; i++) {
    const t = lchoose(n, i) + i * lp + (n - i) * lq;
    terms.push(t);
    if (t > mx) mx = t;
  }
  let s = 0;
  for (const t of terms) s += Math.exp(t - mx);
  return Math.min(1, Math.exp(mx) * s);
}

/** One-sided Clopper-Pearson upper bound: largest p with P(Bin(n,p) <= k) >= delta. */
export function cpUpper(k, n, delta) {
  if (n === 0) return 1;
  if (k >= n) return 1;
  let lo = k / n, hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) >= delta) lo = mid; else hi = mid;
  }
  return lo;
}

// ---------- features + logistic risk model ----------
export const FEATURE_NAMES = ['Agent confidence (logit)', 'No prior coding for vendor', 'Fewer than 4 prior codings', 'Vendor ambiguity', 'Firm coding rule', 'Amount vs vendor norm', 'Refund / credit'];
export function features(row) {
  const c = Math.min(Math.max(row.conf, 1e-4), 1 - 1e-4);
  return [logit(c), row.f.hist === 0 ? 1 : 0, row.f.hist > 0 && row.f.hist < 4 ? 1 : 0, row.f.amb, row.f.rule, Math.min(row.f.amtZ, 3), row.f.refund];
}

/** L2-regularised logistic regression by Newton/IRLS. Returns {w, b, mu, sd}. */
export function fitLogistic(X, y, l2 = 1e-3, iters = 25) {
  const n = X.length, d = X[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((x) => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]);
  const D = d + 1;
  let w = new Array(D).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(D).fill(0);
    const H = Array.from({ length: D }, () => new Array(D).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let s = 0; for (let j = 0; j < D; j++) s += w[j] * z[j];
      const p = sigmoid(s), r = p * (1 - p), e = p - y[i];
      for (let j = 0; j < D; j++) {
        g[j] += e * z[j];
        const rz = r * z[j];
        for (let k = j; k < D; k++) H[j][k] += rz * z[k];
      }
    }
    for (let j = 0; j < D; j++) { for (let k = 0; k < j; k++) H[j][k] = H[k][j]; if (j > 0) { H[j][j] += l2 * n; g[j] += l2 * n * w[j]; } }
    const step = solve(H, g);
    let mx = 0;
    w = w.map((v, j) => { mx = Math.max(mx, Math.abs(step[j])); return v - step[j]; });
    if (mx < 1e-8) break;
  }
  return { w: w.slice(1), b: w[0], mu, sd };
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / piv; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
export function predictLogistic(model, x) {
  let s = model.b;
  for (let j = 0; j < x.length; j++) s += model.w[j] * (x[j] - model.mu[j]) / model.sd[j];
  return sigmoid(s);
}

/** Rank-based AUC for "score predicts miscode" (higher score = riskier). */
export function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, sumPos = 0, nPos = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]]) { sumPos += avg; nPos++; }
    i = j + 1; rank = j;
  }
  const nNeg = scores.length - nPos;
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : NaN;
}

/** Reliability table: bins of a probability-of-correct score vs observed accuracy. */
export function reliability(probCorrect, labelsCorrect, edges = [0.5, 0.8, 0.9, 0.95, 0.98, 0.99, 1.0001]) {
  const out = [];
  for (let b = 0; b < edges.length - 1; b++) {
    let n = 0, sp = 0, sy = 0;
    for (let i = 0; i < probCorrect.length; i++) {
      const p = probCorrect[i];
      if (p >= edges[b] && p < edges[b + 1]) { n++; sp += p; sy += labelsCorrect[i]; }
    }
    out.push({ lo: edges[b], hi: Math.min(1, edges[b + 1]), n, meanPred: n ? sp / n : NaN, observed: n ? sy / n : NaN });
  }
  return out;
}

// ---------- Learn-then-Test ----------
/**
 * Build a data-independent cutoff grid from TRAIN scores: cutoffs at the TRAIN-split
 * quantiles that would auto-push 1%, 2%, ..., maxShare of items (lower score = safer).
 */
export function buildGrid(trainScores, step = 0.01, maxShare = 0.99, minShare = 0.05) {
  const s = [...trainScores].sort((a, b) => a - b);
  const grid = [];
  for (let q = minShare; q <= maxShare + 1e-9; q += step) grid.push({ share: Math.round(q * 1000) / 1000, cut: s[Math.min(s.length - 1, Math.floor(q * s.length))] });
  return grid;
}

/**
 * Fixed-sequence LTT for the conditional risk P(miscode | score <= cut).
 * cal: array of {score, y} (y = 1 if the reviewer changed the account).
 * Returns per-grid stats and the certified index (-1 if none).
 */
export function learnThenTest(cal, grid, alpha, delta) {
  const sorted = [...cal].sort((a, b) => a.score - b.score);
  const steps = [];
  let p = 0, n = 0, k = 0, certified = -1, stopped = false;
  for (let j = 0; j < grid.length; j++) {
    while (p < sorted.length && sorted[p].score <= grid[j].cut) { n++; k += sorted[p].y; p++; }
    const pval = n ? binomCdf(k, n, alpha) : 1;
    const rejected = !stopped && pval <= delta;
    if (rejected) certified = j; else stopped = true;
    steps.push({ j, share: grid[j].share, cut: grid[j].cut, n, k, rate: n ? k / n : NaN, pval, rejected, ucb: cpUpper(k, n, delta) });
  }
  return { steps, certified, cut: certified >= 0 ? grid[certified].cut : -Infinity };
}

// ---------- anytime-valid monitoring ----------
/** log of the beta-binomial mixture likelihood ratio against p0 after t draws with s errors. */
export function logMixtureLR(s, t, p0, a = 1, b = 30) {
  return lbeta(a + s, b + t - s) - lbeta(a, b) - (s * Math.log(p0) + (t - s) * Math.log1p(-p0));
}
/** Anytime-valid confidence sequence {p : LR(p) < 1/delta}, found on a grid. */
export function confSeq(s, t, delta, a = 1, b = 30) {
  if (t === 0) return [0, 1];
  const thr = Math.log(1 / delta);
  let lo = 1, hi = 0;
  for (let i = 1; i < 2000; i++) {
    const p = i / 2000;
    if (logMixtureLR(s, t, p, a, b) < thr) { if (p < lo) lo = p; if (p > hi) hi = p; }
  }
  if (lo > hi) return [s / t, s / t];
  return [s === 0 ? 0 : lo, hi];
}

// ---------- full pipeline ----------
export function runPipeline(data, opts = {}) {
  const alpha = opts.alpha ?? 0.01;
  const delta = opts.delta ?? 0.05;
  const auditRate = opts.auditRate ?? 0.1;
  const deltaMon = opts.deltaMon ?? 0.05;
  const mode = opts.mode ?? 'firm'; // 'firm' | 'client'
  const staticConf = opts.staticConf ?? 0.99;
  const trainMonths = opts.trainMonths ?? ['2026-04', '2026-05', '2026-06'];
  const calMonths = opts.calMonths ?? ['2026-07', '2026-08', '2026-09'];
  const liveMonth = opts.liveMonth ?? '2026-10';
  const rows = data.rows;
  const train = rows.filter((r) => trainMonths.includes(r.month) && !r.aboveMat);
  const cal = rows.filter((r) => calMonths.includes(r.month) && !r.aboveMat);
  const live = rows.filter((r) => r.month === liveMonth);

  const model = opts.model ?? fitLogistic(train.map(features), train.map((r) => r.miscoded));
  const score = (r) => predictLogistic(model, features(r));
  const confRisk = (r) => 1 - r.conf;
  for (const r of rows) { r.risk = score(r); }

  const gridRisk = buildGrid(train.map((r) => r.risk));
  const gridConf = buildGrid(train.map(confRisk));
  const calRisk = cal.map((r) => ({ score: r.risk, y: r.miscoded, client: r.client }));
  const calConf = cal.map((r) => ({ score: confRisk(r), y: r.miscoded }));
  const lttRisk = learnThenTest(calRisk, gridRisk, alpha, delta);
  const lttConf = learnThenTest(calConf, gridConf, alpha, delta);

  // per-client certification (each client gets its own guarantee at level delta)
  const perClient = data.clients.map((c) => {
    const cc = calRisk.filter((x) => x.client === c.id);
    const res = learnThenTest(cc, gridRisk, alpha, delta);
    return { client: c.id, nCal: cc.length, kCal: cc.reduce((s, x) => s + x.y, 0), certified: res.certified, cut: res.cut, share: res.certified >= 0 ? gridRisk[res.certified].share : 0, steps: res.steps };
  });
  const cutFor = (cid) => (mode === 'client' ? perClient[cid].cut : lttRisk.cut);

  // live month decisions + audit sample (deterministic per row id)
  const audU = mulberry32((opts.auditSeed ?? 7) * 7919 + 1);
  const auditDraw = new Map(); for (const r of live) auditDraw.set(r.id, audU());
  const decide = (r) => (r.aboveMat ? 'material' : r.risk <= cutFor(r.client) ? 'auto' : 'review');
  for (const r of live) { r.tier = decide(r); r.audit = r.tier === 'auto' && auditDraw.get(r.id) < auditRate ? 1 : 0; r.confTier = r.aboveMat ? 'material' : (r.conf >= staticConf ? 'auto' : 'review'); }

  // monitoring: one stream per client bank/card feed (feeds are where formats change)
  const days = [...new Set(live.map((r) => r.date))].sort();
  const monitor = [];
  if (!opts.skipMonitor) for (const c of data.clients) for (const src of ['card', 'bank']) {
    const lr = live.filter((r) => r.client === c.id && r.src === src);
    if (!lr.length) continue;
    let s = 0, t = 0, alarmDate = null;
    const series = [];
    for (const d of days) {
      for (const r of lr) if (r.date === d && r.audit) { t++; s += r.miscoded; }
      const llr = t ? logMixtureLR(s, t, alpha) : 0;
      const [lo, hi] = confSeq(s, t, deltaMon);
      const alarm = t > 0 && s / t > alpha && llr >= Math.log(1 / deltaMon);
      if (alarm && !alarmDate) alarmDate = d;
      series.push({ date: d, s, t, lo, hi, llr, alarm });
    }
    monitor.push({ client: c.id, src, series, alarmDate, s, t, n: lr.length });
  }
  // firm-level stream
  const firmSeries = [];
  let firmAlarmDate = null;
  if (!opts.skipMonitor) {
    let s = 0, t = 0;
    for (const d of days) {
      for (const r of live) if (r.date === d && r.audit) { t++; s += r.miscoded; }
      const [lo, hi] = confSeq(s, t, deltaMon);
      const llr = t ? logMixtureLR(s, t, alpha) : 0;
      const alarm = t > 0 && s / t > alpha && llr >= Math.log(1 / deltaMon);
      if (alarm && !firmAlarmDate) firmAlarmDate = d;
      firmSeries.push({ date: d, s, t, lo, hi, llr, alarm });
    }
  }

  // pause: after a client's alarm, its auto-push stops and that month's auto-pushed items go back to review
  const alarmByFeed = Object.fromEntries(monitor.map((m) => [`${m.client}:${m.src}`, m.alarmDate]));
  for (const r of live) {
    r.finalTier = r.tier;
    const a = alarmByFeed[`${r.client}:${r.src}`];
    if (r.tier === 'auto' && a) r.finalTier = r.date >= a ? 'paused' : 'requeued';
  }

  const summarize = (pred) => {
    const sel = live.filter(pred);
    const k = sel.reduce((s, r) => s + r.miscoded, 0);
    return { n: sel.length, k, rate: sel.length ? k / sel.length : NaN };
  };
  const stats = {
    live: live.length,
    material: summarize((r) => r.tier === 'material'),
    auto: summarize((r) => r.tier === 'auto'),
    autoNoDrift: summarize((r) => r.tier === 'auto' && !r.drifted),
    autoAfterPause: summarize((r) => r.finalTier === 'auto'),
    review: summarize((r) => r.tier === 'review'),
    audited: summarize((r) => r.audit === 1),
    staticAuto: summarize((r) => r.confTier === 'auto'),
    requeued: summarize((r) => r.finalTier === 'requeued' || r.finalTier === 'paused'),
    unreviewedErrors: live.filter((r) => r.finalTier === 'auto' && !r.audit && r.miscoded).length,
    staticUnreviewedErrors: live.filter((r) => r.confTier === 'auto' && r.miscoded).length,
  };
  const calCorrect = cal.map((r) => 1 - r.miscoded);
  const relConf = reliability(cal.map((r) => r.conf), calCorrect);
  const relRisk = reliability(cal.map((r) => 1 - r.risk), calCorrect);
  return {
    alpha, delta, auditRate, deltaMon, mode, staticConf, model, train, cal, live, days,
    gridRisk, gridConf, lttRisk, lttConf, perClient, monitor, firmSeries, firmAlarmDate, stats, relConf, relRisk,
    aucRisk: auc(cal.map((r) => r.risk), cal.map((r) => r.miscoded)),
    aucConf: auc(cal.map(confRisk), cal.map((r) => r.miscoded)),
  };
}
