import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJson } from './artifact-cache.js'
import {
  type GateCalibrationExample,
  type GateThresholdGrid,
  selectGateThresholds,
} from './gate-calibration.js'
import {
  hasDeclaredOracleDerivation,
  hasFrozenAcceptanceCriterion,
  hasFrozenStructuralCriterion,
  normaliseOracleJudgement,
  type OracleJudgement,
} from './oracle.js'
import { evaluateQualityGate, type QualityGateThresholds } from './quality-gate.js'
import { chooseInitialTier, type RoutingThresholds } from './routing.js'
import type { PdfInspection } from './pdf-signals/types.js'
import type { BenchmarkProviderArtifact } from './providers/types.js'
import type { ExtractionTier } from './validate-annotations.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUN_ID = 'phase3-matrix-20260805'
const WORK = path.join(ROOT, 'work', RUN_ID)
const CACHE = path.join(ROOT, 'work/artifact-cache')
const CONTRACT_PATH = path.join(ROOT, 'config/gate-calibration-v1.json')
const ORACLE_PATH = path.join(WORK, 'adjudication/oracle-calibration.json')
const SUBSET_PATH = path.join(WORK, 't3-page-subset.json')
const ROUTING_PATH = path.join(WORK, 'policy-calibration.json')
const INSPECTION_PATH = path.join(ROOT, 'work/phase2-authoritative-20260805/inspection.jsonl')
const OUTPUT_PATH = path.join(WORK, 'gate-calibration.json')

interface GateContract {
  schemaVersion: 1
  contractId: string
  scope: string
  tiers: ExtractionTier[]
  thresholdGrid: GateThresholdGrid
  gridBasis: string
  oracleAggregation: string
  objective: string[]
  tieBreak: string
  componentOrder: string[]
  limitations: string[]
}

interface SubsetEntry {
  caseId: string
  stratum: string
  pages: number[]
}

interface OracleRecord extends OracleJudgement {
  caseId: string
  page: number
  stratum: string
}

interface OracleFile extends Record<string, unknown> {
  acceptanceCriterion?: unknown
  structuralCriterion?: unknown
  derivation?: unknown
}

interface MatrixCell {
  status: string
  artifactKey?: string
}

type InspectionRecord = PdfInspection & { caseId: string }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
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

function intersection(
  judgements: OracleJudgement[],
  axis: 'usableTiers' | 'structurallyAdequateTiers'
): ExtractionTier[] {
  const tiers: ExtractionTier[] = ['T0', 'T1', 'T2', 'T3']
  return tiers.filter((tier) => judgements.every((judgement) => judgement[axis].includes(tier)))
}

