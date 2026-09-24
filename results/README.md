# Sanitised results

Only aggregate, anonymised benchmark outputs appear here. Raw provider output,
source-derived text and diagnostic dumps were kept in a private working tree
and are not part of this release. Documents are identified by case ID and
content hash only.

`phase2-authoritative-20260805/` contains the frozen sample summary and the
Phase 2 T3 planning budget. The sample summary and no-fallback decision are
observed. Every T3 duration in the budget is labelled projected; the warm
one-page controls, the inferred one-time cold-start surcharge and the lack of
provider-side Paddle timing are stated in its limitations. The projection is
preserved as historical planning evidence and was superseded by the observed
Phase 3 timings; it is not the current full-document forecast.

`phase3-matrix-20260805/` contains the aggregate timing summaries from the
completed provider work. `timing-summary.json` covers the 72 provider-succeeded
T0–T2 document cells plus the separately reported censored full-document T3
observation. `t3-page-timing-summary.json` covers the 48 provider-succeeded
page-wise T3 submissions and keeps calibration, evaluation and all four
evaluation strata separately denominated. The per-cell records, run logs,
page-subset declaration and revised 48-page budget behind these summaries are
published in `../traces/`. Human-observed output reliability is a separate
Phase 4 result and must not be inferred from provider completion status.

`phase4-annotations-20260805/` records the completed-oracle status and the
sampled reliability audits. It contains no ground truth or source text; the
folded oracle judgements themselves are in `../annotations/`.

`phase5-paper-20260806/` is the authoritative paper handoff. It contains
schema-validated, labelled values with source hashes, a prose claim audit and
the CSV policy and tier tables behind the paper's Tables 1 and 2. The gated
full-document time and cost remain explicitly unavailable because selected T3
arms were evaluated as independent pages.
