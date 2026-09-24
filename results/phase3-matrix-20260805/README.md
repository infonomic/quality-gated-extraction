# Phase 3 aggregate timing evidence

This directory contains safe, anonymised aggregates generated from the private
Phase 3 provider cells. It contains no provider text, page image, source alias,
filename, URL or storage path.

`timing-summary.json` covers document-level T0–T2 execution across the frozen
eight-document calibration and sixteen-document evaluation sample. The one T3
full-document attempt is reported only as a censored lower bound; it contributes
neither a completed mean nor a cost proxy.

`t3-page-timing-summary.json` covers the separately predeclared T3 page scope:
16 calibration pages and 32 held-out evaluation pages. All 48 calls completed
with provider status `succeeded`; this is not an output-usability claim. The
summary reports client-observed local wall time because Paddle exposes no
provider duration. It keeps the four evaluation strata at eight pages each and
labels those values as sampled page results, not population rates or
full-document T3 timings. The separate Phase 4 human audit records output
defects and Criterion B usability.

The private source of truth remains below ignored
`work/phase3-matrix-20260805/`, including the frozen declaration, its SHA-256
manifest, page cells, raw normalised artifacts and rasterised inputs.
