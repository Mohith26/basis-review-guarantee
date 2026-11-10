import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, mulberry32, sigmoid } from '../core/sim.js';
import { binomCdf, cpUpper, learnThenTest, buildGrid, fitLogistic, predictLogistic, auc, logMixtureLR, confSeq, runPipeline, lgamma } from '../core/guarantee.js';

test('lgamma matches log factorial', () => {
  let lf = 0;
  for (let n = 1; n <= 30; n++) { lf += Math.log(n); assert.ok(Math.abs(lgamma(n + 1) - lf) < 1e-9 * Math.max(1, lf)); }
});

test('binomial CDF matches brute force and Clopper-Pearson bound inverts it', () => {
  const brute = (k, n, p) => { let s = 0, c = 1; for (let i = 0; i <= k; i++) { if (i > 0) c = c * (n - i + 1) / i; s += c * p ** i * (1 - p) ** (n - i); } return s; };
  for (const [k, n, p] of [[0, 10, 0.1], [3, 40, 0.05], [7, 60, 0.2], [2, 300, 0.01]]) assert.ok(Math.abs(binomCdf(k, n, p) - brute(k, n, p)) < 1e-10);
  const u = cpUpper(3, 400, 0.05);
  assert.ok(Math.abs(binomCdf(3, 400, u) - 0.05) < 1e-6);
  assert.ok(u > 3 / 400);
});

test('fixed-sequence LTT stops at the first non-rejection', () => {
  // risk grows with score; grid of 5 cutoffs
  const cal = [];
  const r = mulberry32(3);
  for (let i = 0; i < 20000; i++) { const s = r(); cal.push({ score: s, y: r() < 0.002 + 0.05 * s * s ? 1 : 0 }); }
  const grid = [0.1, 0.2, 0.4, 0.7, 0.95].map((cut, i) => ({ share: cut, cut }));
  const res = learnThenTest(cal, grid, 0.01, 0.05);
  const firstFail = res.steps.findIndex((s) => !s.rejected);
  assert.equal(res.certified, firstFail - 1);
  assert.ok(res.steps.slice(firstFail).every((s) => !s.rejected));
});

test('LTT controls the conditional risk across repeated calibration draws', () => {
  // known model: P(error | score s) = 0.001 + 0.04 s^3, score ~ U(0,1)
  const trueRisk = (c) => (0.001 * c + 0.04 * c ** 4 / 4) / c; // E[err | s <= c]
  const alpha = 0.01, delta = 0.1;
  let viol = 0, cert = 0;
  const trainR = mulberry32(99); const train = Array.from({ length: 5000 }, () => trainR());
  const grid = buildGrid(train, 0.02, 0.98, 0.3);
  for (let rep = 0; rep < 300; rep++) {
    const r = mulberry32(1000 + rep);
    const cal = Array.from({ length: 3000 }, () => { const s = r(); return { score: s, y: r() < 0.001 + 0.04 * s ** 3 ? 1 : 0 }; });
    const res = learnThenTest(cal, grid, alpha, delta);
    if (res.certified >= 0) { cert++; if (trueRisk(res.cut) > alpha) viol++; }
  }
  assert.ok(cert > 200, `certified in ${cert} runs`);
  assert.ok(viol / 300 <= delta + 0.03, `violation rate ${viol / 300}`);
});

test('logistic regression recovers a known model', () => {
  const r = mulberry32(11);
  const X = [], y = [];
  for (let i = 0; i < 20000; i++) { const a = r() * 2 - 1, b = r() < 0.5 ? 1 : 0; X.push([a, b]); y.push(r() < sigmoid(-1 + 2 * a - 1.5 * b) ? 1 : 0); }
  const m = fitLogistic(X, y, 1e-6);
  const p = predictLogistic(m, [0.5, 1]);
  assert.ok(Math.abs(p - sigmoid(-1 + 1 - 1.5)) < 0.03, `p=${p}`);
});

test('AUC is 1 for perfect ranking and 0.5 for ties', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
});

test('mixture monitor rarely alarms when the rate is at the target (anytime-valid)', () => {
  const alpha = 0.01, delta = 0.05;
  let alarms = 0;
  for (let rep = 0; rep < 400; rep++) {
    const r = mulberry32(5000 + rep);
    let s = 0;
    for (let t = 1; t <= 300; t++) { s += r() < alpha ? 1 : 0; if (s / t > alpha && logMixtureLR(s, t, alpha) >= Math.log(1 / delta)) { alarms++; break; } }
  }
  assert.ok(alarms / 400 <= delta, `false alarm rate ${alarms / 400}`);
  const [lo, hi] = confSeq(3, 100, 0.05);
  assert.ok(lo < 0.03 && hi > 0.03 && lo >= 0);
});

test('pipeline is deterministic and its counts are consistent', () => {
  const a = runPipeline(generate({ seed: 7 }), { skipMonitor: true });
  const b = runPipeline(generate({ seed: 7 }), { skipMonitor: true });
  assert.equal(a.stats.auto.n, b.stats.auto.n);
  assert.equal(a.lttRisk.certified, b.lttRisk.certified);
  const s = a.stats;
  assert.equal(s.auto.n + s.review.n + s.material.n, s.live);
  assert.ok(s.audited.n <= s.auto.n);
  assert.ok(a.aucRisk > a.aucConf, 'risk score should rank better than raw confidence');
});

test('drift on the Kestrel card feed is detected after it starts; clean feeds stay quiet', () => {
  const P = runPipeline(generate({}), {});
  const k = P.monitor.find((m) => m.client === 0 && m.src === 'card');
  assert.ok(k.alarmDate && k.alarmDate >= '2026-10-09' && k.alarmDate <= '2026-10-31', `alarm ${k.alarmDate}`);
  const others = P.monitor.filter((m) => m !== k && m.alarmDate);
  assert.ok(others.length <= 2, `${others.length} other alarms`);
  assert.ok(P.stats.autoAfterPause.rate <= P.stats.auto.rate);
  const clean = runPipeline(generate({ drift: null }), {});
  assert.ok(!clean.monitor.find((m) => m.client === 0 && m.src === 'card').alarmDate);
});

test('end-to-end certificate holds across fresh firms (small repeated simulation)', () => {
  let viol = 0;
  const R = 12;
  for (let i = 0; i < R; i++) {
    const P = runPipeline(generate({ seed: 300 + i, drift: null }), { alpha: 0.01, skipMonitor: true });
    const auto = P.live.filter((r) => r.tier === 'auto');
    const risk = auto.reduce((s, r) => s + r.pErr, 0) / auto.length;
    if (risk > 0.01) viol++;
  }
  assert.ok(viol <= 1, `${viol} of ${R} runs violated`);
});
