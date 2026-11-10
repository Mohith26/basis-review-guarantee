# Review guarantee: certified auto-posting for AI-coded transactions

**Live demo:** https://mohith26.github.io/basis-review-guarantee/

An unofficial concept for a new page in an AI accounting platform's client-accounting workspace (built with Basis in mind). Basis already codes bank and card transactions, pushes high-confidence ones and flags low-confidence ones for review. This demo asks a narrower question a CAS partner has to answer before letting anything post unreviewed:

> If we let the agent's work post without line-by-line review, how many miscoded transactions are we signing up for, and how do we know?

The page lets the firm set the answer as a policy ("at most 1.0% miscoded, with 95% confidence"). Basis then finds the largest set of October transactions it can **certify** against that target, keeps a random audit sample of what posts, and pauses a client's bank or card feed as soon as the audit shows the certificate has stopped holding.

> Unofficial concept demo by Mohith Gajjela. Not affiliated with Basis. Synthetic data. No Basis code is used. The UI follows Basis's public design system (getbasis.ai / go.getbasis.ai CSS tokens: stone and ink palette, Geist, radii, shadows) and its own product illustrations; no in-app screenshots of the real Basis product are public, so the app shell is a reconstruction.

## Why this is hard

A confidence threshold is not a guarantee. LLM confidence is badly calibrated: on this synthetic firm, transactions the agent marks 99-100% confident are kept by reviewers 98.9% of the time, and the 98-99% bin only 94.7%. A hand-set "post if confidence ≥ 99%" rule posts 85% of October with 2.4% miscoded, and nothing tells you that until a reviewer finds it. Three things make a real certificate tricky:

1. **The rate you care about is conditional.** "Of what posts, how many are wrong" is a property of the cutoff you pick, and you pick the cutoff by looking at data. Picking it and then reporting its error rate on the same data is optimistic.
2. **Thresholds are many, so naive testing inflates errors.** Testing 95 cutoffs at 5% each and keeping the loosest one that passes is not a 5% guarantee.
3. **The guarantee assumes next month looks like last quarter.** A client switching card programs, a new bookkeeper or a model change breaks that, silently: the agent's confidence does not drop when it starts misreading a new descriptor format.

## How it works

1. **Risk score** (`core/guarantee.js`, `fitLogistic`). A logistic model combines the agent's confidence with ledger history the agent under-uses: has this client coded this vendor before, how many times, is there a firm coding rule, how ambiguous the vendor is (Amazon, Venmo, checks), how far the amount is from the vendor's norm, refunds. Fit on April-June only.
2. **Learn-then-Test certificate** (`learnThenTest`). A grid of cutoffs is fixed in advance from April-June (so it is independent of the test data). On July-September, every transaction reviewed, Basis tests H_j: "more than α of what cutoff j posts is miscoded" with an exact binomial p-value, from strictest to loosest, and stops at the first cutoff it cannot reject (fixed-sequence testing, which controls family-wise error at δ without a multiplicity penalty). The loosest rejected cutoff is certified: with probability at least 1 − δ, the miscode rate among future exchangeable transactions it posts is at most α (Angelopoulos, Bates, Candès, Jordan, Lei 2021).
3. **Anytime-valid audit monitoring** (`logMixtureLR`, `confSeq`). A random share (default 10%) of posted transactions is still reviewed. For every client bank and card feed, a beta-binomial mixture likelihood ratio against "rate = α" is a nonnegative martingale under the null, so by Ville's inequality it can be checked every day without inflating false alarms. When it crosses 1/δ_mon with an observed rate above α, that feed stops posting, its already-posted October transactions go back to review, and later ones are held.

Materiality is a hard rule: anything at or above a client's materiality threshold is always reviewed.

## What the demo data shows

`core/sim.js` generates a seeded synthetic CAS practice ("Hollis & Pryor CPAs"): 24 clients across dental, restaurants, construction, SaaS, professional services, retail and nonprofits, about 89,000 bank and card transactions from April to October 2026, the agent's coded account and confidence, and the reviewer outcome. The true miscode probability depends on vendor ambiguity, prior codings, firm rules, unusual amounts and refunds; the agent's confidence sees only part of that and is overconfident. On October 9, Kestrel Dental Group moves its cards to Amex and descriptors change format (`AMEX *HENRY SCHEIN INC`); the agent keeps its confidence while its error rate on that feed jumps.

