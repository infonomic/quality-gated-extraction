# Phase 2 authoritative result

This sanitised bundle is linked from the private authoritative manifest
`work/phase2-authoritative-20260805/run.json`.

Observed corpus results:

- 284 current publication documents;
- 344 declared publication attachments;
- 341 readable PDFs and three explicitly excluded non-PDF attachments;
- zero unreadable PDFs;
- 19,559 inspected PDF pages;
- identical corpus and inspection SHA-256 hashes on the cached rerun.

The observed attachment split exactly reproduces the earlier migration record
of 341 PDF extractions and three non-PDF files. It was not adjusted to match.

The frozen sample is eight calibration plus sixteen disjoint evaluation
documents, with two and four documents per stratum respectively. Its exact
denominators are 2,054 provider-matrix pages and 32 annotated evaluation pages.
All 24 selected cases received a visual stratum check. One preliminary
Thai/mixed assignment was an English scan carrying a repeated Thai university
watermark; the private audit records its reassignment and the seeded selection
was repeated. No evaluation fallback is applied.

`t3-budget.json` is a planning projection, not an observed corpus timing. It
uses the 7.532-second observed warm scanned rate plus one inferred
30.968-second cold-start surcharge per service process. This produces a
4.31-hour primary projection for the complete sample. The earlier 38.5-second
one-page observation is retained as cold-start evidence rather than multiplied
by every page. PaddleOCR-VL provider compute time remains unavailable.

**Superseded for feasibility planning on 5 August 2026:** the rate came from a
sparse one-page control. A later dense, text-native 10-page calibration request
on the verified CPU-only macOS runtime exceeded 24 minutes 21 seconds before
diagnostic cancellation; the server continued computing after the client
disconnected. The JSON is retained unchanged as the original labelled
projection, but its 4.31-hour figure must not be presented as the expected
all-tier sample runtime. The frozen sample remains unchanged and evaluation was
not opened while a reviewed T3 scope decision is pending.
