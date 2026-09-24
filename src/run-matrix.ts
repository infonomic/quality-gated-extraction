import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { RequestInit as UndiciRequestInit } from 'undici'
import { Agent, fetch as undiciFetch } from 'undici'

import { ArtifactCache, artifactCacheKey, type CachedArtifact } from './artifact-cache.js'
import { createSyntheticScannedPdf } from './fixtures/synthetic-pdf.js'
import { providersFromEnvironment } from './probe-providers.js'
import { probeProvider } from './providers/types.js'
import { assertDisjointSample } from './routing.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { FetchImplementation } from './providers/http.js'
import type {
  BenchmarkProvider,
  ExtractionTier,
  ProviderIdentity,
  ProviderProbeResult,
} from './providers/types.js'
import type { Stratum } from './sample.js'

interface SampleItem {
  caseId: string
  stratum: Stratum
}

interface FrozenSample {
  calibration: SampleItem[]
  evaluation: SampleItem[]
}

interface CorpusRecord {
  caseId: string
  contentHash: string | null
  status: 'included' | 'excluded' | 'unreadable'
  mediaType: string
}

export interface ProviderRunCell {
  schemaVersion: 1
  caseId: string
  page?: number
  inputContentHash?: string
  tier: ExtractionTier
  provider: ProviderIdentity
  status: 'succeeded' | 'failed' | 'unavailable' | 'censored'
  cache: { hit: boolean; key?: string; lookupMs?: number }
  startedAt: string
  finishedAt: string
  artifactKey?: string
  wallMs?: number
  observedMinimumWallMs?: number
  error?: { code: string; message: string }
}

interface CliOptions {
  runId: string
  sampleRunId: string
  warmUp: boolean
  maxNewCells: number | null
}

const documentTiers: ExtractionTier[] = ['T0', 'T1', 'T2']

function parseOptions(args: string[]): CliOptions {
  let runId: string | undefined
  let sampleRunId = 'phase2-authoritative-20260805'
  let warmUp = true
  let maxNewCells: number | null = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') {
      // pnpm forwards its separator.
    } else if (argument === '--run-id') {
      runId = args[index + 1]
      index += 1
    } else if (argument === '--sample-run-id') {
      sampleRunId = args[index + 1] ?? ''
      index += 1
    } else if (argument === '--no-warm-up') {
      warmUp = false
    } else if (argument === '--max-new-cells') {
      const value = Number(args[index + 1])
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--max-new-cells must be a positive integer')
      }
      maxNewCells = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  const safe = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u
  if (!runId || !safe.test(runId)) throw new Error('--run-id is required and must be safe')
  if (!safe.test(sampleRunId)) throw new Error('--sample-run-id must be safe')
  return { runId, sampleRunId, warmUp, maxNewCells }
}

