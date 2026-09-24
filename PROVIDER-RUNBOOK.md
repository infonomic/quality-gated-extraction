# Local Docling and PaddleOCR-VL runbook

This runbook starts the two local HTTP services used by the ICADL extraction
benchmark on the Apple Silicon development host. Keep both services bound to
loopback so benchmark files remain on the machine.

Run setup commands from any directory. Run the benchmark commands from the
repository root.

## Shell requirement

The development host's default interactive shell is Fish, but the commands in
this runbook use Bash syntax. Start a Bash subshell in every terminal used for
installation, provider startup or benchmark commands:

```bash
bash
```

Run the documented commands inside that subshell. Use `exit` to return to Fish
after stopping the service or completing the command. Do not paste the Bash
variable-assignment blocks directly into Fish.

## Known-working stack

The provider matrix completed successfully on 2026-08-05 with:

| Component | Version |
| --- | --- |
| Python | 3.12.13 |
| Tesseract | 5.5.2 with `eng` and `tha` data |
| Docling Serve | 1.29.0 |
| Docling | 2.118.0 |
| PaddleOCR | 3.7.0 |
| PaddlePaddle | 3.2.1 |
| PaddleX | 3.7.2 |
| PaddleOCR-VL model | `PaddleOCR-VL-0.9B` |

Use separate virtual environments because Docling and PaddleOCR have different
Python and inference dependencies. PaddleOCR's official Docker deployment is
not the Apple Silicon path; use the manual Python installation below.

Upstream references:

