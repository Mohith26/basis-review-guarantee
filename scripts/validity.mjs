// Repeated-simulation check of the guarantee.
// For R fresh synthetic firms (no drift), run the full pipeline and measure the TRUE miscode
// risk of the October auto-push set (mean of the hidden per-row error probability). The
// certificate claims P(true risk <= alpha) >= 1 - delta. Compare with a static confidence cutoff.
// Usage: node scripts/validity.mjs [R] > data/validity.json
import { generate } from '../core/sim.js';
import { runPipeline } from '../core/guarantee.js';

const R = Number(process.argv[2] ?? 200);
const alphas = [0.005, 0.01, 0.02];
const out = { R, delta: 0.05, staticConf: 0.99, generatedBy: 'node scripts/validity.mjs ' + R, results: [] };
for (const alpha of alphas) {
  let viol = 0, violConf = 0, nConfCert = 0, staticViol = 0, share = 0, shareConf = 0, staticShare = 0, risks = [];
  for (let i = 0; i < R; i++) {
    const data = generate({ seed: 100000 + i, drift: null });
    const P = runPipeline(data, { alpha, delta: 0.05, skipMonitor: true });
    const live = P.live.filter((r) => !r.aboveMat);
    const auto = live.filter((r) => r.tier === 'auto');
    const trueRisk = auto.length ? auto.reduce((s, r) => s + r.pErr, 0) / auto.length : 0;
    risks.push(trueRisk);
    if (trueRisk > alpha) viol++;
    share += auto.length / live.length;
    // same certificate using raw agent confidence as the score
    const cc = P.lttConf.cut;
    const autoC = live.filter((r) => 1 - r.conf <= cc);
    if (P.lttConf.certified >= 0) { nConfCert++; const rc = autoC.reduce((s, r) => s + r.pErr, 0) / autoC.length; if (rc > alpha) violConf++; }
    shareConf += autoC.length / live.length;
    const st = live.filter((r) => r.conf >= 0.99);
    const rs = st.reduce((s, r) => s + r.pErr, 0) / st.length;
    if (rs > alpha) staticViol++;
    staticShare += st.length / live.length;
  }
  risks.sort((a, b) => a - b);
  out.results.push({
    alpha,
    riskScore: { violationRate: viol / R, meanAutoShare: share / R, medianTrueRisk: risks[Math.floor(R / 2)], p95TrueRisk: risks[Math.floor(0.95 * R)] },
    rawConfidence: { certifiedRuns: nConfCert, violationRate: nConfCert ? violConf / nConfCert : null, meanAutoShare: shareConf / R },
    staticCutoff: { violationRate: staticViol / R, meanAutoShare: staticShare / R },
  });
  process.stderr.write(`alpha ${alpha} done\n`);
}
console.log(JSON.stringify(out, null, 1));
