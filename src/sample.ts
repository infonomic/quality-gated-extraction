import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { PdfInspection } from './pdf-signals/types.js'

export const strata = [
  'born-digital-en',
  'layout-heavy-born-digital',
  'scanned-degraded-en',
  'scanned-degraded-thai-mixed',
] as const

export type Stratum = (typeof strata)[number]

export interface InspectionRecord extends PdfInspection {
  caseId: string
}

interface SampleConfig {
  seed: string
  sample: {
    strata: string[]
    calibrationPerStratum: number
    evaluationPerStratum: number
    annotatedPagesPerDocument: number
  }
  inspection: {
    mixedScriptMinimumRatio: number
  }
  routing: {
    defaults: {
      minimumTextLayerCoverage: number
      maximumFullPageImageRatio: number
      maximumEncodingAnomalyRatio: number
    }
  }
}

interface SampleItem {
  caseId: string
  stratum: Stratum
  pageCount: number
}

interface EvaluationItem extends SampleItem {
  pages: number[]
}

export interface ManualStratumAdjustment {
  caseId: string
  from: Stratum
  to: Stratum
  reasonCode: string
}

export interface FrozenSample {
  schemaVersion: 1
  runId: string
  seed: string
  configHash: string
  inspectionHash: string
  stratumRules: Array<{ stratum: Stratum; rule: string }>
  orderedCorpusCaseIds: string[]
  calibration: SampleItem[]
  evaluation: EvaluationItem[]
  manualReview: {
    status: 'pending' | 'complete'
    reviewedCaseIds: string[]
    adjustments: ManualStratumAdjustment[]
  }
  fallback: {
    applied: boolean
    reasonCode?: string
    originalEvaluationPerStratum: number
    selectedEvaluationPerStratum: number
  }
  denominators: {
    corpusDocuments: number
    calibrationDocuments: number
    evaluationDocuments: number
    annotationPages: number
  }
}

export const stratumRules: FrozenSample['stratumRules'] = [
  {
    stratum: 'scanned-degraded-thai-mixed',
    rule: 'degraded=true AND (thaiCharRatio >= mixedScriptMinimumRatio OR mixedScript=true)',
  },
  {
    stratum: 'scanned-degraded-en',
    rule: 'degraded=true after applying the Thai/mixed rule',
  },
  {
    stratum: 'layout-heavy-born-digital',
    rule: 'degraded=false AND (meanImageAreaRatio >= 0.20 OR charsPerPageCv >= 0.75)',
  },
  {
    stratum: 'born-digital-en',
    rule: 'all remaining inspected PDFs',
  },
]

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function classifyInspection(record: InspectionRecord, config: SampleConfig): Stratum {
  const signals = record.signals
  const degraded =
    signals.textLayerCoverage < config.routing.defaults.minimumTextLayerCoverage ||
    (signals.fullPageImageRatio ?? 0) >= config.routing.defaults.maximumFullPageImageRatio ||
    signals.encodingAnomalyRatio >= config.routing.defaults.maximumEncodingAnomalyRatio
  const thaiOrMixed =
    signals.thaiCharRatio >= config.inspection.mixedScriptMinimumRatio || signals.mixedScript

  if (degraded && thaiOrMixed) return 'scanned-degraded-thai-mixed'
  if (degraded) return 'scanned-degraded-en'
  if ((signals.meanImageAreaRatio ?? 0) >= 0.2 || signals.charsPerPageCv >= 0.75) {
    return 'layout-heavy-born-digital'
  }
  return 'born-digital-en'
}

function deterministicRank(seed: string, context: string, value: string): string {
  return sha256(`${seed}\0${context}\0${value}`)
}

function pageScore(record: InspectionRecord, stratum: Stratum, page: number): number {
  const evidence = record.pages[page - 1]
  if (evidence == null) return Number.NEGATIVE_INFINITY
  const imageRatio = evidence.imageAreaRatio ?? 0
  const relativeTextDeviation =
    Math.abs(evidence.textChars - record.signals.charsPerPage) /
    Math.max(1, record.signals.charsPerPage)
  if (stratum === 'scanned-degraded-thai-mixed' || stratum === 'scanned-degraded-en') {
    return (evidence.textChars < 32 ? 2 : 0) + imageRatio + evidence.warnings.length * 0.1
  }
  if (stratum === 'layout-heavy-born-digital') return imageRatio + relativeTextDeviation
  return relativeTextDeviation
}

export function selectPages(
  record: InspectionRecord,
  stratum: Stratum,
  count: number,
  seed: string
): number[] {
  return record.pages
    .map((page) => ({
      page: page.page,
      score: pageScore(record, stratum, page.page),
      tie: deterministicRank(seed, `${record.caseId}:page`, String(page.page)),
    }))
    .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie))
    .slice(0, count)
    .map((candidate) => candidate.page)
    .sort((left, right) => left - right)
}

