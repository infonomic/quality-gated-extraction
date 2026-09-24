import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { characterSanity } from './quality-gate.js'

const provisionalDiagnosticThreshold = 0.95

interface ProviderCell {
  caseId: string
  page: number
  tier: string
  status: string
  artifactKey?: string
}

interface CachedArtifact {
  representations?: { text?: unknown }
}

async function main(): Promise<void> {
  const [cellArgument = 'work/phase3-matrix-20260805/t3-page-cells/evaluation-F313-P0027-T3.json'] =
    process.argv.slice(2).filter((argument) => argument !== '--')
  const benchmarkRoot = path.resolve(import.meta.dirname, '..')
  const workRoot = path.join(benchmarkRoot, 'work')
  const cellPath = path.resolve(benchmarkRoot, cellArgument)
  if (!cellPath.startsWith(`${workRoot}${path.sep}`)) {
    throw new Error('Character-sanity audits are restricted to ignored benchmark work artifacts')
  }
  const cell = JSON.parse(await readFile(cellPath, 'utf8')) as ProviderCell
  if (cell.status !== 'succeeded' || !cell.artifactKey) {
    throw new Error('Cell must be a succeeded provider run with an artifact key')
  }
  if (!/^[a-f0-9]{64}$/u.test(cell.artifactKey)) throw new Error('Unsafe artifact key')
  const artifactPath = path.join(
    workRoot,
    'artifact-cache',
    cell.artifactKey.slice(0, 2),
    `${cell.artifactKey}.json`
  )
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as CachedArtifact
  const text = artifact.representations?.text
  if (typeof text !== 'string') throw new Error('Artifact has no text representation')
  const score = characterSanity(text)
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        caseId: cell.caseId,
        page: cell.page,
        tier: cell.tier,
        component: 'characterSanity',
        score,
        diagnosticThreshold: {
          value: provisionalDiagnosticThreshold,
          status: 'provisional-test-fixture-not-frozen',
        },
        wouldFlagAtDiagnosticThreshold: score < provisionalDiagnosticThreshold,
        input: 'raw-provider-text-before-comparison-normalisation',
      },
      null,
      2
    )
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
