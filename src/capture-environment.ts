import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { captureEnvironment } from './environment.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'

interface CliOptions {
  runId: string
  configPath: string
}

function parseOptions(args: string[]): CliOptions {
  let runId: string | undefined
  let configPath = 'config/default.json'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') {
    } else if (argument === '--run-id') {
      runId = args[index + 1]
      index += 1
    } else if (argument === '--config') {
      configPath = args[index + 1] ?? ''
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) {
    throw new Error(
      '--run-id is required and must contain only letters, numbers, dot, underscore or dash'
    )
  }
  if (!configPath) throw new Error('--config requires a path')

  return { runId, configPath }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const configBytes = await readFile(resolve(options.configPath))
  const config = JSON.parse(configBytes.toString('utf8')) as {
    experimentId: string
    seed: string
    cost: {
      currency: string
      cpuMachineHour: number
      gpuMachineHour: number
      basis: string
    }
  }
  const registry = await createSchemaRegistry()
  const configValidation = registry.validate('benchmark-config', config)

  if (!configValidation.valid) {
    throw new Error(
      `Invalid benchmark configuration: ${formatValidationErrors(configValidation.errors)}`
    )
  }

  const manifest = captureEnvironment({
    runId: options.runId,
    config,
    configBytes,
  })
  const validation = registry.validate('run', manifest)

  if (!validation.valid) {
    throw new Error(`Invalid run manifest: ${formatValidationErrors(validation.errors)}`)
  }

  const directory = resolve('work', options.runId)
  const destination = resolve(directory, 'run.json')
  await mkdir(directory, { recursive: true })
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${destination}\n`)
}

await main()
