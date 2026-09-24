import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  type PolicyCase,
  type PolicyQualityPage,
  simulatePolicies,
  type T3PageBaselineObservation,
} from './policies.js'
import { evaluateQualityGate, type QualityGateThresholds } from './quality-gate.js'
import {
  chooseInitialTier,
  type ReplayArtifact,
  type RoutingThresholds,
  replayEscalation,
} from './routing.js'
import type { OracleJudgement } from './oracle.js'
import type { PdfInspection } from './pdf-signals/types.js'
import type { BenchmarkProviderArtifact } from './providers/types.js'
import type { Stratum } from './sample.js'
import type { ExtractionTier } from './validate-annotations.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUN_ID = 'phase3-matrix-20260805'
const WORK = path.join(ROOT, 'work', RUN_ID)
const CACHE = path.join(ROOT, 'work/artifact-cache')
const SAMPLE_PATH = path.join(ROOT, 'work/phase2-authoritative-20260805/sample.json')
const INSPECTION_PATH = path.join(ROOT, 'work/phase2-authoritative-20260805/inspection.jsonl')
const ORACLE_PATH = path.join(WORK, 'adjudication/oracle.json')
const GATE_PATH = path.join(WORK, 'gate-calibration.json')
const ROUTING_PATH = path.join(WORK, 'policy-calibration.json')
const OUTPUT_PATH = path.join(WORK, 'policy-analysis.json')

type InspectionRecord = PdfInspection & { caseId: string }

interface SampleDocument {
  caseId: string
  stratum: Stratum
  pageCount: number
  pages: number[]
}

interface MatrixCell {
  status: 'succeeded' | 'failed' | 'unavailable' | 'censored'
  artifactKey?: string
  wallMs?: number
}

interface PageCell extends MatrixCell {
  page: number
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pageTextFromDocling(structure: unknown, page: number): string | null {
  if (!structure || typeof structure !== 'object' || Array.isArray(structure)) return null
  const texts = (structure as { texts?: unknown[] }).texts
  if (!Array.isArray(texts)) return null
  const lines = texts.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const provenance = Array.isArray(item.prov) ? item.prov : []
    const belongs = provenance.some(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).page_no === page
    )
    return belongs && typeof item.text === 'string' && item.text.trim() ? [item.text] : []
  })
  return lines.length > 0 ? lines.join('\n\n') : null
}

function withDerivedPages(
  artifact: BenchmarkProviderArtifact,
  pageCount: number
): BenchmarkProviderArtifact {
  if (artifact.pages != null || !artifact.provider.id.includes('docling')) return artifact
  return {
    ...artifact,
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1,
      text: pageTextFromDocling(artifact.representations.structure, index + 1) ?? '',
    })),
  }
}