export function freezeSample(options: {
  runId: string
  config: SampleConfig
  configHash: string
  inspectionHash: string
  inspections: InspectionRecord[]
  evaluationPerStratum?: number
  manualReviewComplete?: boolean
  manualAdjustments?: ManualStratumAdjustment[]
}): FrozenSample {
  const configuredStrata = options.config.sample.strata
  if (
    configuredStrata.length !== strata.length ||
    strata.some((item) => !configuredStrata.includes(item))
  ) {
    throw new Error('Benchmark config must contain exactly the four declared strata')
  }
  const evaluationPerStratum =
    options.evaluationPerStratum ?? options.config.sample.evaluationPerStratum
  if (
    evaluationPerStratum < 1 ||
    evaluationPerStratum > options.config.sample.evaluationPerStratum
  ) {
    throw new Error('Evaluation count must be within the configured sample and fallback bounds')
  }
  const manualAdjustments = options.manualAdjustments ?? []
  if (manualAdjustments.length > 0 && !options.manualReviewComplete) {
    throw new Error('Manual stratum adjustments require a completed manual review')
  }
  const adjustmentsByCase = new Map<string, ManualStratumAdjustment>()
  const inspectionsByCase = new Map(
    options.inspections.map((inspection) => [inspection.caseId, inspection])
  )
  for (const adjustment of manualAdjustments) {
    if (adjustmentsByCase.has(adjustment.caseId)) {
      throw new Error(`Duplicate manual adjustment for ${adjustment.caseId}`)
    }
    const inspection = inspectionsByCase.get(adjustment.caseId)
    if (inspection == null) throw new Error(`Unknown manual adjustment case ${adjustment.caseId}`)
    const classified = classifyInspection(inspection, options.config)
    if (classified !== adjustment.from) {
      throw new Error(
        `Manual adjustment for ${adjustment.caseId} declares ${adjustment.from}, classified ${classified}`
      )
    }
    if (adjustment.from === adjustment.to) {
      throw new Error(`Manual adjustment for ${adjustment.caseId} does not change stratum`)
    }
    adjustmentsByCase.set(adjustment.caseId, adjustment)
  }

  const grouped = new Map<Stratum, InspectionRecord[]>(strata.map((item) => [item, []]))
  for (const inspection of options.inspections) {
    if (inspection.pageCount < options.config.sample.annotatedPagesPerDocument) continue
    const preliminary = classifyInspection(inspection, options.config)
    const reviewed = adjustmentsByCase.get(inspection.caseId)?.to ?? preliminary
    grouped.get(reviewed)?.push(inspection)
  }

  const calibration: SampleItem[] = []
  const evaluation: EvaluationItem[] = []
  for (const stratum of strata) {
    const candidates = [...(grouped.get(stratum) ?? [])].sort((left, right) =>
      deterministicRank(options.config.seed, stratum, left.caseId).localeCompare(
        deterministicRank(options.config.seed, stratum, right.caseId)
      )
    )
    const required = options.config.sample.calibrationPerStratum + evaluationPerStratum
    if (candidates.length < required) {
      throw new Error(`${stratum} has ${candidates.length} eligible cases; ${required} required`)
    }
    const calibrationCases = candidates.slice(0, options.config.sample.calibrationPerStratum)
    const evaluationCases = candidates.slice(options.config.sample.calibrationPerStratum, required)
    calibration.push(
      ...calibrationCases.map((record) => ({
        caseId: record.caseId,
        stratum,
        pageCount: record.pageCount,
      }))
    )
    evaluation.push(
      ...evaluationCases.map((record) => ({
        caseId: record.caseId,
        stratum,
        pageCount: record.pageCount,
        pages: selectPages(
          record,
          stratum,
          options.config.sample.annotatedPagesPerDocument,
          options.config.seed
        ),
      }))
    )
  }

  const calibrationIds = new Set(calibration.map((item) => item.caseId))
  if (evaluation.some((item) => calibrationIds.has(item.caseId))) {
    throw new Error('Calibration and evaluation samples overlap')
  }
  const selectedIds = [...calibration, ...evaluation].map((item) => item.caseId)
  const fallbackApplied = evaluationPerStratum < options.config.sample.evaluationPerStratum
  return {
    schemaVersion: 1,
    runId: options.runId,
    seed: options.config.seed,
    configHash: options.configHash,
    inspectionHash: options.inspectionHash,
    stratumRules,
    orderedCorpusCaseIds: options.inspections.map((inspection) => inspection.caseId),
    calibration,
    evaluation,
    manualReview: {
      status: options.manualReviewComplete ? 'complete' : 'pending',
      reviewedCaseIds: options.manualReviewComplete ? selectedIds : [],
      adjustments: manualAdjustments,
    },
    fallback: {
      applied: fallbackApplied,
      ...(fallbackApplied ? { reasonCode: 'T3_PROJECTED_RUNTIME' } : {}),
      originalEvaluationPerStratum: options.config.sample.evaluationPerStratum,
      selectedEvaluationPerStratum: evaluationPerStratum,
    },
    denominators: {
      corpusDocuments: options.inspections.length,
      calibrationDocuments: calibration.length,
      evaluationDocuments: evaluation.length,
      annotationPages: evaluation.reduce((sum, item) => sum + item.pages.length, 0),
    },
  }
}

