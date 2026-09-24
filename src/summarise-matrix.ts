import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ArtifactCache, type CachedArtifact } from './artifact-cache.js'
import type { ExtractionTier } from './providers/types.js'
import type { ProviderRunCell } from './run-matrix.js'
import type { Stratum } from './sample.js'

interface SampleItem {
  caseId: string
  stratum: Stratum
  pageCount: number
}

interface FrozenSample {
  calibration: SampleItem[]
  evaluation: SampleItem[]
}

interface TimingCalibration {
  providerId: string
  fixedOverheadMs: number
  marginalTimeBasis: 'provider-reported' | 'client-wall-minus-fixed-overhead'
}

interface AggregateCell {
  sample: SampleItem
  partition: 'calibration' | 'evaluation'
  run: ProviderRunCell
  artifact?: CachedArtifact
}

const tiers: ExtractionTier[] = ['T0', 'T1', 'T2', 'T3']
const strata: Stratum[] = [
  'born-digital-en',
  'layout-heavy-born-digital',
  'scanned-degraded-en',
  'scanned-degraded-thai-mixed',
]

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function summariseGroup(
  cells: AggregateCell[],
  fixedOverheadByProvider: Map<string, number>,
  cost: { cpuMachineHour: number; gpuMachineHour: number }
) {
  const succeeded = cells.filter((cell) => cell.run.status === 'succeeded' && cell.artifact)
  const failed = cells.filter((cell) => cell.run.status === 'failed').length
  const unavailable = cells.filter((cell) => cell.run.status === 'unavailable').length
  const censoredCells = cells.filter((cell) => cell.run.status === 'censored')
  const censored = censoredCells.length
  const censoredObservedMinimumWallMs = censoredCells.reduce(
    (sum, cell) => sum + (cell.run.observedMinimumWallMs ?? 0),
    0
  )
  const pages = succeeded.reduce((sum, cell) => sum + cell.sample.pageCount, 0)
  const wallMs = succeeded.reduce((sum, cell) => sum + (cell.artifact?.timings.wallMs ?? 0), 0)
  let marginalMs = 0
  let providerReported = 0
  let clientObservedProxy = 0
  for (const cell of succeeded) {
    const artifact = cell.artifact
    if (!artifact) continue
    if (artifact.timings.providerTimingStatus === 'observed') {
      marginalMs += artifact.timings.providerMs ?? 0
      providerReported += 1
    } else {
      marginalMs += Math.max(
        0,
        artifact.timings.wallMs - (fixedOverheadByProvider.get(artifact.provider.id) ?? 0)
      )
      clientObservedProxy += 1
    }
  }
  const tier = cells[0]?.run.tier
  const tariff = tier === 'T3' ? cost.gpuMachineHour : cost.cpuMachineHour
  return {
    documents: {
      numerator: succeeded.length,
      denominator: cells.length,
      excludedCount: failed + unavailable + censored,
      failed,
      unavailable,
      censored,
    },
    pages: {
      numerator: pages,
      denominator: cells.reduce((sum, cell) => sum + cell.sample.pageCount, 0),
      excludedCount: cells
        .filter((cell) => cell.run.status !== 'succeeded')
        .reduce((sum, cell) => sum + cell.sample.pageCount, 0),
    },
    cacheHits: succeeded.filter((cell) => cell.run.cache.hit).length,
    timing: {
      label: 'sampled',
      wallMs: round(wallMs),
      marginalMs: round(marginalMs),
      meanWallMsPerSucceededDocument: succeeded.length ? round(wallMs / succeeded.length) : null,
      marginalMsPerSucceededPage: pages ? round(marginalMs / pages) : null,
      providerReportedDocuments: providerReported,
      clientObservedProxyDocuments: clientObservedProxy,
      censoredDocuments: censored,
      censoredObservedMinimumWallMs: round(censoredObservedMinimumWallMs),
      excludedWarmupCount: 1,
    },
    costProxy: {
      label: 'sampled',
      value: round((marginalMs / 3_600_000) * tariff),
      unit: 'USD',
      basis:
        tier === 'T3'
          ? 'Observed local marginal wall-time proxy multiplied by the declared GPU-hour comparison tariff.'
          : 'Observed marginal duration multiplied by the declared CPU-hour comparison tariff.',
      billedSpend: false,
    },
  }
}

type GroupSummary = ReturnType<typeof summariseGroup>
type TierSummary = {
  overall: GroupSummary
  byPartition: Record<'calibration' | 'evaluation', GroupSummary>
  byStratum: Record<Stratum, GroupSummary>
}

