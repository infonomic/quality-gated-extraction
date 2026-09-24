import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface InspectionRecord {
  caseId: string
  pageCount: number
}

interface SampleRecord {
  calibration: Array<{ caseId: string }>
  evaluation: Array<{ caseId: string }>
  fallback: {
    applied: boolean
    reasonCode?: string
    originalEvaluationPerStratum: number
    selectedEvaluationPerStratum: number
  }
}

const t3Measurements = {
  bornDigitalMsPerPage: 2856.500583,
  scannedWarmMsPerPage: (7499.753416 + 7564.891833) / 2,
  scannedColdStartWallMs: 38_500,
}

const coldStartSurchargeMs =
  t3Measurements.scannedColdStartWallMs - t3Measurements.scannedWarmMsPerPage

export interface T3Projection {
  pageCount: number
  bornDigitalWarmHours: number
  scannedWarmHours: number
  scannedWarmPlusOneColdStartHours: number
}

function percentile(sorted: number[], probability: number): number {
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)] ?? 0
}

export function projectT3Pages(pageCount: number): T3Projection {
  return {
    pageCount,
    bornDigitalWarmHours: (pageCount * t3Measurements.bornDigitalMsPerPage) / 3_600_000,
    scannedWarmHours: (pageCount * t3Measurements.scannedWarmMsPerPage) / 3_600_000,
    scannedWarmPlusOneColdStartHours:
      (pageCount * t3Measurements.scannedWarmMsPerPage +
        (pageCount > 0 ? coldStartSurchargeMs : 0)) /
      3_600_000,
  }
}

export async function calculateT3Budget(
  inspectionPath: string,
  outputPath: string,
  samplePath?: string
): Promise<Record<string, unknown>> {
  const inspections = (await readFile(inspectionPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as InspectionRecord)
  const pages = inspections.map((inspection) => inspection.pageCount).sort((a, b) => a - b)
  const totalPages = pages.reduce((sum, pageCount) => sum + pageCount, 0)
  const meanPages = pages.length === 0 ? 0 : totalPages / pages.length
  let sampled: Record<string, unknown> | null = null

  if (samplePath) {
    const sample = JSON.parse(await readFile(samplePath, 'utf8')) as SampleRecord
    const pageCountByCase = new Map(
      inspections.map((inspection) => [inspection.caseId, inspection.pageCount])
    )
    const calibrationPages = sample.calibration.reduce(
      (sum, item) => sum + (pageCountByCase.get(item.caseId) ?? 0),
      0
    )
    const evaluationPages = sample.evaluation.reduce(
      (sum, item) => sum + (pageCountByCase.get(item.caseId) ?? 0),
      0
    )
    sampled = {
      calibrationDocuments: sample.calibration.length,
      evaluationDocuments: sample.evaluation.length,
      fallback: sample.fallback,
      calibration: projectT3Pages(calibrationPages),
      evaluation: projectT3Pages(evaluationPages),
      matrixTotal: projectT3Pages(calibrationPages + evaluationPages),
    }
  }

  const result = {
    schemaVersion: 1,
    status: 'projected',
    model:
      'actual page count multiplied by the observed warm scanned rate, plus at most one inferred cold-start surcharge per service process',
    rates: {
      ...t3Measurements,
      coldStartSurchargeMs,
      fixedTransportBaselineMs: 1.78,
      providerTimingStatus: 'unavailable',
      planningScenario: 'scannedWarmPlusOneColdStartHours',
      provenance: {
        bornDigitalMsPerPage: 'Phase 1 authoritative one-page born-digital control.',
        scannedWarmMsPerPage:
          'Mean of two repeatable Phase 1 authoritative one-page scanned controls after model load.',
        scannedColdStartWallMs:
          'Earlier one-page scanned observation, reclassified as cold start because the repeatable warm measurement is 5.1 times faster.',
        coldStartSurchargeMs:
          'Inferred one-time model-load surcharge: cold one-page wall time minus warm one-page wall time.',
      },
    },
    corpus: {
      documents: pages.length,
      totalPages,
      pageCountDistribution: {
        minimum: pages[0] ?? 0,
        median: percentile(pages, 0.5),
        p75: percentile(pages, 0.75),
        p90: percentile(pages, 0.9),
        p95: percentile(pages, 0.95),
        maximum: pages.at(-1) ?? 0,
        mean: meanPages,
      },
      fullMatrixT3: projectT3Pages(totalPages),
    },
    sampled,
    decision:
      sampled == null
        ? 'Full-corpus T3 is infeasible; calculate the frozen-sample projection before provider execution.'
        : (sampled.fallback as SampleRecord['fallback']).applied
          ? 'A reduced evaluation fallback is applied from the warm-plus-one-cold-start planning scenario.'
          : 'The configured eight-calibration plus sixteen-evaluation sample is retained; the warm-plus-one-cold-start projection fits an unattended run.',
    limitations: [
      'These are planning projections, not observed corpus provider timings.',
      'One-page controls do not measure document-level startup, batching, caching or nonlinear page effects.',
      'PaddleOCR-VL exposes no provider-side duration; rates are client-observed wall time.',
      'Cold-start classification is an inference from the observed 5.1-fold cold/warm gap and must be confirmed in the matrix run.',
    ],
  }
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function main(): Promise<void> {
  const inspectionPath = process.argv[2]
  const outputPath = process.argv[3]
  const samplePath = process.argv[4]
  if (!inspectionPath || !outputPath) {
    throw new Error('Usage: t3-budget.ts <inspection.jsonl> <output.json> [sample.json]')
  }
  const result = await calculateT3Budget(
    path.resolve(inspectionPath),
    path.resolve(outputPath),
    samplePath ? path.resolve(samplePath) : undefined
  )
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
