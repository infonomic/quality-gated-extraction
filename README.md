# Quality-Gated Extraction

Companion repository for the paper **Cheap First, Escalate on Evidence: Quality-Gated
Extraction for Heterogeneous Research Collections**, by Anthony Bouch (Infonomic) and
Steve Elliott (Forest Restoration Research Unit, Chiang Mai University), accepted as a
demo/poster paper at [ICADL 2026](https://icadl.net/icadl2026/), Khon Kaen University,
2–4 December 2026, to appear in the Springer LNCS proceedings.

## Status

**Release pending.** The materials below will be published here before the conference
(2–4 December 2026), alongside the live demonstration. Until then this repository is a
placeholder so that the address printed in the paper is stable.

## What will be published

- The post-extraction quality gate implementation: the five component scorers
  (character sanity, text retention, usable-page ratio, structural yield, script
  consistency) and the routing policy that acts on them.
- The frozen policy configuration and thresholds used in the paper, with the policy
  hash reported there, so the evaluation can be reproduced against the same gate.
- The document inspection signals and tier-assignment rules.
- Sanitised routing traces from the benchmark, including the F003 replay shown in the
  paper's figure: inspection signals, assigned tier, gate scores and reasons, escalation
  steps and provider provenance, with document content redacted.
- The human-oracle annotations for the 32 held-out evaluation pages on both criteria
  (reading sufficiency, structural adequacy), and the calibration-set annotations.
- Derived benchmark tables: the policy comparison, per-tier timings and the
  higher-tier degradation cases.

## What will not be published

The source PDFs. The benchmark corpus is the working repository of the Forest
Restoration Research Unit at Chiang Mai University; its documents are not redistributed
here. Where a document is publicly available it is identified by a stable reference.

## Citation

A citation entry with the Springer DOI will be added when the proceedings appear.

## Licence

To be confirmed on release. Code and configuration are expected to be released under
an open-source licence and the annotations and traces under an open data licence.

## Contact

Anthony Bouch, Infonomic — anthony@infonomic.io