async function loadInspection(): Promise<Map<string, InspectionRecord>> {
  const records = (await readFile(INSPECTION_PATH, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InspectionRecord)
  return new Map(records.map((record) => [record.caseId, record]))
}

async function artifactFor(
  caseId: string,
  tier: ExtractionTier
): Promise<BenchmarkProviderArtifact> {
  const cell = await readJson<MatrixCell>(
    path.join(WORK, 'cells', `calibration-${caseId}-${tier}.json`)
  )
  if (cell.status !== 'succeeded' || !cell.artifactKey) {
    throw new Error(`${caseId} ${tier} has no succeeded calibration artifact`)
  }
  return readJson<BenchmarkProviderArtifact>(
    path.join(CACHE, cell.artifactKey.slice(0, 2), `${cell.artifactKey}.json`)
  )
}

const zeroThresholds: QualityGateThresholds = {
  characterSanity: 0,
  textRetention: 0,
  usablePageRatio: 0,
  structuralYield: 0,
  scriptConsistency: 0,
}

async function main(): Promise<void> {
  const [contractRaw, oracleRaw, subset, routing, inspection] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8'),
    readFile(ORACLE_PATH, 'utf8'),
    readJson<{ calibration: SubsetEntry[] }>(SUBSET_PATH),
    readJson<{ status: string; scope: string; policyHash: string; selected: RoutingThresholds }>(
      ROUTING_PATH
    ),
    loadInspection(),
  ])
  const contract = JSON.parse(contractRaw) as GateContract
  const oracle = JSON.parse(oracleRaw) as OracleFile
  if (routing.status !== 'frozen' || routing.scope !== 'initial-inspection-routing-only') {
    throw new Error('Initial inspection routing is not frozen')
  }
  if (!hasFrozenAcceptanceCriterion(oracle.acceptanceCriterion)) {
    throw new Error('Calibration oracle acceptance criterion differs from the frozen rubric')
  }
  if (!hasFrozenStructuralCriterion(oracle.structuralCriterion)) {
    throw new Error('Calibration oracle structural criterion differs from the frozen rubric')
  }
  if (!hasDeclaredOracleDerivation(oracle.derivation)) {
    throw new Error('Calibration oracle degradation derivation differs from the declared rule')
  }

  const expectedPages = subset.calibration.flatMap((item) =>
    item.pages.map((page) => `${item.caseId}:${page}`)
  )
  if (expectedPages.length !== 16 || new Set(expectedPages).size !== expectedPages.length) {
    throw new Error('Frozen calibration subset must contain 16 unique pages')
  }
  const actualPages = Object.keys(oracle).filter((key) => /^F\d+:\d+$/u.test(key))
  if (
    actualPages.length !== expectedPages.length ||
    expectedPages.some((key) => !actualPages.includes(key))
  ) {
    throw new Error('Calibration oracle differs from the frozen 16-page subset')
  }

  const judgements = new Map<string, OracleRecord>()
  for (const item of subset.calibration) {
    for (const page of item.pages) {
      const key = `${item.caseId}:${page}`
      const raw = oracle[key] as Partial<OracleRecord>
      if (raw.caseId !== item.caseId || raw.page !== page || raw.stratum !== item.stratum) {
        throw new Error(`${key} calibration identity or stratum mismatch`)
      }
      const normalised = normaliseOracleJudgement(raw, raw.judgedAt)
      judgements.set(key, { ...raw, ...normalised } as OracleRecord)
    }
  }

  const examples: GateCalibrationExample[] = []
  for (const item of subset.calibration) {
    const pageJudgements = item.pages.map((page) => {
      const judgement = judgements.get(`${item.caseId}:${page}`)
      if (!judgement)
        throw new Error(`Missing normalised calibration judgement ${item.caseId}:${page}`)
      return judgement
    })
    const readingAccepted = intersection(pageJudgements, 'usableTiers')
    const structurallyAccepted = intersection(pageJudgements, 'structurallyAdequateTiers')
    const inspected = inspection.get(item.caseId)
    if (!inspected) throw new Error(`Missing inspection for ${item.caseId}`)
    const initial = chooseInitialTier(inspected.signals, routing.selected)
    for (const tier of contract.tiers) {
      if (tier === 'T3') throw new Error('Document-artifact gate calibration cannot include T3')
      const artifact = withDerivedPages(await artifactFor(item.caseId, tier), inspected.pageCount)
      const components = evaluateQualityGate({
        artifact,
        inspection: {
          pageCount: inspected.pageCount,
          totalTextChars: inspected.signals.totalTextChars,
          thaiCharRatio: inspected.signals.thaiCharRatio,
          latinCharRatio: inspected.signals.latinCharRatio,
          expectsStructure: initial.initialTier !== 'T0',
        },
        thresholds: zeroThresholds,
      }).components
      examples.push({
        tier,
        components,
        readingAccepted: readingAccepted.includes(tier),
        structurallyAccepted: structurallyAccepted.includes(tier),
      })
    }
  }

  const selection = selectGateThresholds(examples, contract.thresholdGrid)
  const scriptCounts = [...judgements.values()].reduce<Record<string, number>>((counts, item) => {
    counts[item.script] = (counts[item.script] ?? 0) + 1
    return counts
  }, {})
  const frozen = {
    schemaVersion: 1,
    status: 'frozen',
    runId: RUN_ID,
    contractId: contract.contractId,
    contractHash: sha256(contractRaw),
    calibrationOracleHash: sha256(oracleRaw),
    initialRoutingPolicyHash: routing.policyHash,
    scope: contract.scope,
    denominators: {
      documents: subset.calibration.length,
      pages: judgements.size,
      documentTierExamples: examples.length,
      axisJudgements: examples.length * 2,
    },
    pageScripts: scriptCounts,
    selected: selection.selected,
    candidateCount: selection.candidates.length,
    candidates: selection.candidates,
    objective: contract.objective,
    tieBreak: contract.tieBreak,
    oracleAggregation: contract.oracleAggregation,
    limitations: contract.limitations,
  }
  const policyHash = sha256(canonicalJson(frozen))
  await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...frozen, policyHash }, null, 2)}\n`, {
    flag: 'wx',
  })
  console.log(
    JSON.stringify(
      {
        output: path.relative(ROOT, OUTPUT_PATH),
        policyHash,
        selected: selection.selected,
        denominators: frozen.denominators,
      },
      null,
      2
    )
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
