# Quality-gated extraction — release artefacts

Companion release for *Cheap First, Escalate on Evidence: Quality-Gated
Extraction for Heterogeneous Research Collections* (Bouch, Lipsky and Elliott,
ICADL 2026, demo/poster track).

This repository publishes what the paper commits to in §5: the quality-gate
implementation, the frozen routing and gate policies with their thresholds,
sanitised routing traces from the evaluation run, and the two-axis oracle
annotations. Source documents from the FORRU-CMU repository are not
redistributed, and no extracted text appears here. Documents and pages are
identified by case ID and content hash only.

## Frozen artefacts and their hashes

Every number in the paper traces to `results/phase5-paper-20260806/`, which
records the hashes below. `node tools/verify-release.mjs` recomputes them.

| Artefact | File | SHA-256 |
|---|---|---|
| Gate policy (paper §3.2) | `policy/gate-calibration.frozen.json` | `3f8d9674a8ecbb39a17bb1aeab4fe77e814fef0de8c693965064a0d54685cd8d` |
| Initial routing policy | `policy/routing-calibration.frozen.json` | `c1f14b50218c6ccb242af166ad660ea1bcb9af64e8b9f86d0c9c30985e9976fb` |
| Gate calibration contract | `config/gate-calibration-v1.json` | `3de5171cf9b78c04431dfb3130c20d5c5422b5b80926959919ec4498c437bdc3` |
| Evaluation oracle (32 pages) | `annotations/oracle-evaluation.json` | `70d6d9a266cc87b6d886e0b582c67be5d0db8ad1df12564b8a3d8e93fd2e792b` |
| Calibration oracle (16 pages) | `annotations/oracle-calibration.json` | `28cdd730f8e3175e560c985028cd4f3d8038cfb790fc388c6f142e6cf0bcd055` |

The gate policy hash is `sha256` of the canonical JSON of
`gate-calibration.frozen.json` with its `policyHash` field removed. The frozen
thresholds are character sanity 0.99, text retention 0.75, usable-page ratio
0.75, structural yield 1.0 and script consistency 0.95.

## Layout

- `src/` — inspection signals, quality gate, routing policies, calibration,
  policy analysis and paper-value export, with unit tests on synthetic fixtures.
- `policy/` — the two frozen policy files, verbatim from the evaluation run.
- `traces/policy-analysis.json` — the routing trace for the 16 evaluation
  documents: initial tier and rationale, each gate step with component scores,
  escalation reasons and the selected tier. `traces/cells/` and
  `traces/t3-page-cells/` hold the per-cell provider and timing records
  (72 T0–T2 document cells, 48 T3 page submissions); the `*.jsonl` files are
  the raw run logs behind the timing summaries.
- `annotations/` — the folded oracle judgements per page (reading sufficiency
  and structural adequacy, lowest passing tier on each axis, degraded tiers),
  the page manifest with image hashes, and `ORACLE-RUBRIC.md` at the root.
- `results/` — the sanitised aggregate results by phase, including the
  labelled paper values and CSV tables.
- `schemas/` — JSON Schemas for every artefact above.
- `ROUTING-FLOW.md` — the cheap-first routing and escalation policy as a diagram.
- `HARDWARE-CONTEXT.md` — the measurement machine, what ran on GPU versus CPU,
  and which timing conclusions survive a change of hardware.
- `PROVIDER-RUNBOOK.md` — pinned provider versions, service settings and the
  resolved model commits behind the evaluation run.

## Running the code

The benchmark was developed inside a pnpm workspace. `src/corpus.ts` and
`src/providers/tika.ts` import the workspace package `@byline/extract-tika`
and `pg`, which are only needed to read a live corpus; the gate, routing,
calibration and analysis modules and their tests do not. Tier providers
(Docling, Tesseract, PaddleOCR-VL) run as local services; see
`PROVIDER-RUNBOOK.md`.

## Licence

Copyright (C) 2026 Infonomic Company Limited and Chiang Mai University
Forest Restoration Research Unit.

This repository is released under the GNU Affero General Public License,
version 3 (see `LICENSE`). It is a research-results release: the code is
published so that the benchmark can be inspected and reproduced, not as a
maintained library. Source documents from the FORRU-CMU repository are not
part of this release and are not covered by this licence.