export function reachedNewCellLimit(completed: number, limit: number | null): boolean {
  return limit !== null && completed >= limit
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function cellName(partition: 'calibration' | 'evaluation', caseId: string, tier: ExtractionTier) {
  return `${partition}-${caseId}-${tier}.json`
}

export function expectedMatrixCells(sample: FrozenSample): string[] {
  assertDisjointSample(sample)
  return [
    ...sample.calibration.flatMap((item) =>
      documentTiers.map((tier) => cellName('calibration', item.caseId, tier))
    ),
    ...sample.evaluation.flatMap((item) =>
      documentTiers.map((tier) => cellName('evaluation', item.caseId, tier))
    ),
  ]
}

export function assertMatrixComplete(sample: FrozenSample, cells: ProviderRunCell[]): void {
  const expected = new Set(
    [...sample.calibration, ...sample.evaluation].flatMap((item) =>
      documentTiers.map((tier) => `${item.caseId}:${tier}`)
    )
  )
  const actual = new Set(cells.map((cell) => `${cell.caseId}:${cell.tier}`))
  const missing = [...expected].filter((key) => !actual.has(key))
  const unexpected = [...actual].filter((key) => !expected.has(key))
  if (missing.length > 0 || unexpected.length > 0 || actual.size !== cells.length) {
    throw new Error(
      `Incomplete provider matrix: missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'} duplicates=${cells.length - actual.size}`
    )
  }
}

function unavailableCell(
  item: SampleItem,
  probe: ProviderProbeResult,
  startedAt: string
): ProviderRunCell {
  return {
    schemaVersion: 1,
    caseId: item.caseId,
    tier: probe.tier,
    provider: {
      id: probe.id,
      version: probe.version ?? 'unavailable',
      execution: probe.execution,
    },
    status: 'unavailable',
    cache: { hit: false },
    startedAt,
    finishedAt: new Date().toISOString(),
    error: probe.error ?? { code: 'PROVIDER_UNAVAILABLE', message: 'Provider unavailable' },
  }
}

async function runAvailableCell(options: {
  item: SampleItem
  provider: BenchmarkProvider
  corpus: CorpusRecord
  sourceDirectory: string
  cache: ArtifactCache
}): Promise<ProviderRunCell> {
  const startedAt = new Date().toISOString()
  const descriptor = await options.provider.describe()
  const contentHash = options.corpus.contentHash
  if (!contentHash) throw new Error(`Included case ${options.item.caseId} has no content hash`)
  const key = artifactCacheKey({
    contentHash,
    provider: descriptor.provider,
    parameters: descriptor.parameters,
    representationSchemaVersion: 1,
  })
  const lookupStarted = performance.now()
  const cached = await options.cache.get(key, options.item.caseId)
  const lookupMs = performance.now() - lookupStarted
  if (cached) {
    return {
      schemaVersion: 1,
      caseId: options.item.caseId,
      tier: options.provider.tier,
      provider: descriptor.provider,
      status: 'succeeded',
      cache: { hit: true, key, lookupMs },
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactKey: key,
      wallMs: cached.timings.wallMs,
    }
  }

  const source = await readFile(path.join(options.sourceDirectory, `${options.item.caseId}.bin`))
  if (sha256(source) !== contentHash)
    throw new Error(`Source hash drift for ${options.item.caseId}`)
  try {
    const extracted = await options.provider.extract({
      data: source,
      filename: `${options.item.caseId}.pdf`,
      mimeType: options.corpus.mediaType,
      language: options.item.stratum.endsWith('thai-mixed') ? 'eng+tha' : 'eng',
    })
    const artifact: CachedArtifact = {
      schemaVersion: 1,
      caseId: options.item.caseId,
      cacheKey: key,
      tier: options.provider.tier,
      ...extracted,
    }
    await options.cache.put(artifact)
    return {
      schemaVersion: 1,
      caseId: options.item.caseId,
      tier: options.provider.tier,
      provider: descriptor.provider,
      status: 'succeeded',
      cache: { hit: false, key, lookupMs },
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactKey: key,
      wallMs: extracted.timings.wallMs,
    }
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    const nestedCode =
      cause != null && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code: unknown }).code)
        : null
    const nestedMessage = cause instanceof Error ? cause.message : null
    return {
      schemaVersion: 1,
      caseId: options.item.caseId,
      tier: options.provider.tier,
      provider: descriptor.provider,
      status: 'failed',
      cache: { hit: false, key, lookupMs },
      startedAt,
      finishedAt: new Date().toISOString(),
      error: {
        code: nestedCode ?? (error instanceof Error ? error.name.toUpperCase() : 'PROVIDER_FAILED'),
        message:
          error instanceof Error
            ? `${error.message}${nestedMessage ? `; cause: ${nestedMessage}` : ''}`
            : 'Unknown provider failure',
      },
    }
  }
}

async function validateAndWriteCell(
  cellPath: string,
  cell: ProviderRunCell,
  registry: Awaited<ReturnType<typeof createSchemaRegistry>>
): Promise<void> {
  const validation = registry.validate('provider-run', cell)
  if (!validation.valid) {
    throw new Error(`provider-run schema: ${formatValidationErrors(validation.errors)}`)
  }
  await writeFile(cellPath, `${JSON.stringify(cell, null, 2)}\n`, { flag: 'wx' })
}

