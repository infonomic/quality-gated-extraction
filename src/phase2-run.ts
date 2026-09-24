import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { captureEnvironment } from './environment.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'

interface CorpusSummary {
  outputHashes: { corpusJsonl: string; inspectionJsonl: string }
}

interface SampleSummary {
  sampleHash: string
  fallback: { applied: boolean }
}

async function oldestSourceBirthtime(sourceDirectory: string): Promise<Date> {
  const entries = await readdir(sourceDirectory)
  const statistics = await Promise.all(
    entries.map((entry) => stat(path.join(sourceDirectory, entry)))
  )
  const oldest = Math.min(...statistics.map((item) => item.birthtimeMs))
  if (!Number.isFinite(oldest)) throw new Error('No frozen source files found')
  return new Date(oldest)
}

function phase2CommandRunner(command: string, args: string[]) {
  if (command === 'pnpm' && args.length === 1 && args[0] === '--version') {
    const rootPackage = JSON.parse(readFileSync(path.resolve('../../package.json'), 'utf8')) as {
      packageManager?: string
    }
    return {
      stdout: rootPackage.packageManager?.replace(/^pnpm@/u, '') ?? 'unavailable',
      stderr: '',
      status: 0,
    }
  }
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

async function main(): Promise<void> {
  const runId = process.argv[2]
  if (!runId) throw new Error('Usage: phase2-run.ts <run-id>')
  const workDirectory = path.resolve('work', runId)
  const resultsDirectory = path.resolve('results', runId)
  const configPath = path.resolve('config/default.json')
  const [configBytes, corpusBytes, sampleBytes, t3BudgetBytes, startedAt, finished] =
    await Promise.all([
      readFile(configPath),
      readFile(path.join(workDirectory, 'summary.json')),
      readFile(path.join(resultsDirectory, 'sample-summary.json')),
      readFile(path.join(resultsDirectory, 't3-budget.json')),
      oldestSourceBirthtime(path.join(workDirectory, 'source')),
      stat(path.join(workDirectory, 'summary.json')),
    ])
  const config = JSON.parse(configBytes.toString('utf8')) as {
    experimentId: string
    seed: string
    cost: { currency: string; cpuMachineHour: number; gpuMachineHour: number; basis: string }
  }
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as CorpusSummary
  const sample = JSON.parse(sampleBytes.toString('utf8')) as SampleSummary
  JSON.parse(t3BudgetBytes.toString('utf8'))

  const manifest = {
    ...captureEnvironment({
      runId,
      config,
      configBytes,
      now: () => startedAt,
      runCommand: phase2CommandRunner,
    }),
    evidence: {
      phase: 'phase-2-corpus-sample',
      authoritative: true,
      corpusFile: 'corpus.jsonl',
      corpusHash: corpus.outputHashes.corpusJsonl,
      inspectionFile: 'inspection.jsonl',
      inspectionHash: corpus.outputHashes.inspectionJsonl,
      sampleFile: 'sample.json',
      sampleHash: sample.sampleHash,
      sampleSummaryFile: `../../results/${runId}/sample-summary.json`,
      t3BudgetFile: `../../results/${runId}/t3-budget.json`,
      fallbackApplied: sample.fallback.applied,
    },
    limitations: [
      'Environment snapshot finalised after the corpus pass; source cache birth time and summary modification time bracket the evidence work.',
      'Phase 2 invokes no extraction provider; provider identities remain linked from the separate authoritative Phase 1 run.',
      'T3 budget values are projected planning scenarios, not observed corpus timings.',
    ],
    finishedAt: finished.mtime.toISOString(),
  }
  const registry = await createSchemaRegistry()
  const validation = registry.validate('run', manifest)
  if (!validation.valid) {
    throw new Error(`run schema: ${formatValidationErrors(validation.errors)}`)
  }
  await writeFile(path.join(workDirectory, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  })
  console.log(path.join(workDirectory, 'run.json'))
}

await main()
