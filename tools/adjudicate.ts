// Local adjudication server for the human oracle pass.
//
// Shows each frozen evaluation page image beside the T0-T3 extractions for that
// same page, and records the annotator's judgement. It writes ONLY to an
// ignored private side file; it never edits annotation records, because an
// oracle-only record marked `complete` would pass the schema while leaving the
// structural metrics with an empty reference.
//
//   pnpm exec tsx tools/adjudicate.ts
//   open http://127.0.0.1:7788

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

import { buildStructuralView } from '../src/adjudication-structure.js'
import {
  ACCEPTANCE_CRITERION,
  normaliseOracleJudgement,
  ORACLE_DERIVATION,
  STRUCTURAL_CRITERION,
} from '../src/oracle.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = 'phase3-matrix-20260805'
const CELLS = path.join(ROOT, 'work', RUN, 'cells')
const PAGE_CELLS = path.join(ROOT, 'work', RUN, 't3-page-cells')
const CACHE = path.join(ROOT, 'work/artifact-cache')
const OUT_DIR = path.join(ROOT, 'work', RUN, 'adjudication')
const EVALUATION_OUT = path.join(OUT_DIR, 'oracle.json')
const PORT = Number(process.env.ADJUDICATION_PORT ?? 7788)
if (!Number.isSafeInteger(PORT) || PORT < 1024 || PORT > 65_535) {
  throw new Error('ADJUDICATION_PORT must be an integer from 1024 to 65535')
}

// Calibration and evaluation are adjudicated by the same tool but must never
// share an output file: gate thresholds are tuned on calibration and measured
// on the untouched evaluation oracle. A wrong-mode write is the one failure
// that would silently contaminate the held-out set, so the evaluation path is
// made unreachable in calibration mode rather than merely unused.
const PARTITION = process.env.ADJUDICATION_PARTITION ?? 'evaluation'
if (PARTITION !== 'evaluation' && PARTITION !== 'calibration') {
  throw new Error('ADJUDICATION_PARTITION must be "evaluation" or "calibration"')
}
const OUT =
  PARTITION === 'calibration' ? path.join(OUT_DIR, 'oracle-calibration.json') : EVALUATION_OUT
if (PARTITION === 'calibration' && OUT === EVALUATION_OUT) {
  throw new Error('Calibration mode resolved to the evaluation oracle path')
}

const SUBSET = path.join(ROOT, 'work', RUN, 't3-page-subset.json')
const SUBSET_MANIFEST = `${SUBSET}.manifest.json`
const PACK = path.join(ROOT, 'annotations/private/annotation-pack.json')

