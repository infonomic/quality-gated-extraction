import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expectedT3PageCells, type PageDeclaration } from './run-t3-pages.js'
import { type Stratum, strata } from './sample.js'
import type { ProviderRunCell } from './run-matrix.js'

interface AnnotatedCell {
  partition: 'calibration' | 'evaluation'
  stratum: Stratum
  cell: ProviderRunCell
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function group(cells: AnnotatedCell[]) {
  const succeeded = cells.filter((item) => item.cell.status === 'succeeded')
  const values = succeeded.map((item) => item.cell.wallMs ?? 0).sort((a, b) => a - b)
  const totalWallMs = values.reduce((sum, value) => sum + value, 0)
  return {
    pages: {
      numerator: succeeded.length,
      denominator: cells.length,
      excludedCount: cells.length - succeeded.length,
    },
    statuses: Object.fromEntries(
      ['succeeded', 'failed', 'unavailable', 'censored'].map((status) => [
        status,
        cells.filter((item) => item.cell.status === status).length,
      ])
    ),
    timing: {
      label: 'sampled',
      totalWallMs: round(totalWallMs),
      totalWallMinutes: round(totalWallMs / 60_000),
      meanWallMsPerSucceededPage: succeeded.length ? round(totalWallMs / succeeded.length) : null,
      medianWallMsPerSucceededPage: values.length
        ? round(values[Math.floor((values.length - 1) / 2)] ?? 0)
        : null,
      minimumWallMsPerSucceededPage: values.length ? round(values[0] ?? 0) : null,
      maximumWallMsPerSucceededPage: values.length ? round(values.at(-1) ?? 0) : null,
      providerTimingStatus: 'unavailable',
      basis: 'Client-observed local wall time for independent 128-DPI page-image submissions.',
    },
  }
}

export function summariseT3PageRuns(options: {
  declaration: PageDeclaration
  cellsByName: Map<string, ProviderRunCell>
}) {
  const expectedNames = expectedT3PageCells(options.declaration)
  const unexpected = [...options.cellsByName.keys()].filter((name) => !expectedNames.includes(name))
  const missing = expectedNames.filter((name) => !options.cellsByName.has(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `T3 page matrix mismatch: missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
    )
  }

  const metadata = new Map<string, { partition: 'calibration' | 'evaluation'; stratum: Stratum }>()
  for (const partition of ['calibration', 'evaluation'] as const) {
    for (const item of options.declaration[partition]) {
      for (const page of item.pages) {
        metadata.set(`${item.caseId}:${page}`, { partition, stratum: item.stratum })
      }
    }
  }
  const cells = expectedNames.map((name) => {
    const cell = options.cellsByName.get(name)
    if (!cell || cell.page == null) throw new Error(`T3 page cell lacks page identity: ${name}`)
    const details = metadata.get(`${cell.caseId}:${cell.page}`)
    if (!details) throw new Error(`T3 page cell is outside declaration: ${name}`)
    return { ...details, cell }
  })
  const providerIdentities = new Set(cells.map((item) => JSON.stringify(item.cell.provider)))
  if (providerIdentities.size !== 1) throw new Error('T3 page cells have mixed provider identities')

  return {
    schemaVersion: 1,
    status: 'sampled',
    scope: 'Independent predeclared 128-DPI page-image submissions; not full-document T3.',
    provider: cells[0]?.cell.provider ?? null,
    labels: {
      pageDurations: 'sampled',
      fullDocumentDuration: 'censored',
    },
    denominators: {
      calibrationPages: options.declaration.denominators.calibrationPages,
      evaluationPages: options.declaration.denominators.evaluationPages,
      totalPages: options.declaration.denominators.totalPages,
    },
    overall: group(cells),
    byPartition: {
      calibration: group(cells.filter((item) => item.partition === 'calibration')),
      evaluation: group(cells.filter((item) => item.partition === 'evaluation')),
    },
    evaluationByStratum: Object.fromEntries(
      strata.map((stratum) => [
        stratum,
        group(cells.filter((item) => item.partition === 'evaluation' && item.stratum === stratum)),
      ])
    ),
    censoredFullDocumentObservation: {
      caseId: 'F129',
      pageCount: 10,
      observedMinimumWallMs: 1461000,
      status: 'censored',
      includedInPageTiming: false,
    },
    limitations: [
      'Provider-side Paddle duration is unavailable; every timing is client-observed local wall time.',
      'Calibration and evaluation remain separately reported; calibration contributes no evaluation numerator.',
      'Per-stratum evaluation results are raw counts over eight pages, not population rates.',
      'The censored full-document lower bound is not pooled with the completed page-wise durations.',
    ],
  }
}

async function main(): Promise<void> {
  const [runId, outputPath] = process.argv.slice(2, 4)
  if (!runId || !outputPath || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId)) {
    throw new Error('Usage: summarise-t3-pages.ts <run-id> <output.json>')
  }
  const runDirectory = path.resolve('work', runId)
  const declaration = JSON.parse(
    await readFile(path.join(runDirectory, 't3-page-subset.json'), 'utf8')
  ) as PageDeclaration
  const expectedNames = expectedT3PageCells(declaration)
  const cellsByName = new Map(
    await Promise.all(
      expectedNames.map(
        async (name) =>
          [
            name,
            JSON.parse(
              await readFile(path.join(runDirectory, 't3-page-cells', name), 'utf8')
            ) as ProviderRunCell,
          ] as const
      )
    )
  )
  const summary = summariseT3PageRuns({ declaration, cellsByName })
  const destination = path.resolve(outputPath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  console.log(destination)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
