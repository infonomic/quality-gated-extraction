import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { arch, cpus, platform, release, totalmem } from 'node:os'

interface BenchmarkConfig {
  experimentId: string
  seed: string
  cost: {
    currency: string
    cpuMachineHour: number
    gpuMachineHour: number
    basis: string
  }
}

export interface CommandResult {
  stdout: string
  stderr: string
  status: number | null
}

export type CommandRunner = (command: string, args: string[]) => CommandResult

export interface CaptureEnvironmentOptions {
  runId: string
  config: BenchmarkConfig
  configBytes: Uint8Array
  now?: () => Date
  runCommand?: CommandRunner
}

const defaultCommandRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  }
}

function commandText(runCommand: CommandRunner, command: string, args: string[]): string | null {
  const result = runCommand(command, args)
  if (result.status !== 0) return null
  const value = `${result.stdout}\n${result.stderr}`.trim()
  return value || null
}

export function captureEnvironment(options: CaptureEnvironmentOptions): Record<string, unknown> {
  const now = options.now ?? (() => new Date())
  const runCommand = options.runCommand ?? defaultCommandRunner
  const cpuList = cpus()
  const gitCommit = commandText(runCommand, 'git', ['rev-parse', 'HEAD'])

  if (!gitCommit || !/^[a-f0-9]{40}$/.test(gitCommit)) {
    throw new Error('Unable to determine the current Git commit')
  }

  const gitStatus = commandText(runCommand, 'git', ['status', '--porcelain'])

  return {
    schemaVersion: 1,
    runId: options.runId,
    experimentId: options.config.experimentId,
    seed: options.config.seed,
    configHash: createHash('sha256').update(options.configBytes).digest('hex'),
    git: {
      commit: gitCommit,
      dirty: Boolean(gitStatus),
    },
    runtime: {
      node: process.version,
      pnpm: commandText(runCommand, 'pnpm', ['--version']) ?? 'unavailable',
      java: commandText(runCommand, 'java', ['-version']),
      tika: null,
      docling: null,
    },
    system: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpuList[0]?.model ?? 'unknown',
      cpuCount: Math.max(1, cpuList.length),
      totalMemoryBytes: totalmem(),
      accelerator: null,
    },
    providers: [],
    tariffs: options.config.cost,
    limitations: [
      'Provider identities and accelerator details are not pinned at scaffold capture.',
    ],
    startedAt: now().toISOString(),
  }
}