interface PackEntry {
  caseId: string
  page: number
  stratum: string
  imageFile: string
  annotationFile: string
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function artifactFor(cellFile: string): Promise<Record<string, any> | null> {
  const cell = await readJson<{ artifactKey?: string; status?: string }>(cellFile)
  if (!cell?.artifactKey) return null
  const key = cell.artifactKey
  return readJson(path.join(CACHE, key.slice(0, 2), `${key}.json`))
}

/** Docling structure carries per-item `prov[].page_no`; use it to split by page. */
function doclingPageText(structure: unknown, page: number): string | null {
  if (!structure || typeof structure !== 'object') return null
  const texts = (structure as { texts?: unknown[] }).texts
  if (!Array.isArray(texts)) return null
  const lines: string[] = []
  for (const item of texts as Array<Record<string, any>>) {
    const prov = Array.isArray(item.prov) ? item.prov : []
    if (prov.some((p: any) => p?.page_no === page)) {
      const value = typeof item.text === 'string' ? item.text : ''
      if (value.trim()) lines.push(value)
    }
  }
  return lines.length > 0 ? lines.join('\n\n') : null
}

/** Fold smart quotes and dashes so Tika and Docling text compare equal. */
function normalise(value: string): string {
  return value
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐-―]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Locate a page's start inside Tika's flat text. Anchors on the longest lines
 * Docling attributes to the page — short lines are usually running headers or
 * folios that repeat on every page and would anchor to the wrong one.
 */
function anchorAt(haystack: string, pageText: string | null): number {
  if (!pageText) return -1
  const candidates = pageText
    .split('\n')
    .map(normalise)
    .filter((line) => line.length >= 24)
    .sort((left, right) => right.length - left.length)
    .slice(0, 5)

  for (const candidate of candidates) {
    for (const width of [80, 48, 30]) {
      if (candidate.length < width) continue
      const at = haystack.indexOf(candidate.slice(0, width))
      if (at >= 0) return at
    }
  }
  return -1
}

/**
 * Tika emits no page markers, so the page is bounded by its own anchor and the
 * NEXT page's anchor. A fixed-width window is not safe: a sparse page such as a
 * cover carries only ~130 characters, and a fixed window would show several
 * following pages as though they were this one.
 */
/**
 * Earliest point after `start` at which any of the next page's text appears.
 *
 * The next page's *longest* line is a reliable identifier but a poor boundary:
 * a page typically opens with a running header, folio or short heading, so the
 * longest line sits some way down and the window overshoots the page break.
 * Searching only the region after `start` makes short strings safe to use here,
 * because a repeated running header can no longer match earlier in the document.
 */
function earliestAfter(
  haystack: string,
  start: number,
  nextPageText: string | null,
  excludeText: string | null = null
): number {
  if (!nextPageText) return -1
  // A paragraph spanning a page break carries provenance on BOTH pages, so it
  // appears in each page's item list. Using it as a boundary would cut away
  // content that genuinely belongs to this page. Only lines exclusive to the
  // next page mark where this one ends.
  const shared = new Set((excludeText ?? '').split('\n').map(normalise).filter(Boolean))
  const region = haystack.slice(start)
  let best = -1
  for (const line of nextPageText.split('\n')) {
    const candidate = normalise(line)
    if (candidate.length < 12 || shared.has(candidate)) continue
    const at = region.indexOf(candidate.slice(0, Math.min(60, candidate.length)))
    if (at > 0 && (best < 0 || at < best)) best = at
  }
  return best < 0 ? -1 : start + best
}

function anchoredWindow(
  flat: string,
  pageText: string | null,
  nextPageText: string | null,
  previousPageText: string | null
): { text: string; bounded: boolean } | null {
  const haystack = normalise(flat)

  // The page's own longest line identifies it reliably but is a poor *start*:
  // it is frequently the last paragraph, which would drop everything above it.
  // Anchor instead on the earliest of this page's lines, searching only after
  // the previous page's anchor so a repeated running header cannot match far
  // earlier in the document. Fall back to longest-first when there is no
  // usable previous page (page one, or a scanned page with no text layer).
  const previous = anchorAt(haystack, previousPageText)
  const earliest = previous >= 0 ? earliestAfter(haystack, previous, pageText) : -1
  const start = earliest >= 0 ? earliest : anchorAt(haystack, pageText)
  if (start < 0) return null

  const tight = earliestAfter(haystack, start, nextPageText, pageText)
  const loose = anchorAt(haystack, nextPageText)
  // Prefer the tighter boundary, but ignore one that would leave almost nothing —
  // that indicates a short string matching inside this page rather than the next.
  const next = tight > start + 200 ? tight : loose > start ? loose : tight > start ? tight : -1
  if (next > start) return { text: haystack.slice(start, next), bounded: true }

  // No following anchor: fall back to a window scaled to this page's own text,
  // and say so rather than implying the boundary is known.
  const width = Math.min(4000, Math.max(600, normalise(pageText ?? '').length * 3))
  return { text: haystack.slice(start, start + width), bounded: false }
}

interface SubsetEntry {
  caseId: string
  stratum: string
  pages: number[]
}

/**
 * Calibration pages come from the immutably written T3 page subset rather than
 * a second annotation pack — the subset is already the frozen authority for
 * which pages were predeclared. Its recorded hash is verified before use so a
 * mutated subset cannot quietly change what gets judged.
 */
async function loadCalibrationPack(): Promise<PackEntry[]> {
  const raw = await readFile(SUBSET, 'utf8')
  const manifest = await readJson<{ sha256?: string }>(SUBSET_MANIFEST)
  const digest = createHash('sha256').update(raw).digest('hex')
  if (!manifest?.sha256) throw new Error(`Missing subset manifest: ${SUBSET_MANIFEST}`)
  if (manifest.sha256 !== digest) {
    throw new Error(
      `Frozen T3 page subset has changed: manifest ${manifest.sha256}, file ${digest}`
    )
  }
  const subset = JSON.parse(raw) as { calibration?: SubsetEntry[] }
  return (subset.calibration ?? []).flatMap((entry) =>
    entry.pages.map((page) => ({
      caseId: entry.caseId,
      page,
      stratum: entry.stratum,
      imageFile: `${entry.caseId}-P${String(page).padStart(4, '0')}.png`,
      annotationFile: '',
    }))
  )
}

const pack =
  PARTITION === 'calibration'
    ? await loadCalibrationPack()
    : ((await readJson<{ annotations: PackEntry[] }>(PACK))?.annotations ?? [])
if (pack.length === 0) {
  console.error(`No ${PARTITION} pages found`)
  process.exit(1)
}

const cache = new Map<string, unknown>()

async function caseData(index: number) {
  const entry = pack[index]
  if (!entry) return null
  const cacheKey = `${entry.caseId}:${entry.page}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const partition = PARTITION
  const [t0, t1, t2] = await Promise.all(
    (['T0', 'T1', 'T2'] as const).map((tier) =>
      artifactFor(path.join(CELLS, `${partition}-${entry.caseId}-${tier}.json`))
    )
  )
  const t3 = await artifactFor(
    path.join(
      PAGE_CELLS,
      `${partition}-${entry.caseId}-P${String(entry.page).padStart(4, '0')}-T3.json`
    )
  )

  const t1Page = doclingPageText(t1?.representations?.structure, entry.page)
  const t2Page = doclingPageText(t2?.representations?.structure, entry.page)
  const nextPage =
    doclingPageText(t1?.representations?.structure, entry.page + 1) ??
    doclingPageText(t2?.representations?.structure, entry.page + 1)
  const previousPage =
    entry.page > 1
      ? (doclingPageText(t1?.representations?.structure, entry.page - 1) ??
        doclingPageText(t2?.representations?.structure, entry.page - 1))
      : null
  const t0Window = anchoredWindow(
    t0?.representations?.text ?? '',
    t1Page ?? t2Page,
    nextPage,
    previousPage
  )
  // Tika has no page markers, so the window is inferred. When it is much
  // shorter than what Docling attributes to the same page, say so rather than
  // letting a truncated excerpt read as a thin extraction.
  const t0Reference = (t1Page ?? t2Page ?? '').length
  const t0Coverage = t0Reference > 400 ? (t0Window?.text.length ?? 0) / t0Reference : 1

  const value = {
    index,
    total: pack.length,
    partition: PARTITION,
    caseId: entry.caseId,
    page: entry.page,
    stratum: entry.stratum,
    image: `/img/${entry.caseId}-P${String(entry.page).padStart(4, '0')}.png`,
    tiers: {
      T0: {
        text: t0Window?.text ?? null,
        structure: buildStructuralView(t0?.representations?.structure, entry.page),
        note:
          t0Coverage < 0.6
            ? `Tika emits no page markers; this window is inferred and looks INCOMPLETE (about ${Math.round(t0Coverage * 100)}% of what Docling attributes to this page). Check the image before judging T0 on completeness.`
            : t0Window?.bounded
              ? 'Tika emits no page markers. Bounded by this page and the next page anchor. A paragraph continuing from the previous page may be omitted.'
              : 'Tika emits no page markers. NO END BOUNDARY FOUND — this excerpt may run past the page. Judge T0 with care.',
        available: Boolean(t0),
      },
      T1: {
        text: t1Page,
        structure: buildStructuralView(t1?.representations?.structure, entry.page),
        note: 'Docling layout, OCR disabled. Split by page provenance.',
        available: Boolean(t1),
      },
      T2: {
        text: t2Page,
        structure: buildStructuralView(t2?.representations?.structure, entry.page),
        note: 'Docling, OCR forced (tesseract eng+tha). Split by page provenance.',
        available: Boolean(t2),
      },
      T3: {
        text: t3?.representations?.text ?? null,
        structure: buildStructuralView(t3?.representations?.structure, entry.page),
        note: 'PaddleOCR-VL, native single-page submission at 128 DPI.',
        available: Boolean(t3),
      },
    },
  }
  cache.set(cacheKey, value)
  return value
}

async function loadOracle(): Promise<Record<string, unknown>> {
  return (await readJson<Record<string, unknown>>(OUT)) ?? {}
}

async function writeOracle(oracle: Record<string, unknown>): Promise<void> {
  const temporary = `${OUT}.${process.pid}.tmp`
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(oracle, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, OUT)
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Oracle adjudication</title>
<style>
 *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#14161a;color:#e6e8eb}
 header{display:flex;gap:16px;align-items:center;padding:10px 16px;background:#1c1f24;border-bottom:1px solid #2c313a;position:sticky;top:0;z-index:5}
 header b{font-size:15px} .muted{color:#9aa4b2} .pill{background:#2a2f38;border-radius:999px;padding:2px 10px;font-size:12px}
 button{background:#2a2f38;color:#e6e8eb;border:1px solid #3a414d;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
 button:hover{background:#333945} button.primary{background:#2f6f4f;border-color:#3d8a63}
 main{display:grid;grid-template-columns:minmax(280px,1.15fr) minmax(300px,1.15fr) minmax(300px,0.85fr);
   gap:12px;padding:12px;align-items:start;height:calc(100vh - 57px)}
 main > *{max-height:100%;overflow:auto}
 .imgwrap{background:#fff;border-radius:8px}
 .imgwrap img{width:100%;display:block}
 @media (max-width:1400px){ main{grid-template-columns:1fr 1fr;height:auto}
   main > *{max-height:none} .formcol{grid-column:1 / -1} }
 .tier{background:#1c1f24;border:1px solid #2c313a;border-radius:8px;margin-bottom:10px}
 .tier h3{margin:0;padding:8px 12px;font-size:13px;border-bottom:1px solid #2c313a;display:flex;justify-content:space-between;align-items:center;
   border-left:4px solid transparent;border-radius:8px 8px 0 0}
 .tier h3 .tag{font-weight:700;letter-spacing:.04em}
 .tier.T0 h3{background:#16202b;border-left-color:#5aa9e6} .tier.T0 h3 .tag{color:#7cc0f5}
 .tier.T1 h3{background:#152417;border-left-color:#5fbf7a} .tier.T1 h3 .tag{color:#7fd694}
 .tier.T2 h3{background:#26210f;border-left-color:#d1a53c} .tier.T2 h3 .tag{color:#e5be55}
 .tier.T3 h3{background:#241624;border-left-color:#b57ac4} .tier.T3 h3 .tag{color:#cf95dc}
 .tier.T0{border-color:#274257} .tier.T1{border-color:#274a30}
 .tier.T2{border-color:#4a3f1c} .tier.T3{border-color:#452e49}
 .tier pre{margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;max-height:none;font:12px/1.6 ui-monospace,Menlo,monospace}
 .tier .note{padding:6px 12px;font-size:11px;color:#9aa4b2;border-top:1px solid #2c313a}
 .missing{padding:12px;color:#d98b8b;font-size:13px}
 form{background:#1c1f24;border:1px solid #2c313a;border-radius:8px;padding:12px;counter-reset:step}
 fieldset .row{margin-top:6px}
 fieldset{border:1px solid #2c313a;border-radius:6px;margin:0 0 12px;padding:10px 10px 8px}
 legend{font-size:14px;font-weight:600;color:#6fcf97;padding:0 6px;letter-spacing:.01em;counter-increment:step}
 legend::before{content:counter(step);display:inline-block;min-width:20px;height:20px;line-height:20px;
   margin-right:8px;text-align:center;border-radius:50%;background:#6fcf97;color:#10241f;
   font-size:12px;font-weight:700;vertical-align:1px}
 label{margin-right:14px;font-size:13px;white-space:nowrap;display:inline-block}
 textarea{width:100%;background:#14161a;color:#e6e8eb;border:1px solid #3a414d;border-radius:6px;padding:8px;font:13px/1.5 inherit}
 input[type=text]{background:#14161a;color:#e6e8eb;border:1px solid #3a414d;border-radius:6px;padding:6px}
 input[type=text].needed{border-color:#d98b8b;background:#2a1a1a;outline:2px solid #d98b8b40}
 .row{display:flex;gap:8px;align-items:center;margin-top:8px}
 .done{color:#6fcf97}
 .derived{margin-top:8px;font-size:13px} .derived b{color:#6fcf97;font-size:15px}
 .rubric{font-size:12px;line-height:1.5;color:#c3cad4;background:#161a1f;border:1px solid #2c313a;border-radius:6px;padding:0 10px;margin-bottom:8px}
 .rubric[open]{padding:0 10px 8px}
 .rubric summary{cursor:pointer;padding:6px 0;font-size:12px;color:#9aa4b2;list-style:none}
 .rubric summary::-webkit-details-marker{display:none}
 .rubric summary::before{content:'▸ ';color:#6b7480} .rubric[open] summary::before{content:'▾ '}
 .rubric table{border-collapse:collapse;margin:6px 0 4px} .rubric td{vertical-align:top;padding:3px 8px 3px 0}
 .rubric td.yes{color:#6fcf97;font-weight:600;white-space:nowrap} .rubric td.no{color:#d98b8b;font-weight:600;white-space:nowrap}
</style></head><body>
<header>
  <button onclick="go(-1)">&larr;</button><button onclick="go(1)">&rarr;</button>
  <b id="title">…</b><span class="pill" id="partition"></span><span class="pill" id="stratum"></span>
  <span class="muted" id="progress"></span><span class="done" id="saved"></span>
  <span style="margin-left:auto" class="muted">annotator <input type="text" id="annotator" size="22" placeholder="your full name"></span>
</header>
<main>
  <div class="imgwrap"><img id="pageimg" alt="page"></div>
  <div><div id="tiers"></div></div>
  <div class="formcol">
    <form onsubmit="save(event)">
      <fieldset><legend>Script on this page</legend>
        <label><input type="radio" name="script" value="english">English</label>
        <label><input type="radio" name="script" value="thai">Thai</label>
        <label><input type="radio" name="script" value="mixed">Mixed</label>
        <label><input type="radio" name="script" value="other">Other</label>
      </fieldset>
      <fieldset><legend>Would you accept this output? tick every tier you would accept</legend>
        <details class="rubric"><summary><b>Criterion B &mdash; reading sufficiency.</b>
          Could a reader obtain this page's content without material loss or corruption?</summary>
          <table>
            <tr><td class="yes">accept</td><td>all substantive blocks present; reading order preserves meaning;
              characters correct. Lost table <i>structure</i> is fine if the values are still readable in order.
              Ignore running headers, folios and hyphenation artifacts.</td></tr>
            <tr><td class="no">reject</td><td>content blocks missing or empty; columns interleaved so sentences
              run into unrelated text; character corruption (replacement glyphs, wrong script, systematic
              substitutions); table values no longer attributable to a row.</td></tr>
          </table>
          Structure is <i>not</i> required by this criterion &mdash; that would be criterion C.
        </details>
        <label><input type="checkbox" name="usable" value="T0" onchange="derive()">T0</label>
        <label><input type="checkbox" name="usable" value="T1" onchange="derive()">T1</label>
        <label><input type="checkbox" name="usable" value="T2" onchange="derive()">T2</label>
        <label><input type="checkbox" name="usable" value="T3" onchange="derive()">T3</label>
        <div class="derived">Lowest usable tier: <b id="lowest">&mdash;</b>
          <span class="muted">derived from your ticks; cost order T0 &lt; T1 &lt; T2 &lt; T3 is measured, not judged</span></div>
      </fieldset>
      <fieldset><legend>Structure preserved? tick every tier whose structure you would rely on</legend>
        <details class="rubric"><summary><b>Criterion C &mdash; structural adequacy.</b>
          Does the structure survive well enough for chunking, table attribution and retrieval?</summary>
          <table>
            <tr><td class="yes">accept</td><td>headings recoverable as headings; table cells attributable to
              row and column; captions distinguishable from body; reading order correct across columns
              and around floats.</td></tr>
            <tr><td class="no">reject</td><td>structure flattened into an undifferentiated run; table collapsed
              so values cannot be attributed; caption merged into body; column or float order scrambled.</td></tr>
          </table>
          Independent of criterion B &mdash; a tier may pass one and not the other.
        </details>
        <label><input type="checkbox" name="structural" value="T0" onchange="derive()">T0</label>
        <label><input type="checkbox" name="structural" value="T1" onchange="derive()">T1</label>
        <label><input type="checkbox" name="structural" value="T2" onchange="derive()">T2</label>
        <label><input type="checkbox" name="structural" value="T3" onchange="derive()">T3</label>
        <div class="derived">Lowest structurally adequate tier: <b id="lowstruct">&mdash;</b></div>
        <div class="row"><label><input type="checkbox" name="structuralConfirmed">
          I assessed Criterion C; no selected tiers means none is structurally adequate.</label></div>
      </fieldset>
      <fieldset><legend>Higher-tier degradation</legend>
        <div class="derived"><b id="degradedreadout">&mdash;</b></div>
        <span class="muted">derived from gaps between accepted tiers on either criterion; not entered by the annotator</span>
      </fieldset>
      <textarea name="notes" rows="2" placeholder="notes (optional)"></textarea>
      <div class="row"><button class="primary" type="submit">Save &amp; next</button>
      <span class="muted" id="count"></span></div>
    </form>
  </div>
</main>
<script>
let i=0,total=0,oracle={};
const escapeHtml=value=>value.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){
  const d=await (await fetch('/api/case/'+i)).json();
  total=d.total;
  title.textContent=d.caseId+'  page '+d.page;
  stratum.textContent=d.stratum;
  partition.textContent=d.partition;
  partition.style.background = d.partition==='calibration' ? '#5a3a12' : '#2a2f38';
  partition.style.color = d.partition==='calibration' ? '#ffcf85' : '';
  document.title = d.partition==='calibration' ? 'CALIBRATION — oracle' : 'Oracle adjudication';
  progress.textContent=(i+1)+' of '+d.total;
  pageimg.src=d.image;
  tiers.innerHTML=Object.entries(d.tiers).map(([k,v])=>
    '<div class="tier '+k+'"><h3><span class="tag">'+k+'</span><span class="muted">'+(v.text?v.text.length+' chars':'no text')+'</span></h3>'
    +(v.text?'<pre>'+escapeHtml(v.text)+'</pre>'
           :'<div class="missing">'+(v.available?'No text located for this page.':'No artifact.')+'</div>')
    +'<div class="note">'+v.note+'</div>'
    +'<details open><summary>Structural view</summary>'
    +(v.structure.text?'<pre>'+escapeHtml(v.structure.text)+'</pre>'
      :'<div class="missing">No typed structural blocks for this page.</div>')
    +'<div class="note">'+v.structure.note+'</div></details></div>').join('');
  const key=d.caseId+':'+d.page, prev=oracle[key];
  document.querySelectorAll('input[name=script]').forEach(e=>e.checked=false);
  document.querySelectorAll('input[name=usable],input[name=structural]').forEach(e=>e.checked=false);
  document.querySelector('[name=structuralConfirmed]').checked=false;
  document.querySelector('[name=notes]').value='';
  saved.textContent = prev ? '✓ saved' : '';
  if(prev){
    const s=document.querySelector('input[name=script][value="'+prev.script+'"]'); if(s)s.checked=true;
    (prev.usableTiers||[]).forEach(t=>{const c=document.querySelector('input[name=usable][value="'+t+'"]');if(c)c.checked=true});
    (prev.structurallyAdequateTiers||[]).forEach(t=>{const c=document.querySelector('input[name=structural][value="'+t+'"]');if(c)c.checked=true});
    document.querySelector('[name=structuralConfirmed]').checked=true;
    document.querySelector('[name=notes]').value=prev.notes||'';
  }
  derive();
  count.textContent=judgedCount()+' of '+total+' judged';
}
const ORDER=['T0','T1','T2','T3'];
const JUDGED=/^F\\d+:\\d+$/;
function judgedCount(){ return Object.keys(oracle).filter(k=>JUDGED.test(k)).length }
function gaps(on){
  const indexes=ORDER.map((tier,index)=>on.includes(tier)?index:-1).filter(index=>index>=0);
  if(indexes.length<2)return [];
  const first=indexes[0],last=indexes[indexes.length-1];
  return ORDER.filter((tier,index)=>index>first&&index<last&&!on.includes(tier));
}
function derive(){
  const on=[...document.querySelectorAll('input[name=usable]:checked')].map(c=>c.value);
  const low=ORDER.find(t=>on.includes(t))||'unusable';
  lowest.textContent = low==='unusable' ? 'none usable' : low;
  const st=[...document.querySelectorAll('input[name=structural]:checked')].map(c=>c.value);
  const lowSt=ORDER.find(t=>st.includes(t))||'unusable';
  lowstruct.textContent = lowSt==='unusable' ? 'none adequate' : lowSt;
  const degraded=ORDER.filter(t=>gaps(on).includes(t)||gaps(st).includes(t));
  degradedreadout.textContent=degraded.length?'yes — '+degraded.join(', ')+' skipped':'none';
  return low;
}
function go(d){ i=Math.max(0,Math.min(total-1,i+d)); load(); }
async function save(e){
  e.preventDefault();
  const f=e.target, get=n=>f.querySelector('input[name='+n+']:checked')?.value||null;
  const body={ script:get('script'), lowestUsableTier:derive(),
    usableTiers:[...f.querySelectorAll('input[name=usable]:checked')].map(c=>c.value),
    structurallyAdequateTiers:[...f.querySelectorAll('input[name=structural]:checked')].map(c=>c.value),
    structuralAssessmentConfirmed:f.querySelector('[name=structuralConfirmed]').checked,
    notes:f.querySelector('[name=notes]').value.trim()||null,
    annotator:annotator.value.trim()||null };
  if(!body.annotator){
    annotator.classList.add('needed'); annotator.focus();
    alert('Enter your name in the annotator box (top right) before saving.');return
  }
  annotator.classList.remove('needed');
  if(!body.script){alert('Select the script on this page.');return}
  if(!f.querySelector('[name=structuralConfirmed]').checked){
    alert('Confirm that you assessed Criterion C, even when no tier is adequate.');return
  }
  const r=await fetch('/api/case/'+i,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  oracle=await r.json(); go(1);
}
annotator.addEventListener('input',()=>{
  annotator.classList.remove('needed');
  try{ localStorage.setItem('forru.oracle.annotator',annotator.value.trim()) }catch{}
});
(async()=>{
  try{ annotator.value=localStorage.getItem('forru.oracle.annotator')||'' }catch{}
  oracle=await (await fetch('/api/oracle')).json(); load();
})();
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const send = (code: number, type: string, body: string | Buffer) => {
    res.writeHead(code, { 'content-type': type })
    res.end(body)
  }

  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', HTML)

    if (url.pathname === '/api/oracle') {
      return send(200, 'application/json', JSON.stringify(await loadOracle()))
    }

    if (url.pathname.startsWith('/img/')) {
      const file = path.join(ROOT, 'work', RUN, 't3-page-images', path.basename(url.pathname))
      return send(200, 'image/png', await readFile(file))
    }

    const match = /^\/api\/case\/(\d+)$/u.exec(url.pathname)
    if (match) {
      const index = Number(match[1])
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        const entry = pack[index]
        if (!entry) return send(404, 'text/plain', 'no such case')
        const judgement = normaliseOracleJudgement(body)
        const oracle = await loadOracle()
        oracle.acceptanceCriterion = ACCEPTANCE_CRITERION
        oracle.structuralCriterion = STRUCTURAL_CRITERION
        const previousDerivation =
          oracle.derivation && typeof oracle.derivation === 'object'
            ? (oracle.derivation as Record<string, unknown>)
            : null
        oracle.derivation = {
          ...ORACLE_DERIVATION,
          appliedAt:
            typeof previousDerivation?.appliedAt === 'string'
              ? previousDerivation.appliedAt
              : new Date().toISOString().slice(0, 10),
        }
        oracle[`${entry.caseId}:${entry.page}`] = {
          caseId: entry.caseId,
          page: entry.page,
          stratum: entry.stratum,
          ...judgement,
        }
        await writeOracle(oracle)
        return send(200, 'application/json', JSON.stringify(oracle))
      }
      const data = await caseData(index)
      if (!data) return send(404, 'text/plain', 'no such case')
      return send(200, 'application/json', JSON.stringify(data))
    }

    send(404, 'text/plain', 'not found')
  } catch (error) {
    send(500, 'text/plain', error instanceof Error ? error.message : 'error')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Adjudication UI:  http://127.0.0.1:${PORT}`)
  console.log(`${pack.length} ${PARTITION} pages. Judgements write to:`)
  console.log(`  ${path.relative(ROOT, OUT)}  (ignored)`)
})