async function loadInspections(): Promise<Map<string, InspectionRecord>> {
  const records = (await readFile(INSPECTION_PATH, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InspectionRecord)
  return new Map(records.map((record) => [record.caseId, record]))
}

async function cellAndArtifact(
  partition: 'evaluation',
  caseId: string,
  tier: Exclude<ExtractionTier, 'T3'>
): Promise<{ cell: MatrixCell; artifact: BenchmarkProviderArtifact }> {
  const cell = await readJson<MatrixCell>(
    path.join(WORK, 'cells', `${partition}-${caseId}-${tier}.json`)
  )
  if (cell.status !== 'succeeded' || !cell.artifactKey) {
    throw new Error(`${caseId} ${tier} has no succeeded evaluation artifact`)
  }
  const artifact = await readJson<BenchmarkProviderArtifact>(
    path.join(CACHE, cell.artifactKey.slice(0, 2), `${cell.artifactKey}.json`)
  )
  return { cell, artifact }
}

async function t3Page(
  caseId: string,
  page: number
): Promise<{ cell: PageCell; artifact: BenchmarkProviderArtifact }> {
  const cell = await readJson<PageCell>(
    path.join(
      WORK,
      't3-page-cells',
      `evaluation-${caseId}-P${String(page).padStart(4, '0')}-T3.json`
    )
  )
  if (cell.status !== 'succeeded' || !cell.artifactKey) {
    throw new Error(`${caseId} page ${page} has no succeeded T3 page artifact`)
  }
  const artifact = await readJson<BenchmarkProviderArtifact>(
    path.join(CACHE, cell.artifactKey.slice(0, 2), `${cell.artifactKey}.json`)
  )
  return { cell, artifact }
}

function combinedT3Artifact(
  caseId: string,
  entries: Array<{ cell: PageCell; artifact: BenchmarkProviderArtifact }>
): BenchmarkProviderArtifact {
  const first = entries[0]?.artifact
  if (!first) throw new Error(`${caseId} has no sampled T3 artifacts`)
  return {
    ...first,
    representations: {
      text: entries.map((entry) => entry.artifact.representations.text).join('\n\n'),
      markdown: entries.map((entry) => entry.artifact.representations.markdown ?? '').join('\n\n'),
      structure: entries.flatMap((entry) =>
        Array.isArray(entry.artifact.representations.structure)
          ? entry.artifact.representations.structure
          : [entry.artifact.representations.structure]
      ),
    },
    pages: entries.flatMap((entry) => entry.artifact.pages ?? []),
    timings: {
      wallMs: entries.reduce((sum, entry) => sum + entry.artifact.timings.wallMs, 0),
      providerMs: null,
      providerTimingStatus: 'unavailable',
    },
  }
}

function sampledInspection(
  inspection: InspectionRecord,
  pages: number[]
): { pageCount: number; totalTextChars: number; thaiCharRatio: number; latinCharRatio: number } {
  const selected = pages.map((page) => {
    const record = inspection.pages.find((item) => item.page === page)
    if (!record) throw new Error(`${inspection.caseId} has no inspection page ${page}`)
    return record
  })
  const thai = selected.reduce((sum, page) => sum + page.thaiChars, 0)
  const latin = selected.reduce((sum, page) => sum + page.latinChars, 0)
  const scriptTotal = thai + latin
  return {
    pageCount: selected.length,
    totalTextChars: selected.reduce((sum, page) => sum + page.textChars, 0),
    thaiCharRatio: scriptTotal === 0 ? 0 : thai / scriptTotal,
    latinCharRatio: scriptTotal === 0 ? 0 : latin / scriptTotal,
  }
}

async function main(): Promise<void> {
  const [sample, oracleRaw, gate, routing, inspections] = await Promise.all([
    readJson<{ evaluation: SampleDocument[] }>(SAMPLE_PATH),
    readFile(ORACLE_PATH, 'utf8'),
    readJson<{
      status: string
      policyHash: string
      selected: { thresholds: QualityGateThresholds }
    }>(GATE_PATH),
    readJson<{ status: string; policyHash: string; selected: RoutingThresholds }>(ROUTING_PATH),
    loadInspections(),
  ])
  if (gate.status !== 'frozen' || routing.status !== 'frozen') {
    throw new Error('Routing and quality-gate policies must both be frozen')
  }
  const oracle = JSON.parse(oracleRaw) as Record<string, unknown>
  const qualityPages: PolicyQualityPage[] = sample.evaluation.flatMap((item) =>
    item.pages.map((page) => {
      const judgement = oracle[`${item.caseId}:${page}`] as OracleJudgement | undefined
      if (!judgement) throw new Error(`Missing evaluation oracle ${item.caseId}:${page}`)
      return {
        caseId: item.caseId,
        page,
        stratum: item.stratum,
        usableTiers: judgement.usableTiers,
        structurallyAdequateTiers: judgement.structurallyAdequateTiers,
      }
    })
  )
  if (qualityPages.length !== 32) throw new Error('Policy analysis requires 32 evaluation pages')

  const cases: PolicyCase[] = []
  const allT3Pages: T3PageBaselineObservation[] = []
  const decisions: Array<Record<string, unknown>> = []
  for (const item of sample.evaluation) {
    const inspection = inspections.get(item.caseId)
    if (!inspection) throw new Error(`Missing inspection for ${item.caseId}`)
    const initial = chooseInitialTier(inspection.signals, routing.selected)
    const artifacts: Partial<Record<ExtractionTier, ReplayArtifact>> = {}
    const tiers: PolicyCase['tiers'] = {}
    for (const tier of ['T0', 'T1', 'T2'] as const) {
      const evidence = await cellAndArtifact('evaluation', item.caseId, tier)
      const artifact = withDerivedPages(evidence.artifact, inspection.pageCount)
      const gateDecision = evaluateQualityGate({
        artifact,
        inspection: {
          pageCount: inspection.pageCount,
          totalTextChars: inspection.signals.totalTextChars,
          thaiCharRatio: inspection.signals.thaiCharRatio,
          latinCharRatio: inspection.signals.latinCharRatio,
          expectsStructure: initial.initialTier !== 'T0',
        },
        thresholds: gate.selected.thresholds,
      })
      if (!evidence.cell.artifactKey)
        throw new Error(`${item.caseId} ${tier} lost its artifact key`)
      artifacts[tier] = { tier, artifactKey: evidence.cell.artifactKey, gate: gateDecision }
      tiers[tier] = { status: evidence.cell.status, wallMs: evidence.cell.wallMs }
    }

    const t3Entries = await Promise.all(item.pages.map((page) => t3Page(item.caseId, page)))
    const t3Artifact = combinedT3Artifact(item.caseId, t3Entries)
    const selectedInspection = sampledInspection(inspection, item.pages)
    const t3Key = sha256(
      t3Entries
        .map((entry) => entry.cell.artifactKey)
        .filter(Boolean)
        .join(':')
    )
    artifacts.T3 = {
      tier: 'T3',
      artifactKey: t3Key,
      gate: evaluateQualityGate({
        artifact: t3Artifact,
        inspection: { ...selectedInspection, expectsStructure: initial.initialTier !== 'T0' },
        thresholds: gate.selected.thresholds,
      }),
    }
    tiers.T3 = { status: 'unavailable' }
    for (const entry of t3Entries) {
      allT3Pages.push({
        caseId: item.caseId,
        page: entry.cell.page,
        stratum: item.stratum,
        status: entry.cell.status,
        wallMs: entry.cell.wallMs,
      })
    }

    const replay = replayEscalation({ initial, artifacts, maxEscalations: 2 })
    const selectedTier = (Object.values(artifacts).find(
      (artifact) => artifact?.artifactKey === replay.selectedArtifactKey
    )?.tier ?? null) as ExtractionTier | null
    cases.push({
      caseId: item.caseId,
      stratum: item.stratum,
      staticTier: initial.initialTier,
      gatedTier: selectedTier,
      tiers,
    })
    decisions.push({
      caseId: item.caseId,
      stratum: item.stratum,
      initial,
      status: replay.status,
      selectedTier,
      steps: replay.steps,
      t3Scope: 'two-predeclared-page-submissions-not-full-document',
    })
  }

  const analysis = simulatePolicies({ cases, qualityPages, allT3Pages })
  const result = {
    schemaVersion: 1,
    status: 'complete',
    runId: RUN_ID,
    routingPolicyHash: routing.policyHash,
    gatePolicyHash: gate.policyHash,
    evaluationOracleHash: sha256(oracleRaw),
    analysis,
    decisions,
    limitations: [
      'Quality is measured on 32 predeclared pages; T0-T2 timing is measured on 16 full documents.',
      'T3 quality and its terminal gate use two independent page submissions per document; no full-document T3 timing is imputed.',
      'A selected T3 tier is therefore excluded from observed document timing while remaining available to page-level oracle metrics.',
    ],
  }
  await writeFile(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(
    JSON.stringify(
      {
        output: path.relative(ROOT, OUTPUT_PATH),
        denominators: analysis.denominator,
        policies: analysis.policies,
        allT3PageBaseline: analysis.allT3PageBaseline,
      },
      null,
      2
    )
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