export function summariseMatrix(options: {
  sample: FrozenSample
  cells: ProviderRunCell[]
  artifacts: Map<string, CachedArtifact>
  timingCalibrations: TimingCalibration[]
  cost: { cpuMachineHour: number; gpuMachineHour: number }
}) {
  const sampleItems = [...options.sample.calibration, ...options.sample.evaluation]
  const sampleByCase = new Map(sampleItems.map((item) => [item.caseId, item]))
  const partitionByCase = new Map([
    ...options.sample.calibration.map((item) => [item.caseId, 'calibration' as const] as const),
    ...options.sample.evaluation.map((item) => [item.caseId, 'evaluation' as const] as const),
  ])
  const fixedOverheadByProvider = new Map(
    options.timingCalibrations.map((calibration) => [
      calibration.providerId,
      calibration.fixedOverheadMs,
    ])
  )
  const aggregateCells = options.cells.map((run) => {
    const sample = sampleByCase.get(run.caseId)
    if (!sample) throw new Error(`Provider run is outside frozen sample: ${run.caseId}`)
    const partition = partitionByCase.get(run.caseId)
    if (!partition) throw new Error(`Provider run has no sample partition: ${run.caseId}`)
    return {
      sample,
      partition,
      run,
      artifact: options.artifacts.get(`${run.caseId}:${run.tier}`),
    }
  })
  const byTier = Object.fromEntries(
    tiers.map((tier) => {
      const tierCells = aggregateCells.filter((cell) => cell.run.tier === tier)
      return [
        tier,
        {
          overall: summariseGroup(tierCells, fixedOverheadByProvider, options.cost),
          byPartition: {
            calibration: summariseGroup(
              tierCells.filter((cell) => cell.partition === 'calibration'),
              fixedOverheadByProvider,
              options.cost
            ),
            evaluation: summariseGroup(
              tierCells.filter((cell) => cell.partition === 'evaluation'),
              fixedOverheadByProvider,
              options.cost
            ),
          },
          byStratum: Object.fromEntries(
            strata.map((stratum) => [
              stratum,
              summariseGroup(
                tierCells.filter((cell) => cell.sample.stratum === stratum),
                fixedOverheadByProvider,
                options.cost
              ),
            ])
          ),
        },
      ]
    })
  ) as Record<ExtractionTier, TierSummary>
  return {
    schemaVersion: 1,
    status: 'sampled',
    denominators: {
      documents: sampleItems.length,
      matrixCells: options.cells.length,
      calibrationDocuments: options.sample.calibration.length,
      evaluationDocuments: options.sample.evaluation.length,
    },
    byTier,
    limitations: [
      'Warm-up controls are excluded from all tier totals.',
      'Provider-reported and client-observed marginal timing bases remain separately counted.',
      'Censored lower bounds are reported separately and excluded from completed timing means and cost proxies.',
      'Cost values are declared machine-time comparison proxies, not billed spend or energy measurements.',
      'Calibration and evaluation are not accuracy-pooled; this timing summary covers the complete provider matrix only.',
    ],
  }
}

function option(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? fallback : args[index + 1]
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`${name} is required and must be safe`)
  }
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--')
  const matrixRunId = option(args, '--matrix-run-id')
  const sampleRunId = option(args, '--sample-run-id', 'phase2-authoritative-20260805')
  const phase1RunId = option(args, '--phase1-run-id', 'phase1-authoritative-20260805')
  const matrixDirectory = path.resolve('work', matrixRunId)
  const [sample, cells, phase1, config] = await Promise.all([
    readFile(path.resolve('work', sampleRunId, 'sample.json'), 'utf8').then(
      (value) => JSON.parse(value) as FrozenSample
    ),
    readFile(path.join(matrixDirectory, 'provider-runs.jsonl'), 'utf8').then((value) =>
      value
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ProviderRunCell)
    ),
    readFile(path.resolve('work', phase1RunId, 'run.json'), 'utf8').then(
      (value) => JSON.parse(value) as { timingCalibrations: TimingCalibration[] }
    ),
    readFile(path.resolve('config/default.json'), 'utf8').then(
      (value) =>
        JSON.parse(value) as {
          cost: { cpuMachineHour: number; gpuMachineHour: number }
        }
    ),
  ])
  const cache = new ArtifactCache(path.resolve('work', 'artifact-cache'))
  const artifacts = new Map<string, CachedArtifact>()
  for (const cell of cells) {
    if (cell.status !== 'succeeded' || !cell.artifactKey) continue
    const artifact = await cache.get(cell.artifactKey, cell.caseId)
    if (!artifact) throw new Error(`Missing artifact ${cell.artifactKey}`)
    artifacts.set(`${cell.caseId}:${cell.tier}`, artifact)
  }
  const summary = summariseMatrix({
    sample,
    cells,
    artifacts,
    timingCalibrations: phase1.timingCalibrations,
    cost: config.cost,
  })
  const resultsDirectory = path.resolve('results', matrixRunId)
  await mkdir(resultsDirectory, { recursive: true })
  const destination = path.join(resultsDirectory, 'timing-summary.json')
  await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${destination}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
