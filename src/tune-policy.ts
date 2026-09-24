import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { tuneRoutingThresholds } from './routing.js'
import type { RoutingSignals } from './routing.js'
import type { Stratum } from './sample.js'

interface FrozenSample {
  calibration: Array<{ caseId: string; stratum: Stratum }>
  evaluation: Array<{ caseId: string; stratum: Stratum }>
}

interface InspectionRecord {
  caseId: string
  signals: RoutingSignals
}

function option(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? fallback : args[index + 1]
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`${name} is required and must be filesystem-safe`)
  }
  return value
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--')
  const sampleRunId = option(args, '--sample-run-id', 'phase2-authoritative-20260805')
  const matrixRunId = option(args, '--matrix-run-id')
  const sampleDirectory = path.resolve('work', sampleRunId)
  const matrixDirectory = path.resolve('work', matrixRunId)
  const cellsDirectory = path.join(matrixDirectory, 'cells')

  let cellNames: string[] = []
  try {
    cellNames = await readdir(cellsDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const evaluationArtifact = cellNames.find((name) => name.startsWith('evaluation-'))
  if (evaluationArtifact) {
    throw new Error(
      `Refusing threshold tuning after evaluation matrix access: ${evaluationArtifact}`
    )
  }

  const [configBytes, sampleBytes, inspectionBytes] = await Promise.all([
    readFile(path.resolve('config/default.json')),
    readFile(path.join(sampleDirectory, 'sample.json')),
    readFile(path.join(sampleDirectory, 'inspection.jsonl')),
  ])
  const config = JSON.parse(configBytes.toString('utf8')) as {
    routing: {
      thresholdGrid: {
        minimumTextLayerCoverage: number[]
        maximumFullPageImageRatio: number[]
        maximumEncodingAnomalyRatio: number[]
      }
    }
  }
  const sample = JSON.parse(sampleBytes.toString('utf8')) as FrozenSample
  const inspections = new Map(
    inspectionBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as InspectionRecord)
      .map((inspection) => [inspection.caseId, inspection.signals])
  )
  const tuned = await tuneRoutingThresholds({
    sample,
    grid: config.routing.thresholdGrid,
    readInspection: async (caseId) => {
      const signals = inspections.get(caseId)
      if (!signals) throw new Error(`Missing calibration inspection ${caseId}`)
      return signals
    },
  })
  const result = {
    schemaVersion: 1,
    status: 'frozen',
    scope: 'initial-inspection-routing-only',
    matrixRunId,
    sampleRunId,
    configHash: sha256(configBytes),
    sampleHash: sha256(sampleBytes),
    evaluationMatrixCellsPresentAtFreeze: 0,
    tuningSet: 'calibration',
    calibrationCaseIds: tuned.calibrationCaseIds,
    evaluationCaseIdsOpened: [],
    candidateCount: tuned.candidates.length,
    selected: tuned.selected,
    candidates: tuned.candidates,
    policyHash: tuned.policyHash,
    limitation:
      'The stratum label is a calibration proxy for initial-tier suitability. Quality-gate thresholds remain unfrozen until private annotations exist.',
  }
  const destination = path.join(matrixDirectory, 'policy-calibration.json')
  const contents = `${JSON.stringify(result, null, 2)}\n`
  try {
    await writeFile(destination, contents, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readFile(destination, 'utf8')) !== contents) {
      throw new Error('Existing frozen policy differs')
    }
  }
  process.stdout.write(`${destination}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