- [Docling installation](https://docling-project.github.io/docling/getting_started/installation/)
  and [API server deployment](https://docling-project.github.io/docling/usage/api_server/deployment/);
- [PaddleOCR-VL Apple Silicon deployment](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html).

## First-time setup

Install Python 3.12 and the English and Thai Tesseract language data:

```bash
brew install python@3.12 tesseract tesseract-lang

/opt/homebrew/bin/python3.12 --version
tesseract --list-langs | rg 'eng|tha'
```

The language check must list both `eng` and `tha` before running the T2 probe.
Do not use the system Python 3.14 environment for these providers.

### Install Docling Serve

```bash
DOCLING_VENV="$HOME/.local/share/forru-extraction/docling"

/opt/homebrew/bin/python3.12 -m venv "$DOCLING_VENV"
"$DOCLING_VENV/bin/python" -m pip install --upgrade pip
"$DOCLING_VENV/bin/python" -m pip install "docling-serve[ui]==1.29.0"
```

### Install PaddleOCR-VL

```bash
PADDLE_VENV="$HOME/.local/share/forru-extraction/paddleocr-vl"

/opt/homebrew/bin/python3.12 -m venv "$PADDLE_VENV"
"$PADDLE_VENV/bin/python" -m pip install --upgrade pip
"$PADDLE_VENV/bin/python" -m pip install \
  paddlepaddle==3.2.1 \
  -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
"$PADDLE_VENV/bin/python" -m pip install "paddleocr[doc-parser]==3.7.0"
"$PADDLE_VENV/bin/paddlex" --install serving
```

The first provider start downloads model artifacts and needs internet access.
Subsequent starts reuse the local model cache.

## Start the services

Use two terminal tabs and leave both commands running during provider work.

### Terminal 1: Docling on port 5001

```bash
DOCLING_VENV="$HOME/.local/share/forru-extraction/docling"

TESSDATA_PREFIX=/opt/homebrew/share/tessdata/ \
DOCLING_DEVICE=mps \
DOCLING_SERVE_MAX_SYNC_WAIT=1800 \
DOCLING_SERVE_SYNC_POLL_INTERVAL=1 \
UVICORN_HOST=127.0.0.1 \
UVICORN_PORT=5001 \
"$DOCLING_VENV/bin/docling-serve" run
```

Both `DOCLING_SERVE_*` values override defaults in
`docling_serve/settings.py` and are required for benchmark work:

- `max_sync_wait` defaults to `120` seconds. Any document needing more
  conversion time than that returns `504 Gateway Timeout` regardless of the
  client timeout, which silently censors the slowest documents from the
  matrix. `1800` clears the slowest observed calibration case with margin.
- `sync_poll_interval` defaults to `2` seconds, which quantises every
  client-observed wall time onto a two-second grid. The setting is typed
  `int`, so `1` is the floor and quantisation is reduced rather than removed.
  Use the artifact's `providerMs` as the Docling duration and treat wall time
  as fixed overhead plus a marginal component; never report an unqualified
  Docling wall time as extraction duration.

### Terminal 2: PaddleOCR-VL on port 8080

```bash
PADDLE_VENV="$HOME/.local/share/forru-extraction/paddleocr-vl"

"$PADDLE_VENV/bin/paddlex" \
  --serve \
  --pipeline PaddleOCR-VL \
  --device cpu \
  --host 127.0.0.1 \
  --port 8080
```

Stop either service with `Ctrl-C` in its terminal. Do not bind either service
to `0.0.0.0` for benchmark work. The verified macOS PaddlePaddle wheel exposes
CPU only; `--device cpu` makes that execution environment explicit rather than
enabling an accelerator.

## Check health and versions

Run these checks from another terminal:

```bash
curl -fsS http://127.0.0.1:5001/health
curl -fsS http://127.0.0.1:5001/version
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/openapi.json \
  | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["info"]["version"])'
```

Docling should report `status: ok`. PaddleOCR should report `errorCode: 0`.
Both ports must be listening on `127.0.0.1`:

```bash
lsof -nP -iTCP:5001 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

### Confirm the OCR engine actually used

Docling startup logs report an *auto-selected* server default, currently
`Auto OCR model selected rapidocr with torch`. The benchmark adapter overrides
this per request with `ocr_preset=tesseract` and explicit `ocr_lang` values, so
the startup line does not describe T2. RapidOCR's bundled PP-OCRv6 weights do
not cover Thai; if the preset override ever stops applying, Thai recognition is
lost silently while requests keep succeeding.

Confirm the engine on the first T2 request after any restart by watching the
server log for tesseract rather than rapidocr, and confirm the Thai control
still returns Thai script. Do not infer the engine from the startup banner.

Note also that `DOCLING_DEVICE=mps` applies to layout and table models; the
OCR stage runs on CPU.

### Record the resolved model revisions

Docling starts with `artifacts_path` unset and resolves model weights from
HuggingFace at runtime. One reference is unpinned — the layout model is
requested as `docling-project/docling-layout-heron@main`, so a moved branch
silently changes layout behaviour between runs. Record the resolved commits in
the run manifest rather than the branch name:

```bash
cat ~/.cache/huggingface/hub/models--docling-project--docling-layout-heron/refs/main
ls  ~/.cache/huggingface/hub/models--docling-project--docling-models/snapshots
```

Values observed for the current benchmark runs:

| Model | Requested | Resolved commit |
| --- | --- | --- |
| `docling-layout-heron` | `@main` (unpinned) | `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` |
| `docling-models` | `@v2.3.0` | `fc0f2d45e2218ea24bce5045f58a389aed16dc23` |

If either commit changes, treat it as a provider version change: record the new
values and create a new run ID before processing benchmark documents.

## Run the synthetic provider matrix

From the repository root, capture the installed Paddle packages and API version
instead of copying stale version labels into the run:

```bash
PADDLE_VENV="$HOME/.local/share/forru-extraction/paddleocr-vl"
PADDLE_PACKAGE_VERSIONS="$("$PADDLE_VENV/bin/python" -c \
  'from importlib.metadata import version; print(";".join(f"{name}@{version(name)}" for name in ("paddleocr", "paddlepaddle", "paddlex")))')"
PADDLE_API_VERSION="$(curl -fsS http://127.0.0.1:8080/openapi.json \
  | /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["info"]["version"])')"

PADDLEOCR_VL_BASE_URL=http://127.0.0.1:8080 \
PADDLEOCR_VL_MODEL=PaddleOCR-VL-0.9B \
PADDLEOCR_VL_VERSION="${PADDLE_PACKAGE_VERSIONS};api@${PADDLE_API_VERSION}" \
pnpm --filter @forru/extraction-benchmark probe:providers -- \
  --run-id phase1-provider-matrix-YYYYMMDD-HHMM \
  --extract-synthetic
```

Use a new filesystem-safe run ID every time. The command deliberately refuses
to overwrite an existing probe. It writes the authoritative private manifest
to `benchmarks/extraction/work/<run-id>/run.json` and its linked normalised
evidence to `provider-probe.json`; that directory is ignored by Git.

For a successful control run:

- T0 and T1 return no text for the raster-only text scan, proving that neither tier
  silently enabled OCR;
- T2 and T3 recover the `FORRU OCR TEST 2026` control and return Thai-script
  text for `การฟื้นฟูป่า ประเทศไทย`; exact Thai recovery is recorded separately
  because imperfect OCR is a valid spike result;
- the two T3 scanned results are identical; and
- every probe records `execution: local` and a non-empty provider version.

`run.json` records client wall time separately from provider time. Docling
reports processing duration, while the installed Tika and Paddle APIs do not.
For the latter, the run records an explicit unavailable provider-time state and
a five-sample endpoint baseline for a client-observed wall-minus-baseline proxy.
Docling Serve's synchronous endpoint polls job completion every two seconds by
default, so its once-per-run T1 born-digital fixed-overhead measurement includes
that service scheduling behaviour. Polling and processing can overlap; report
the two components separately rather than assuming they add exactly to wall
time.

These synthetic timings prove provider viability only. Do not report them as
FORRU corpus benchmark values.

## Troubleshooting

- **Connection refused:** confirm the corresponding terminal is still running
  and use `lsof` to check the expected port.
- **T2 returns `504 Gateway Timeout` after almost exactly 120 seconds:** this
  is `docling_serve` `max_sync_wait`, not the document or the client timeout.
  Restart with `DOCLING_SERVE_MAX_SYNC_WAIT` raised. Treat previously recorded
  504 cells as censored configuration failures, not provider capability
  failures, and do not average their durations with successful cells.
- **A re-run refuses to overwrite a cell:** matrix cells are written with the
  `wx` flag and are immutable by design. Move the superseded cells into
  `work/<run-id>/superseded/<reason>/cells/` before re-running; never delete
  them, because they are the evidence that the earlier attempt was censored.
- **T2 cannot recognise Thai:** confirm `tha` appears in
  `tesseract --list-langs`, then restart Docling with `TESSDATA_PREFIX` set.
- **A port is already in use:** identify the existing listener with `lsof`.
  Reuse it only after confirming it is the expected local provider version.
- **First request is slow:** allow model downloads and warm-up to finish. Do
  not replace a slow or unavailable result with zero time.
- **Paddle uses about 100% CPU but the machine is mostly idle:** on macOS this
  is approximately one fully occupied logical core. The verified PaddlePaddle
  wheel has no Metal/MPS device, and PaddleOCR-VL ignores the PDF text layer,
  rasterises every page and runs visual recognition over detected regions. Test
  a single dense page before a multi-page file. Disconnecting the client does
  not cancel server inference; stop and restart the server before another test.
- **`strict_text` deprecation warning:** the benchmark adapter requests
  Markdown and structured JSON, not Docling Jobkit's deprecated `text` export.
  If this warning reappears, confirm the request does not contain
  `to_formats=text` before changing or suppressing server logging.
- **Provider versions changed:** record the new values, create a new run ID and
  rerun the complete synthetic matrix before processing benchmark documents.

Never send FORRU documents to a hosted provider without explicit approval.
