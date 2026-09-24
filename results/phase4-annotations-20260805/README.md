# Phase 4 annotation and metric checkpoint

This safe checkpoint contains no source text, titles, paths or provider output.
The private pack contains the 32 predeclared evaluation pages, eight per
stratum. All 32 two-axis judgements are folded into schema-valid private
records. The progress validator reports 32/32 oracle pages complete, so the
policy-quality analysis gate is open. This checkpoint does not run that
analysis.

Reading sufficiency and structural adequacy are required independent oracle
axes, each retaining all passing tiers and a derived cheapest tier. Their rates
remain separate and no subset relation is enforced. Element-level structure and
exact text are separate evidence scopes: oracle-only records cannot enter
element-level structural precision/recall. Optional partial structure carries the
predeclared `table-header-first-five-rows-and-all-non-body-v1` rule and supports
sampled recall/counts, not full-page precision/F1. Real-document CER/WER is
unavailable rather than backed by rushed degraded-table or Thai transcription;
the known-reference Phase 1 synthetic control remains available.

`oracle-consistency-audit.json` records the completed 32/32 consistency pass.
Higher-tier degradation is mechanically derived from gaps on either oracle
axis: seven pages (7/32) have a rejected tier between cheaper and more expensive
accepted tiers, and that tier is T2 in all seven. F023 page 15 documents the
single structural-over-reading divergence for T2. Six accepted near-empty tier
outputs belong to four genuinely sparse pages, including F313 page 16, so they
are not failures under a content-relative reading-sufficiency rubric.

Implemented checked-in contracts:

- CER/WER machinery with frozen Thai, English and mixed-script normalisation,
  including symmetric HTML-tag removal and paired-math-delimiter unwrapping in
  versioned `text-comparison-v2`, used only when an exact reference exists;
- 0.90 same-type structural matching;
- executable versioned structure-aware and fixed-token chunking;
- split errors over join opportunities and merge errors over break
  opportunities;
- false accepts and false escalations reported independently from the human
  reading-sufficiency and structural-adequacy labels;
- separate raw wall, fixed overhead, marginal duration, T0 ratio, billed usage
  and disclosed machine-time proxy values;
- cached policy simulation that excludes unavailable arms without imputation
  and keeps the sampled all-T3 page baseline separate from document policies.

Task 5.2 is a sanitised routing trace, not the source-bearing adjudication UI.
F318 demonstrates escalation harming output; F152 page 5 is the rescue case.
F313 page 27 is a T3 repetition-loop failure retained to audit the existing
character-sanity component, not a rescue. No routing or gate semantics were
changed. Bidirectional artifact comparison remains Phase 7 work.

The earlier image-only exemption is retracted. Visual review confirmed that the
five pages used to infer it all contain text, and one is calibration rather
than evaluation. Provider image markup is a classification, not page ground
truth. Criterion B therefore rejects dropped visible text normally. F067 page
3 supplies a T2→T3 non-monotonic example; F067 page 27 is a four-tier failure;
F131 page 85 and F236 page 1 show T3 successfully recovering caption or Thai
cover text. No rubric, routing or gate exception was added.

The raw-artifact audit is in `f313-character-sanity-audit.json`. F313 page 27
scores 1.0 and therefore is not flagged at the provisional 0.95 diagnostic
threshold: the current component catches long identical-character runs, not
this spaced-symbol loop. F313 is held-out evaluation evidence, so the result is
a diagnostic and cannot tune the component or threshold.

`f003-generation-collapse-audit.json` records the third observed T3 failure
mode. F003 page 40 retained only 230 code points against 2,623 inspected text
characters after 442,776 ms, despite T0, T1 and T2 all populating the page. The
existing text-retention component scores 0.0877 and would flag it at the
provisional 0.50 fixture threshold. F003 is also held-out evaluation evidence;
the check validates detector intent but does not authorise threshold tuning.

`t3-output-reliability-audit.json` separates provider completion from output
quality. All 48 T3 page calls have provider status `succeeded`, while manual
page/output review identified six serious defects (6/48, 12.5%): three
degenerate repetitions, two text-bearing regions classified as images, and one
generation collapse. This sampled human audit is not the Criterion B pass rate
and does not rewrite provider statuses.

`t2-script-conditioned-failure-audit.json` records two separate forced-OCR
failure modes. Seven substantive-Thai evaluation pages have a tightly clustered
short-Thai-run density of 0.824–0.878; the aggregate is 9,091 short runs over
10,746 Thai code points (84.6%). This is a run-density metric, not a claim that
84.6% of glyphs were counted as fragmented. Separately, four figure pages carry
201, 87, 38 and 22 page-attributable text items of at most two code points.
T1's split Latin ligatures are not part of either T2 mode; no such split was
observed in T2.

The current `scriptConsistency` score does not detect Thai spacing because the
Thai codepoints and their proportion remain present. Policy v1 is unchanged.
Phase 7 should combine page-level script evidence with a calibrated
fragmentation detector and route failed substantive-Thai T1 output directly to
T3 when supported, rather than treating T2 as the universal text-failure target.

Verification at this checkpoint: 106 tests across 26 files, repository TypeScript
typecheck, Biome check and `git diff --check` pass. The updated adjudicator also
served all four tiers for the first frozen page in a read-only loopback smoke
test. The safe aggregate status is in
`annotation-status.json`; private images, provider outputs, oracle, manifest and
annotations remain ignored by Git.