async function writeImmutable(destination: string, contents: string): Promise<void> {
  try {
    await writeFile(destination, contents, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readFile(destination, 'utf8')) !== contents) {
      throw new Error(`Existing immutable output differs: ${destination}`)
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const sampleDirectory = path.resolve('work', options.sampleRunId)
  const runDirectory = path.resolve('work', options.runId)
  const cellsDirectory = path.join(runDirectory, 'cells')
  const cache = new ArtifactCache(path.resolve('work', 'artifact-cache'))
  const [sample, corpusRows, config] = await Promise.all([
    readFile(path.join(sampleDirectory, 'sample.json'), 'utf8').then(
      (value) => JSON.parse(value) as FrozenSample
    ),
    readFile(path.join(sampleDirectory, 'corpus.jsonl'), 'utf8').then((value) =>
      value
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CorpusRecord)
    ),
    readFile(path.resolve('config/default.json'), 'utf8').then(
      (value) => JSON.parse(value) as { execution: { timeoutMs: number } }
    ),
  ])
  const dispatcher = new Agent({
    connectTimeout: Math.min(10_000, config.execution.timeoutMs),
    headersTimeout: config.execution.timeoutMs,
    bodyTimeout: config.execution.timeoutMs,
  })
  const fetchImpl: FetchImplementation = async (input, init) =>
    (await undiciFetch(input, {
      ...(init as unknown as UndiciRequestInit),
      dispatcher,
    })) as unknown as Response
  assertDisjointSample(sample)
  const corpusByCase = new Map(corpusRows.map((item) => [item.caseId, item]))
  const registry = await createSchemaRegistry()
  await mkdir(cellsDirectory, { recursive: true })
  const { providers, unavailable } = providersFromEnvironment({
    timeoutMs: config.execution.timeoutMs,
    fetchImpl,
  })
  const probes = [
    ...(await Promise.all(providers.map((provider) => probeProvider(provider)))),
    ...unavailable,
  ]
  const providerByTier = new Map(providers.map((provider) => [provider.tier, provider]))
  const probeByTier = new Map(probes.map((probe) => [probe.tier, probe]))

  const warmupsPath = path.join(runDirectory, 'warmups.json')
  let warmupsExist = false
  try {
    await readFile(warmupsPath)
    warmupsExist = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (options.warmUp && !warmupsExist) {
    const warmupInput = {
      data: createSyntheticScannedPdf(),
      filename: 'synthetic-matrix-warmup.pdf',
      mimeType: 'application/pdf',
      language: 'eng+tha',
    }
    const warmups = []
    for (const provider of providers) {
      if (probeByTier.get(provider.tier)?.status !== 'available') continue
      const startedAt = new Date().toISOString()
      try {
        const artifact = await provider.extract(warmupInput)
        warmups.push({
          tier: provider.tier,
          status: 'succeeded',
          startedAt,
          finishedAt: new Date().toISOString(),
          wallMs: artifact.timings.wallMs,
        })
      } catch (error) {
        warmups.push({
          tier: provider.tier,
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown warm-up failure',
        })
      }
    }
    await writeImmutable(warmupsPath, `${JSON.stringify(warmups, null, 2)}\n`)
  }

  const partitions = [
    ['calibration', sample.calibration],
    ['evaluation', sample.evaluation],
  ] as const
  let completedNewCells = 0
  for (const [partition, items] of partitions) {
    for (const tier of documentTiers) {
      const provider = providerByTier.get(tier)
      const probe = probeByTier.get(tier)
      if (!probe) throw new Error(`No probe record for ${tier}`)
      for (const item of items) {
        const destination = path.join(cellsDirectory, cellName(partition, item.caseId, tier))
        try {
          await readFile(destination)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const corpus = corpusByCase.get(item.caseId)
        if (corpus?.status !== 'included') {
          throw new Error(`Frozen sample case ${item.caseId} is not an included corpus record`)
        }
        const startedAt = new Date().toISOString()
        const cell =
          probe.status !== 'available' || !provider
            ? unavailableCell(item, probe, startedAt)
            : await runAvailableCell({
                item,
                provider,
                corpus,
                sourceDirectory: path.join(sampleDirectory, 'source'),
                cache,
              })
        await validateAndWriteCell(destination, cell, registry)
        process.stdout.write(`${partition} ${item.caseId} ${tier} ${cell.status}\n`)
        completedNewCells += 1
        if (reachedNewCellLimit(completedNewCells, options.maxNewCells)) {
          process.stdout.write(
            `Stopped after ${completedNewCells} new matrix cell(s); resume with the same run id.\n`
          )
          await dispatcher.close()
          return
        }
      }
    }
  }

  const orderedNames = expectedMatrixCells(sample)
  const present = new Set(await readdir(cellsDirectory))
  const cells = await Promise.all(
    orderedNames.map(async (name) => {
      if (!present.has(name)) throw new Error(`Missing matrix cell file ${name}`)
      const cell = JSON.parse(
        await readFile(path.join(cellsDirectory, name), 'utf8')
      ) as ProviderRunCell
      const validation = registry.validate('provider-run', cell)
      if (!validation.valid) {
        throw new Error(`provider-run ${name}: ${formatValidationErrors(validation.errors)}`)
      }
      return cell
    })
  )
  assertMatrixComplete(sample, cells)
  const supplementalT3Names = [...present]
    .filter((name) => /^(calibration|evaluation)-F\d{3}-T3\.json$/u.test(name))
    .sort()
  const supplementalT3 = await Promise.all(
    supplementalT3Names.map(async (name) => {
      const cell = JSON.parse(
        await readFile(path.join(cellsDirectory, name), 'utf8')
      ) as ProviderRunCell
      const validation = registry.validate('provider-run', cell)
      if (!validation.valid) {
        throw new Error(`provider-run ${name}: ${formatValidationErrors(validation.errors)}`)
      }
      return cell
    })
  )
  const reportedCells = [...cells, ...supplementalT3]
  await writeImmutable(
    path.join(runDirectory, 'provider-runs.jsonl'),
    `${reportedCells.map((cell) => JSON.stringify(cell)).join('\n')}\n`
  )
  await writeImmutable(
    path.join(runDirectory, 'matrix-summary.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: options.runId,
        sampleRunId: options.sampleRunId,
        executionOrder: 'calibration-first; provider-grouped-within-partition; concurrency-one',
        timeoutMs: config.execution.timeoutMs,
        warmUp: options.warmUp,
        denominators: {
          documents: sample.calibration.length + sample.evaluation.length,
          expectedDocumentCells: orderedNames.length,
          supplementalFullDocumentT3Observations: supplementalT3.length,
          observedRecords: reportedCells.length,
        },
        statuses: Object.fromEntries(
          ['succeeded', 'failed', 'unavailable', 'censored'].map((status) => [
            status,
            reportedCells.filter((cell) => cell.status === status).length,
          ])
        ),
      },
      null,
      2
    )}\n`
  )
  await dispatcher.close()
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
