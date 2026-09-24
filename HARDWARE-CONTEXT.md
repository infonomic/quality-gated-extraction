# Hardware context for the timing results

**Measurement date:** 5 August 2026

**Purpose:** record which measurements in this release are properties of the
extraction tiers and which are artefacts of the machine they were taken on.
Several headline ratios change by more than an order of magnitude on
accelerated hardware, and the paper does not present those as tier properties.
This note explains why.

## Measurement environment

Recorded by the benchmark's environment capture, not transcribed by hand:

| Fact | Value |
| --- | --- |
| CPU | Apple M5 Max, 18 logical cores |
| Memory | 128 GiB |
| Platform | darwin 25.6.0, arm64 |
| Accelerator recorded in manifest | `null` |
| Concurrency | 1 (`config/default.json` → `execution.concurrency`) |

## What actually used the GPU

| Tier | Provider | Accelerator | Evidence |
| --- | --- | --- | --- |
| T0 | Apache Tika 3.3.0 | none, and none needed | JVM text-layer read |
| T1 | Docling, layout only | **MPS** | startup log: `Accelerator device: 'mps'`, `Transformers engine ready (device=mps)` |
| T2 | Docling, forced OCR | layout on MPS; **OCR stage on CPU** | `ocr_preset=tesseract`; tesseract has no GPU path in any configuration |
| T3 | PaddleOCR-VL-0.9B | **none — one CPU core** | wheel installed from `paddlepaddle.org.cn/packages/stable/cpu/`; started `--device cpu`; no Metal/MPS, CUDA or XPU device exposed |

Two consequences worth stating plainly:

- **T2's recognition stage never touched the GPU.** Docling accelerates layout,
  but the recognition stage is tesseract, which is CPU-only and single-threaded
  per page. This is not a configuration mistake; it is what the pinned OCR
  preset is.
- **T3 ran entirely on one logical core**, roughly 6% of the available CPU and
  none of the GPU. The machine was close to idle for the majority of elapsed
  benchmark time.

### Concurrency 1 was deliberate

Per-document wall time cannot be attributed under parallel load. Pinning
concurrency to 1 is what makes statements like "F085 cost 629 s at T2"
meaningful, and it is why the per-stratum cost analysis exists at all.

**Every duration in this release is single-stream latency, not throughput.**
Nothing here measures what the machine can do when saturated.

## Measured per-page rates

Document tiers, over 24 sampled documents / 2,054 pages:

| Tier | ms/page |
| --- | ---: |
| T0 | 3.9 |
| T1 | 361.6 |
| T2 | 1,504.4 |

T3, page-image submissions at 128 DPI, CPU-only:

| Observation | s/page | n |
| --- | ---: | ---: |
| Evaluation pages | 64.0 | 32 |
| Calibration pages | 112.5 | 16 |
| Dense single-page diagnostic | 39.4 | 1 (11 regions) |
| Censored full-document lower bound | ≥146.1 | 1 document, 10 pages |

Calibration and evaluation page rates differ by ~1.8×. They are reported
separately throughout and should not be pooled into a single T3 page rate.

T2 at 1.5 s/page is ordinary tesseract-on-CPU speed. The long wall-clock times
in this benchmark come from document length — the sampled documents average 86
pages — not from unusual per-page cost.

### Per-stratum timing does not identify the page-level cost driver

Evaluation pages, 8 per stratum:

| Stratum | s/page |
| --- | ---: |
| born-digital-en | 42.0 |
| scanned-degraded-en | 58.8 |
| scanned-degraded-thai-mixed | 60.3 |
| layout-heavy-born-digital | **94.7** |

These are raw groups defined by document-level inspection, not verified labels
for the selected pages. Manual inspection found plain prose among the checked
`layout-heavy-born-digital` pages, while the densest tables were F152 in
`scanned-degraded-en` and the two-column figure page was F196 page 5 in
`born-digital-en`. The implementation recognises detected regions, but this run
does not contain a page-level region-count analysis that can attribute the
timing spread. Neither "Thai OCR is slow" nor "layout-heavy pages are slow" is
supported by these stratum totals.

## Full-corpus projections

341 documents, 19,559 pages, at the measured single-stream rates. **Projected,
not observed** — no full-corpus run has been performed.

| Policy | Time |
| --- | ---: |
| All-T0 | 1.3 min |
| All-T1 | 1.96 h |
| All-T2 | 8.2 h |
| All-T3 | **348 h ≈ 14.5 days** |

No projection is given for the gated policy. Routing selected the page-sampled
T3 arm for 9 of 16 evaluation documents, so a gated full-document time and cost
are unavailable rather than estimated; the paper says the same.

## Which conclusions are hardware-stable

### Stable — survive any deployment

- The ordering of tier costs.
- **T2/T1 ≈ 4.2×.** Tesseract has no GPU path, so this ratio does not move.
- PaddleOCR-VL performs visual layout and recognition regardless of whether a
  usable text layer already exists; the selected-page timing driver is not
  established by the document strata.
- **Non-monotonicity**: escalation can degrade output (F318 — T1 read clean Thai
  from the text layer; T2 force-OCR'd it into space-separated glyphs). This is a
  correctness property, not a speed property, and no accelerator changes it.
- All-T3 over a full collection is infeasible *on this class of hardware*.

### Not stable — artefacts of CPU-only T3

The measured T3/T1 ratio of 177× and T3/T2 ratio of 42.5× are properties of a
single-core, unaccelerated T3. No GPU run has been performed, and this release
contains no GPU figures. A reader with access to VLM inference on a current
accelerator should expect these ratios to shrink by one to two orders of
magnitude, to the point where T3 costs roughly the same as T2. The
escalation-cost argument therefore depends on deployment hardware.

### Why non-monotonicity is load-bearing

The cost argument and the correctness argument have different lifespans.

If T3 becomes only ~2× T2, "just always escalate" becomes a defensible
engineering position — **unless** escalating can make output worse. F318 shows
it can. That argument does not weaken as accelerators get cheaper, which is why
the paper gives the two comparable weight.

## Implications for a production router

The tier economics point at a specific architecture:

- **T0 and T1 are cheap enough to run inline and synchronously** on commodity
  CPU — 3.9 ms and 362 ms per page. No GPU, no queue.
- **T2 is CPU-bound but embarrassingly parallel** across pages. A worker pool
  scales it horizontally; no special hardware.
- **T3 is the only tier that justifies a GPU**, and the routing thesis is
  precisely that it is rarely reached. One small shared GPU pool serving
  escalations across many collections, rather than GPU capacity sized for the
  whole corpus.
- **The content-addressed cache compounds this**: the T3 cost for a given
  document is paid once, ever, across every collection referencing it.

The benchmark's own configuration constraints are therefore not production
guidance. Concurrency 1 and a CPU-only T3 are measurement conditions.

## How to read the paper's timings

1. Hardware: Apple M5 Max, 18 cores, 128 GiB, no accelerator used for T3,
   concurrency 1.
2. Tier ratios are as measured on this configuration, not properties of the
   tiers.
3. T2's recognition stage and T3 in full ran on CPU by configuration.
4. All full-corpus figures are projections from a sampled matrix.
5. The three T3 denominators (32 evaluation pages, 16 calibration pages,
   1 censored full-document lower bound) are never merged.

## Related

- `PROVIDER-RUNBOOK.md` — service configuration, including the
  `DOCLING_SERVE_MAX_SYNC_WAIT` censoring finding and the resolved model commits.
- `traces/t3-page-budget.json` — the page-subset budget and its labelled
  `observed` / `censored` / `projected` fields.
