# ICADL 2026 extraction benchmark — paper values

**Status:** final labelled export for reviewer and paper-drafter handoff  
**Source run:** `phase3-matrix-20260805`  
**Gate policy:** `3f8d9674a8ecbb39a17bb1aeab4fe77e814fef0de8c693965064a0d54685cd8d`

## Headline policy result

On the 32 held-out oracle pages, quality-gated routing reduced unsafe acceptance compared with static inspection routing:

- reading sufficiency: 37.5% (12/32) → 28.1% (9/32);
- structural adequacy: 50.0% (16/32) → 40.6% (13/32).

It also increased unnecessary escalation:

- reading sufficiency: 28.1% (9/32) → 43.8% (14/32);
- structural adequacy: 6.3% (2/32) → 40.6% (13/32).

This is a safety/quality trade-off, not an observed end-to-end affordability win. Gated routing selected T3 for 9/16 documents, but T3 was measured only as independent pages. Complete gated full-document time and cost are therefore unavailable.

## Corpus regimes

- 284 publication records supplied 341 readable PDF attachments spanning 19,559 pages.
- 231/341 PDFs had at least 95% text-layer coverage.
- 81/341 had less than 10% text-layer coverage.
- The remaining 29/341 lay between those cut-points.

## Cache and gate contracts

Extraction artifacts are content-addressed by source hash, provider identity and version, model, canonical parameter hash and representation schema version. The replay's cache trace exposes this provenance; corpus-wide cache savings were not evaluated. The gate accepts an artifact only when every available component meets its frozen minimum, while unavailable optional evidence remains null rather than becoming zero.

## Frozen gate

- Calibration: 8 documents / 16 pages; 10 English, 4 mixed and 2 Thai pages.
- Thresholds: character sanity 0.99; text retention 0.75; usable-page ratio 0.75; structural yield 1.0; script consistency 0.95.
- Calibration errors over 24 document-tier examples per axis: reading false accepts 1, false rejects 6; structural false accepts 3, false rejects 6.
- The script-consistency threshold is weakly determined because calibration contains only two Thai pages.

## Tier selection

| Policy | T0 | T1 | T2 | T3 | Scope |
| --- | ---: | ---: | ---: | ---: | --- |
| All T0 | 16 | 0 | 0 | 0 | 16 evaluation documents |
| Static inspection | 4 | 4 | 8 | 0 | 16 evaluation documents |
| Quality-gated | 4 | 0 | 3 | 9 | 16 evaluation documents; T3 quality page-sampled |

## Reliability and non-monotonicity

- T3 provider completion: 48/48 page requests; serious human-observed defects: 6/48. These are different quantities.
- Higher-tier degradation: calibration 2/16; evaluation 7/32. Across both separately reported passes, all 9 degraded tiers were T2.
- T2 Thai short-run density: 9,091/10,746 (84.6%) on seven substantive-Thai evaluation pages. This is not a glyph-error rate.

## Timing and cost language

- T0/T1/T2 mean full-document wall times across the 24-document matrix: 0.34 s / 30.95 s / 128.75 s.
- T3 evaluation mean: 63.95 s/page over 32 independent CPU-only page submissions.
- All-T3 corpus projection on that measured configuration: 347.5 hours. This is projected, not observed.
- Machine-time dollar values are declared comparison proxies, not invoices or energy measurements.

## Claim audit

The paper must change or avoid any prose claiming:

1. an observed full-document time/cost saving for gated routing;
2. that gated routing outperformed static routing on every metric;
3. that T3 was evaluated as a full-document policy arm;
4. that 48/48 provider completion means 48/48 usable output;
5. that 84.6% is a Thai glyph-error rate;
6. that the gate re-compares an escalated artifact with the lower-tier artifact it left;
7. real-document CER/WER or element-level structural precision/recall/F1;
8. billed spend, energy reduction, retrieval improvement or production readiness; or
9. fully blinded threshold development—the calibration/evaluation data are separate, but evaluation examples were inspected before the final gate freeze.

## Files

- `paper-values.json`: schema-validated values and source hashes.
- `figures/policy-comparison.csv`: page-level quality comparisons.
- `figures/tier-distribution.csv`: document-level selected tiers.

Every numeric JSON value carries a numerator, denominator and excluded count. Values marked unavailable remain null.