On the demo seed with the default policy (α = 1.0%, 95% confidence, 10% audit):

| | Posted unreviewed | Miscoded among them |
|---|---|---|
| Certified cutoff + feed monitoring (this policy) | 9,029 of 12,697 | 85 (0.94%) |
| Certified cutoff, no monitoring | 10,566 | 218 (2.06%), broken by the Kestrel drift |
| Same test on agent confidence alone | 9,743 | 200 (2.05%) |
| Hand-set 99% confidence cutoff | 10,762 | 258 (2.40%) |

- The certificate covers 87% of July-September at a 0.88% observed rate (283 of 32,062, p = 0.017); the risk score ranks errors better than confidence alone (AUC 0.83 vs 0.77).
- The Kestrel card-feed monitor alarms on **Oct 19**: 280 posted transactions go back to review and 183 later ones are held; reviewers would change 121 of those 463. The pooled firm-wide monitor would not alarm until Oct 27, and would pause every client at once.

Repeated simulation (`node scripts/validity.mjs 200`, 200 fresh firms, no drift), share of firms where the true miscode rate of what posted exceeded the target (the certificate promises at most 5%):

| Target α | Certified share posted | Exceeded target | Same test, confidence only (share posted) | 99% confidence cutoff exceeded |
|---|---|---|---|---|
| 0.5% | 63% | 2.0% | 4% | 100% |
| 1.0% | 86% | 0.5% | 77% | 100% |
| 2.0% | 99% | 0.0% | 99% | 0% |

Every number on the page is computed in the browser from the generated data by the code in `core/`; the repeated-simulation table is read from `data/validity.json`, which `scripts/validity.mjs` writes.

## Run it

```
node --test test/guarantee.test.mjs   # 10 tests
node scripts/validity.mjs 200 > data/validity.json
python3 -m http.server                # then open http://localhost:8000
```

Tests cover the binomial tail and Clopper-Pearson bound, fixed-sequence stopping, repeated-draw validity of the Learn-then-Test certificate on a known risk curve, logistic recovery, AUC, the false-alarm rate of the mixture monitor under the null (≤ δ across 400 sequences), pipeline determinism and additive counts, drift detection on the Kestrel card feed with clean feeds quiet, and an end-to-end certificate check on fresh firms.

## Honest limitations

- **Synthetic data.** The size of the gain over confidence alone depends on how much useful signal the ledger history carries beyond the agent's own confidence; on Basis's real traffic it could be larger or smaller.
- **Labels are reviewer edits.** The certificate is about "a reviewer would change this", which treats July-September review as ground truth. Reviewers miss things too; a second-review sample would be needed to bound that.
- **Exchangeability.** The guarantee is for a population like the calibration quarter. Drift breaks it, which is why the monitor exists; the monitor detects drift on the audit sample, so a small feed with few audits is detected slowly (here, about ten days after the change on a 525-transaction card feed).
- **Firm-wide, not per client.** At α = 1% no single client has enough history for its own certificate, so the certificate is pooled and the per-feed monitors guard against one client hiding inside the pool. Per-client certificates would need hierarchical pooling or a looser α.
- **Counts, not dollars.** Errors are counted, not weighted by amount; the materiality rule covers large items. A dollar-weighted risk is a straightforward extension (bounded loss in Learn-then-Test).
- **Review time saved** uses an assumed 20 seconds per line.

## Novelty note

Checked on 2026-11-10: getbasis.ai solution pages (CAS, tax, audit, corporate accounting, small firms), the go.getbasis.ai transaction-coding and AI-agents pages and FAQ, the Basis blog index (including the behavior-specs post and the AI Engineer NYC 2026 "process supervision" talk) and press coverage. Basis describes pushing high-confidence transactions and flagging low-confidence ones, confidence levels, citations, and review before posting. I found no mention of a certified error bound on what posts, a randomized audit sample of auto-posted work, or anytime-valid drift monitoring per feed. Close-management tools (Numeric, FloQast, BlackLine, Ramp) describe matching, confidence thresholds and auto-certification within a tolerance, not a statistical guarantee. Learn-then-Test and conformal risk control are published methods (and have been applied to LLM routing and medical triage in research); the contribution here is applying them, with the monitoring loop, to AI-coded accounting work.
