# Human oracle: reading sufficiency and structural adequacy

This rubric defines the two independent human judgements used for the ICADL
submission benchmark. They are frozen as `reading-sufficiency-v1` and
`structural-adequacy-v1` before policy-quality analysis.

## Reading sufficiency

Accept a tier's output for a page when a reader could obtain the page's content
from it without material loss or corruption:

- all substantive content blocks are present;
- reading order preserves meaning;
- characters are correct;
- lost table structure is acceptable only when values remain readable, ordered
  and attributable to their rows;
- running headers, folios and hyphenation artefacts are ignored.

Reject an output when:

- substantive blocks are missing or empty;
- columns are interleaved so sentences run into unrelated text;
- characters are corrupted through replacement glyphs, wrong script or
  systematic substitutions;
- table values are no longer attributable to a row.

Structural fidelity is not required by this criterion. It is judged separately
under structural adequacy below.

## Two-pass separation

1. Any content or structural annotation is created from the page image alone,
   without consulting tier outputs.
2. Oracle adjudication compares the image with T0–T3 outputs, but takes place
   before metrics or policy results are opened.

For reading sufficiency, the adjudicator records every accepted tier in
`usableTiers` and derives `lowestUsableTier` using measured cost order
`T0 < T1 < T2 < T3`. A non-contiguous set such as `T1,T3` is valid and
preserves non-monotonicity.

Application note (not a rubric change): an extractor's image tag or picture
classification is not evidence that a page contains no text. Illustrated pages,
covers, figures and comics may contain captions, labels or hand-lettered text.
Judge visible substantive text from the page image; reject a tier that drops it
under the ordinary missing-content rule.

## Structural adequacy

Accept a tier under `structural-adequacy-v1` when the page structure survives
well enough to drive section-aware chunking, table attribution and retrieval:

- headings remain recoverable as headings rather than folded into body text;
- table cells remain attributable to their row and column;
- captions remain distinguishable from surrounding body text; and
- reading order remains correct across columns and around floats.

Reject it when structure is flattened into an undifferentiated run, table
values lose their row/column attribution, captions merge into body text, or
column/float order is scrambled.

The adjudicator records every passing tier in `structurallyAdequateTiers` and
derives `lowestStructurallyAdequateTier` in the same measured cost order. The
array is required and never defaulted; the UI requires explicit confirmation
when no tier passes. Reading sufficiency and structural adequacy are independent:
neither tier set must be a subset of the other, and the two rates are reported
separately. Their divergence is evidence, not an inconsistency.

The confirmation is persisted as `structuralAssessmentConfirmed: true` in each
judgement and folded annotation. Its presence proves Criterion C was actively
assessed; it does not assert that any tier passed.

Higher-tier degradation is not a third human judgement. The tool derives
`degradedTiers` from any tier rejected between the cheapest and most expensive
accepted tier on either axis, then derives `higherTierDegraded` from whether
that list is non-empty. The UI presents this as a readout, and annotation
validation rejects stored derived fields that disagree with the two tier sets.

The adjudication UI exposes a typed, page-scoped structural view for each tier.
This human adequacy axis is distinct from the optional element-level structural
annotation below: Criterion C can be complete even when `structuralScope` is
`unavailable` and detailed precision/recall cannot be calculated.

## Optional element-level structural rule

The predeclared rule is
`table-header-first-five-rows-and-all-non-body-v1`:

- annotate every heading, caption and reference on the page;
- for every table, treat the topmost visible row as the header and annotate all
  its cells plus all cells in the next five visible rows, or all remaining rows
  when fewer than five exist;
- record a spanning cell once when it intersects the sampled rows;
- omit body prose and every table row outside the sample;
- create boundary opportunities only between sampled elements.

This scope supports sampled element counts, sampled table-cell recall and
sampled boundary errors. Full-page table precision and structural F1 are
unavailable unless provider output can be restricted to the same sampled
regions. Results must retain the rule identifier and exact sampled denominator.

## Text-reference decision

Exact real-document transcription is unavailable for this submission because
half the pages are degraded scans, including dense tables, and the Thai/mixed
subset requires specialist transcription. A hurried manual reference would
bias CER/WER. Character accuracy therefore uses only the Phase 1 synthetic
control whose reference is known by construction; F318 remains qualitative
real-document evidence.
