import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface DensePageObservation {
  runId: string
  status: 'succeeded'
  wallMs: number
  recognitionRegions: number
  wallMsPerRecognitionRegion: number
  provider: {
    id: string
    version: string
    model: string
    execution: string
    device: string
  }
  source: { caseId: string; page: number; contentHash: string }
}

interface CensoredDocumentObservation {
  caseId: string
  status: 'censored'
  observedMinimumWallMs: number
}

interface FrozenSample {
  calibration: Array<{ caseId: string }>
  evaluation: Array<{ caseId: string; pages: number[] }>
  denominators: { evaluationDocuments: number; annotationPages: number }
}

const historicalWarmSparsePageMs = 7532.3226245
const historicalColdStartSurchargeMs = 30967.6773755
const pagesPerCalibrationDocument = 2
const runtimeAllowanceMs = 2 * 60 * 60 * 1000

function projection(pageCount: number, rateMsPerPage: number, coldSurchargeMs = 0) {
  const wallMs = pageCount * rateMsPerPage + coldSurchargeMs
  return { pageCount, wallMs, minutes: wallMs / 60_000 }
}

export function buildT3PageBudget(options: {
  dense: DensePageObservation
  censored: CensoredDocumentObservation
  sample: FrozenSample
}) {
  if (options.dense.status !== 'succeeded' || options.dense.wallMs <= 0) {
    throw new Error('Dense-page observation must be a completed positive duration')
  }
  if (options.censored.status !== 'censored' || options.censored.observedMinimumWallMs <= 0) {
    throw new Error('Full-document observation must be a positive censored lower bound')
  }
  if (options.sample.evaluation.some((item) => item.pages.length !== 2)) {
    throw new Error('Frozen evaluation sample must retain two pages per document')
  }

  const calibrationPages = options.sample.calibration.length * pagesPerCalibrationDocument
  const evaluationPages = options.sample.evaluation.reduce(
    (sum, item) => sum + item.pages.length,
    0
  )
  const totalPages = calibrationPages + evaluationPages
  const denseRateMsPerPage = options.dense.wallMs
  const denseWarm = projection(totalPages, denseRateMsPerPage)
  const denseWarmPlusHistoricalColdStart = projection(
    totalPages,
    denseRateMsPerPage,
    historicalColdStartSurchargeMs
  )
  const sensitivity2x = projection(totalPages, denseRateMsPerPage * 2)
  const permittedMeanMsPerPage = runtimeAllowanceMs / totalPages
  const fullDocumentPageCount = 10
  const linearTenPageEstimateMs = fullDocumentPageCount * denseRateMsPerPage

  return {
    schemaVersion: 1,
    status: 'projected',
    scope: 'T3 page-subset execution budget; not a full-document runtime estimate',
    labels: {
      densePageRate: 'observed',
      sparsePageRate: 'observed',
      fullDocumentDuration: 'censored',
      subsetDurations: 'projected',
    },
    provider: options.dense.provider,
    observed: {
      densePage: {
        runId: options.dense.runId,
        caseId: options.dense.source.caseId,
        page: options.dense.source.page,
        contentHash: options.dense.source.contentHash,
        wallMs: options.dense.wallMs,
        recognitionRegions: options.dense.recognitionRegions,
        wallMsPerRecognitionRegion: options.dense.wallMsPerRecognitionRegion,
      },
      historicalWarmSparsePageMs,
    },
    censored: {
      caseId: options.censored.caseId,
      pageCount: fullDocumentPageCount,
      observedMinimumWallMs: options.censored.observedMinimumWallMs,
      observedMinimumMeanMsPerPage: options.censored.observedMinimumWallMs / fullDocumentPageCount,
      lowerBoundMultipleOfLinearDensePageEstimate:
        options.censored.observedMinimumWallMs / linearTenPageEstimateMs,
    },
    subset: {
      calibrationDocuments: options.sample.calibration.length,
      calibrationPages,
      evaluationDocuments: options.sample.evaluation.length,
      evaluationPages,
      totalDocuments: options.sample.calibration.length + options.sample.evaluation.length,
      totalPages,
    },
    projections: {
      denseWarm,
      denseWarmPlusHistoricalColdStart,
      sensitivity2x,
    },
    allowance: {
      wallMs: runtimeAllowanceMs,
      hours: runtimeAllowanceMs / 3_600_000,
      permittedMeanMsPerPage,
      multipleOfObservedDensePageRate: permittedMeanMsPerPage / denseRateMsPerPage,
      denseWarmFits: denseWarm.wallMs <= runtimeAllowanceMs,
      sensitivity2xFits: sensitivity2x.wallMs <= runtimeAllowanceMs,
    },
    decision:
      'Retain all 16 evaluation documents and predeclare two T3 pages per calibration and evaluation document. Report document-level T3 as censored and page-subset results as sampled raw counts with their denominators.',
    limitations: [
      'The dense one-page observation is a local CPU wall-time measurement, not provider-reported duration.',
      'The 48-page duration assumes independent page-image submissions and linear scaling; the two-times scenario is a sensitivity check, not a confidence interval.',
      'The historical cold-start surcharge is retained only as an explicitly inferred comparison and is not described as conservative.',
      'The censored ten-page request demonstrates strong full-document nonlinearity and is not folded into the completed page-rate estimate.',
      'Per-stratum outcomes will be reported as raw counts over four evaluation documents and eight pages, not as population rates.',
    ],
  }
}

async function main(): Promise<void> {
  const [densePath, censoredPath, samplePath, outputPath] = process.argv.slice(2, 6)
  if (!densePath || !censoredPath || !samplePath || !outputPath) {
    throw new Error(
      'Usage: t3-page-budget.ts <dense-summary.json> <censored-cell.json> <sample.json> <output.json>'
    )
  }
  const [dense, censored, sample] = await Promise.all([
    readFile(path.resolve(densePath), 'utf8').then(
      (value) => JSON.parse(value) as DensePageObservation
    ),
    readFile(path.resolve(censoredPath), 'utf8').then(
      (value) => JSON.parse(value) as CensoredDocumentObservation
    ),
    readFile(path.resolve(samplePath), 'utf8').then((value) => JSON.parse(value) as FrozenSample),
  ])
  const result = buildT3PageBudget({ dense, censored, sample })
  await writeFile(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