export async function generateSampleFiles(options: {
  runId: string
  configPath: string
  inspectionPath: string
  samplePath: string
  summaryPath: string
  evaluationPerStratum?: number
  manualReviewComplete?: boolean
  manualAdjustmentsPath?: string
}): Promise<{ sample: FrozenSample; sampleHash: string }> {
  const [configBytes, inspectionBytes, manualAdjustmentsBytes] = await Promise.all([
    readFile(options.configPath),
    readFile(options.inspectionPath),
    options.manualAdjustmentsPath == null
      ? Promise.resolve(null)
      : readFile(options.manualAdjustmentsPath),
  ])
  const config = JSON.parse(configBytes.toString('utf8')) as SampleConfig
  const inspections = inspectionBytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as InspectionRecord)
  const sample = freezeSample({
    runId: options.runId,
    config,
    configHash: sha256(configBytes),
    inspectionHash: sha256(inspectionBytes),
    inspections,
    evaluationPerStratum: options.evaluationPerStratum,
    manualReviewComplete: options.manualReviewComplete,
    manualAdjustments:
      manualAdjustmentsBytes == null
        ? undefined
        : (JSON.parse(manualAdjustmentsBytes.toString('utf8')) as ManualStratumAdjustment[]),
  })
  const registry = await createSchemaRegistry()
  const validation = registry.validate('sample', sample)
  if (!validation.valid) {
    throw new Error(`sample schema: ${formatValidationErrors(validation.errors)}`)
  }
  const sampleContents = `${JSON.stringify(sample, null, 2)}\n`
  const sampleHash = sha256(sampleContents)
  const countByStratum = Object.fromEntries(
    strata.map((stratum) => [
      stratum,
      {
        calibration: sample.calibration.filter((item) => item.stratum === stratum).length,
        evaluation: sample.evaluation.filter((item) => item.stratum === stratum).length,
      },
    ])
  )
  const adjustmentReasonCounts = Object.fromEntries(
    [...new Set(sample.manualReview.adjustments.map((adjustment) => adjustment.reasonCode))]
      .sort()
      .map((reasonCode) => [
        reasonCode,
        sample.manualReview.adjustments.filter((adjustment) => adjustment.reasonCode === reasonCode)
          .length,
      ])
  )
  const summary = {
    schemaVersion: 1,
    runId: options.runId,
    sampleHash,
    configHash: sample.configHash,
    inspectionHash: sample.inspectionHash,
    seed: sample.seed,
    manualReviewStatus: sample.manualReview.status,
    manualAdjustments: {
      count: sample.manualReview.adjustments.length,
      reasonCodeCounts: adjustmentReasonCounts,
    },
    fallback: sample.fallback,
    denominators: sample.denominators,
    countByStratum,
    calibrationPages: sample.calibration.reduce((sum, item) => sum + item.pageCount, 0),
    evaluationPages: sample.evaluation.reduce((sum, item) => sum + item.pageCount, 0),
  }
  await Promise.all([
    mkdir(path.dirname(options.samplePath), { recursive: true }),
    mkdir(path.dirname(options.summaryPath), { recursive: true }),
  ])
  await Promise.all([
    writeFile(options.samplePath, sampleContents),
    writeFile(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
  ])
  return { sample, sampleHash }
}

async function main(): Promise<void> {
  const [configPath, inspectionPath, samplePath, summaryPath] = process.argv.slice(2, 6)
  if (!configPath || !inspectionPath || !samplePath || !summaryPath) {
    throw new Error(
      'Usage: sample.ts <config> <inspection.jsonl> <sample.json> <summary.json> [--run-id <id>] [--evaluation-per-stratum <n>] [--manual-review-complete] [--manual-adjustments <json>]'
    )
  }
  const valueAfter = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const evaluation = valueAfter('--evaluation-per-stratum')
  const manualAdjustments = valueAfter('--manual-adjustments')
  const result = await generateSampleFiles({
    runId: valueAfter('--run-id') ?? 'phase2-authoritative-20260805',
    configPath: path.resolve(configPath),
    inspectionPath: path.resolve(inspectionPath),
    samplePath: path.resolve(samplePath),
    summaryPath: path.resolve(summaryPath),
    evaluationPerStratum: evaluation == null ? undefined : Number.parseInt(evaluation, 10),
    manualReviewComplete: process.argv.includes('--manual-review-complete'),
    manualAdjustmentsPath: manualAdjustments == null ? undefined : path.resolve(manualAdjustments),
  })
  console.log(
    JSON.stringify(
      { sampleHash: result.sampleHash, denominators: result.sample.denominators },
      null,
      2
    )
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
