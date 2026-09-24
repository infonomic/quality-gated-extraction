import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { RequestInit as UndiciRequestInit } from 'undici'
import { Agent, fetch as undiciFetch } from 'undici'

import { ArtifactCache, artifactCacheKey, type CachedArtifact } from './artifact-cache.js'
import { PaddleOcrVlBenchmarkProvider } from './providers/paddleocr-vl.js'
import { probeProvider } from './providers/types.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { FetchImplementation } from './providers/http.js'
import type { ProviderRunCell } from './run-matrix.js'
import type { Stratum } from './sample.js'

const execFileAsync = promisify(execFile)
const rasterDpi = 128

interface DeclaredPage {
  caseId: string
  stratum: Stratum
  documentPageCount: number
  pages: number[]
}

export interface PageDeclaration {
  status: 'frozen'
  provenance: { sampleHash: string; policyHash: string }
  denominators: {
    calibrationPages: number
    evaluationPages: number
    totalPages: number
  }
  calibration: DeclaredPage[]
  evaluation: DeclaredPage[]
}

interface CorpusRecord {
  caseId: string
  contentHash: string | null
  status: 'included' | 'excluded' | 'unreadable'
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pageCellName(partition: string, caseId: string, page: number): string {
  return `${partition}-${caseId}-P${String(page).padStart(4, '0')}-T3.json`
}

export function expectedT3PageCells(declaration: PageDeclaration): string[] {
  return (['calibration', 'evaluation'] as const).flatMap((partition) =>
    declaration[partition].flatMap((item) =>
      item.pages.map((page) => pageCellName(partition, item.caseId, page))
    )
  )
}

async function writeCell(
  destination: string,
  cell: ProviderRunCell,
  registry: Awaited<ReturnType<typeof createSchemaRegistry>>
): Promise<void> {
  const validation = registry.validate('provider-run', cell)
  if (!validation.valid) {
    throw new Error(`provider-run schema: ${formatValidationErrors(validation.errors)}`)
  }
  await writeFile(destination, `${JSON.stringify(cell, null, 2)}\n`, { flag: 'wx' })
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
  const args = process.argv.slice(2)
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const runId = valueAfter('--run-id')
  const sampleRunId = valueAfter('--sample-run-id') ?? 'phase2-authoritative-20260805'
  const maxNewCellsText = valueAfter('--max-new-cells')
  const maxNewCells = maxNewCellsText == null ? null : Number(maxNewCellsText)
  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId)) {
    throw new Error('--run-id is required and must be safe')
  }
  if (maxNewCells != null && (!Number.isSafeInteger(maxNewCells) || maxNewCells <= 0)) {
    throw new Error('--max-new-cells must be a positive integer')
  }

  const runDirectory = path.resolve('work', runId)
  const sampleDirectory = path.resolve('work', sampleRunId)
  const declarationPath = path.join(runDirectory, 't3-page-subset.json')
  const [declarationBytes, declarationManifest, corpusRows, config] = await Promise.all([
    readFile(declarationPath),
    readFile(`${declarationPath}.manifest.json`, 'utf8').then(
      (value) => JSON.parse(value) as { sha256: string; immutableWrite: boolean }
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
  if (
    !declarationManifest.immutableWrite ||
    declarationManifest.sha256 !== sha256(declarationBytes)
  ) {
    throw new Error('T3 page declaration manifest does not match immutable bytes')
  }
  const declaration = JSON.parse(declarationBytes.toString('utf8')) as PageDeclaration
  if (declaration.status !== 'frozen') throw new Error('T3 page declaration is not frozen')
  const expectedNames = expectedT3PageCells(declaration)
  if (expectedNames.length !== declaration.denominators.totalPages) {
    throw new Error('T3 page declaration denominator does not match selected pages')
  }

  const baseUrl = process.env.PADDLEOCR_VL_BASE_URL
  const version = process.env.PADDLEOCR_VL_VERSION
  if (!baseUrl || !version) throw new Error('Pinned Paddle base URL and version are required')
  const dispatcher = new Agent({
    connectTimeout: 10_000,
    headersTimeout: config.execution.timeoutMs,
    bodyTimeout: config.execution.timeoutMs,
  })
  const fetchImpl: FetchImplementation = async (input, init) =>
    (await undiciFetch(input, {
      ...(init as unknown as UndiciRequestInit),
      dispatcher,
    })) as unknown as Response
  const provider = new PaddleOcrVlBenchmarkProvider({
    baseUrl,
    version,
    model: process.env.PADDLEOCR_VL_MODEL ?? 'PaddleOCR-VL-0.9B',
    execution: 'local',
    timeoutMs: config.execution.timeoutMs,
    fetchImpl,
  })
  const probe = await probeProvider(provider)
  if (probe.status !== 'available') throw new Error(`Paddle unavailable: ${probe.error?.message}`)
  const descriptor = await provider.describe()
  const corpusByCase = new Map(corpusRows.map((item) => [item.caseId, item]))
  const cache = new ArtifactCache(path.resolve('work', 'artifact-cache'))
  const registry = await createSchemaRegistry()
  const cellsDirectory = path.join(runDirectory, 't3-page-cells')
  const imagesDirectory = path.join(runDirectory, 't3-page-images')
  await Promise.all([
    mkdir(cellsDirectory, { recursive: true }),
    mkdir(imagesDirectory, { recursive: true }),
  ])

  let completedNewCells = 0
  for (const partition of ['calibration', 'evaluation'] as const) {
    for (const item of declaration[partition]) {
      const corpus = corpusByCase.get(item.caseId)
      if (corpus?.status !== 'included' || !corpus.contentHash) {
        throw new Error(`Declared T3 case ${item.caseId} is not an included corpus record`)
      }
      const sourcePath = path.join(sampleDirectory, 'source', `${item.caseId}.bin`)
      const source = await readFile(sourcePath)
      if (sha256(source) !== corpus.contentHash)
        throw new Error(`Source hash drift for ${item.caseId}`)

      for (const page of item.pages) {
        const destination = path.join(cellsDirectory, pageCellName(partition, item.caseId, page))
        try {
          await readFile(destination)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }

        const imageBase = path.join(
          imagesDirectory,
          `${item.caseId}-P${String(page).padStart(4, '0')}`
        )
        const imagePath = `${imageBase}.png`
        try {
          await readFile(imagePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await execFileAsync('pdftoppm', [
            '-f',
            String(page),
            '-l',
            String(page),
            '-singlefile',
            '-png',
            '-r',
            String(rasterDpi),
            sourcePath,
            imageBase,
          ])
        }
        const image = await readFile(imagePath)
        const inputContentHash = sha256(image)
        const parameters = {
          ...descriptor.parameters,
          fileType: 1,
          sourcePage: page,
          rasterDpi,
        }
        const key = artifactCacheKey({
          contentHash: inputContentHash,
          provider: descriptor.provider,
          parameters,
          representationSchemaVersion: 1,
        })
        const startedAt = new Date().toISOString()
        const lookupStarted = performance.now()
        const cached = await cache.get(key, item.caseId)
        const lookupMs = performance.now() - lookupStarted
        let cell: ProviderRunCell
        if (cached) {
          cell = {
            schemaVersion: 1,
            caseId: item.caseId,
            page,
            inputContentHash,
            tier: 'T3',
            provider: descriptor.provider,
            status: 'succeeded',
            cache: { hit: true, key, lookupMs },
            startedAt,
            finishedAt: new Date().toISOString(),
            artifactKey: key,
            wallMs: cached.timings.wallMs,
          }
        } else {
          try {
            const extracted = await provider.extract({
              data: image,
              filename: `${item.caseId}-P${String(page).padStart(4, '0')}.png`,
              mimeType: 'image/png',
              language: item.stratum.endsWith('thai-mixed') ? 'eng+tha' : 'eng',
            })
            const artifact: CachedArtifact = {
              schemaVersion: 1,
              caseId: item.caseId,
              cacheKey: key,
              tier: 'T3',
              ...extracted,
              parameters,
              pages: extracted.pages?.map((output) => ({ ...output, page })),
            }
            await cache.put(artifact)
            cell = {
              schemaVersion: 1,
              caseId: item.caseId,
              page,
              inputContentHash,
              tier: 'T3',
              provider: descriptor.provider,
              status: 'succeeded',
              cache: { hit: false, key, lookupMs },
              startedAt,
              finishedAt: new Date().toISOString(),
              artifactKey: key,
              wallMs: extracted.timings.wallMs,
            }
          } catch (error) {
            cell = {
              schemaVersion: 1,
              caseId: item.caseId,
              page,
              inputContentHash,
              tier: 'T3',
              provider: descriptor.provider,
              status: 'failed',
              cache: { hit: false, key, lookupMs },
              startedAt,
              finishedAt: new Date().toISOString(),
              error: {
                code: error instanceof Error ? error.name.toUpperCase() : 'PROVIDER_FAILED',
                message: error instanceof Error ? error.message : 'Unknown provider failure',
              },
            }
          }
        }
        await writeCell(destination, cell, registry)
        process.stdout.write(`${partition} ${item.caseId} page ${page} T3 ${cell.status}\n`)
        completedNewCells += 1
        if (maxNewCells != null && completedNewCells >= maxNewCells) {
          process.stdout.write(`Stopped after ${completedNewCells} new T3 page cell(s).\n`)
          await dispatcher.close()
          return
        }
      }
    }
  }

  const present = new Set(await readdir(cellsDirectory))
  const cells = await Promise.all(
    expectedNames.map(async (name) => {
      if (!present.has(name)) throw new Error(`Missing T3 page cell ${name}`)
      return JSON.parse(await readFile(path.join(cellsDirectory, name), 'utf8')) as ProviderRunCell
    })
  )
  await writeImmutable(
    path.join(runDirectory, 't3-page-runs.jsonl'),
    `${cells.map((cell) => JSON.stringify(cell)).join('\n')}\n`
  )
  await writeImmutable(
    path.join(runDirectory, 't3-page-summary.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'sampled',
        provider: descriptor.provider,
        rasterDpi,
        policyHash: declaration.provenance.policyHash,
        denominators: {
          expectedPages: expectedNames.length,
          observedPages: cells.length,
          calibrationPages: declaration.denominators.calibrationPages,
          evaluationPages: declaration.denominators.evaluationPages,
        },
        statuses: Object.fromEntries(
          ['succeeded', 'failed', 'unavailable', 'censored'].map((status) => [
            status,
            cells.filter((cell) => cell.status === status).length,
          ])
        ),
        wallMs: cells
          .filter((cell) => cell.status === 'succeeded')
          .reduce((sum, cell) => sum + (cell.wallMs ?? 0), 0),
        limitation:
          'Independent 128-DPI page-image submissions; not full-document T3 duration or provider-reported compute.',
      },
      null,
      2
    )}\n`
  )
  await dispatcher.close()
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
