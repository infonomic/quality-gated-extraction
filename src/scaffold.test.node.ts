import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { type CommandRunner, captureEnvironment } from './environment.js'
import { schemaFixtures } from './schema-fixtures.js'
import { createSchemaRegistry, readSchema, schemaNames } from './schema-registry.js'

describe('benchmark schemas', () => {
  test('validates a synthetic record against every schema', async () => {
    const registry = await createSchemaRegistry()

    for (const name of schemaNames) {
      const result = registry.validate(name, schemaFixtures[name])
      expect(result.errors, `${name}: ${JSON.stringify(result.errors)}`).toEqual([])
      expect(result.valid).toBe(true)
    }
  })

  test('keeps pending annotation records free of oracle fields', async () => {
    const registry = await createSchemaRegistry()
    const pending = {
      schemaVersion: 1,
      annotationStatus: 'pending',
      caseId: 'F001',
      page: 1,
      script: 'pending',
      elements: [],
      boundaryOpportunities: [],
    }
    expect(registry.validate('annotation', pending).valid).toBe(true)
    expect(registry.validate('annotation', { ...pending, lowestUsableTier: 'T0' }).valid).toBe(
      false
    )
    expect(
      registry.validate('annotation', {
        ...pending,
        structurallyAdequateTiers: [],
      }).valid
    ).toBe(false)
    expect(
      registry.validate('annotation', {
        ...schemaFixtures.annotation,
        annotator: undefined,
      }).valid
    ).toBe(false)
    expect(
      registry.validate('annotation', {
        ...schemaFixtures.annotation,
        structurallyAdequateTiers: undefined,
      }).valid
    ).toBe(false)
    expect(
      registry.validate('annotation', {
        ...schemaFixtures.annotation,
        structuralAssessmentConfirmed: undefined,
      }).valid
    ).toBe(false)
    expect(
      registry.validate('annotation', {
        ...schemaFixtures.annotation,
        degradedTiers: undefined,
      }).valid
    ).toBe(false)
  })

  test('does not let an oracle-only annotation masquerade as structural ground truth', async () => {
    const registry = await createSchemaRegistry()
    const oracleOnly = {
      ...schemaFixtures.annotation,
      annotationStatus: 'oracle-complete',
      elements: [],
      boundaryOpportunities: [],
      structuralScope: {
        status: 'unavailable',
        ruleId: 'not-annotated-v1',
        description: 'Not annotated.',
      },
    }
    expect(registry.validate('annotation', oracleOnly).valid).toBe(true)
    expect(
      registry.validate('annotation', {
        ...oracleOnly,
        elements: [{ id: 'e1', type: 'body', text: 'hidden partial', readingOrder: 0 }],
      }).valid
    ).toBe(false)
  })

  test('does not declare or require identifying metadata fields', async () => {
    const forbidden = new Set([
      'title',
      'url',
      'uri',
      'filename',
      'path',
      'storagepath',
      'sourceurl',
    ])

    const visit = (value: unknown, path: string, failures: string[]): void => {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) visit(item, `${path}/${index}`, failures)
        return
      }
      if (!value || typeof value !== 'object') return

      const record = value as Record<string, unknown>
      if (Array.isArray(record.required)) {
        for (const field of record.required) {
          if (typeof field === 'string' && forbidden.has(field.toLowerCase())) {
            failures.push(`${path}/required:${field}`)
          }
        }
      }
      if (record.properties && typeof record.properties === 'object') {
        for (const field of Object.keys(record.properties)) {
          if (forbidden.has(field.toLowerCase())) failures.push(`${path}/properties:${field}`)
        }
      }
      for (const [key, child] of Object.entries(record)) visit(child, `${path}/${key}`, failures)
    }

    const failures: string[] = []
    for (const name of schemaNames) visit(await readSchema(name), name, failures)
    expect(failures).toEqual([])
  })

  test('accepts a censored observation only as a lower bound', async () => {
    const registry = await createSchemaRegistry()
    const base = {
      ...schemaFixtures['provider-run'],
      status: 'censored',
      finishedAt: '2026-08-05T10:19:00.000Z',
      error: { code: 'CLIENT_ABORTED_DIAGNOSTIC', message: 'cancelled before completion' },
    }

    // A censored cell carries a lower bound and no completed measurement.
    expect(
      registry.validate('provider-run', { ...base, observedMinimumWallMs: 1_461_000 }).valid
    ).toBe(true)

    // It must not masquerade as a completed timing or produce an artifact.
    for (const measurement of [{ wallMs: 1_461_000 }, { artifactKey: 'e'.repeat(64) }]) {
      const result = registry.validate('provider-run', {
        ...base,
        observedMinimumWallMs: 1_461_000,
        ...measurement,
      })
      expect(result.valid, JSON.stringify(measurement)).toBe(false)
    }

    // A censored cell without its lower bound is not a usable record.
    expect(registry.validate('provider-run', base).valid).toBe(false)

    // No other status may borrow the lower-bound field.
    expect(
      registry.validate('provider-run', {
        ...schemaFixtures['provider-run'],
        observedMinimumWallMs: 1_461_000,
      }).valid
    ).toBe(false)
  })

  test('forbids zero timing and artifacts for an unavailable provider', async () => {
    const registry = await createSchemaRegistry()
    const unavailableWithMeasurement = {
      ...schemaFixtures['provider-run'],
      artifactKey: 'd'.repeat(64),
      wallMs: 0,
    }
    const result = registry.validate('provider-run', unavailableWithMeasurement)
    expect(result.valid).toBe(false)
  })

  test('rejects path-like extraction parameters', async () => {
    const registry = await createSchemaRegistry()
    const artifact = {
      ...schemaFixtures.artifact,
      parameters: { sourcePath: '/private/publication-files/example.pdf' },
    }
    expect(registry.validate('artifact', artifact).valid).toBe(false)
  })

  test('rejects source-identifying keys in provider structure', async () => {
    const registry = await createSchemaRegistry()
    const artifact = {
      ...schemaFixtures.artifact,
      representations: {
        text: 'synthetic text',
        structure: { body: [], origin: { filename: 'source.pdf', uri: 'file:///source.pdf' } },
      },
    }
    expect(registry.validate('artifact', artifact).valid).toBe(false)
  })

  test('requires an honest provider timing state', async () => {
    const registry = await createSchemaRegistry()
    const missingProviderTime = {
      ...schemaFixtures.artifact,
      timings: { wallMs: 10, providerTimingStatus: 'observed', providerMs: null },
    }
    expect(registry.validate('artifact', missingProviderTime).valid).toBe(false)
  })

  test('requires non-null values for available paper labels', async () => {
    const registry = await createSchemaRegistry()
    const paperValue = { ...schemaFixtures['paper-value'], label: 'observed', value: null }
    expect(registry.validate('paper-value', paperValue).valid).toBe(false)
  })

  test('validates the checked-in default configuration', async () => {
    const registry = await createSchemaRegistry()
    const config = JSON.parse(await readFile(resolve('config/default.json'), 'utf8')) as unknown
    const result = registry.validate('benchmark-config', config)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  test('records all 27 threshold candidates and conservative tie-breaking', async () => {
    const config = JSON.parse(await readFile(resolve('config/default.json'), 'utf8')) as {
      routing: {
        thresholdGrid: Record<string, unknown[]>
        tuning: { recordAllCandidates: boolean; tieBreak: string }
      }
      cost: { cpuMachineHour: number; gpuMachineHour: number; basis: string }
    }
    const candidateCount = Object.values(config.routing.thresholdGrid).reduce(
      (count, values) => count * values.length,
      1
    )

    expect(candidateCount).toBe(27)
    expect(config.routing.tuning).toEqual({
      recordAllCandidates: true,
      tieBreak: 'conservative',
    })
    expect(config.cost.cpuMachineHour).toBeGreaterThan(0)
    expect(config.cost.gpuMachineHour).toBeGreaterThan(0)
    expect(config.cost.basis).toContain('proxy')
  })
})

describe('privacy boundary', () => {
  test('ignores the real synthetic privacy probes', () => {
    const repositoryRoot = resolve('../..')
    const probes = [
      'benchmarks/extraction/work/privacy-probe.synthetic.txt',
      'benchmarks/extraction/annotations/private/privacy-probe.private.json',
    ]

    const output = execFileSync('git', ['check-ignore', '--verbose', ...probes], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    for (const probe of probes) expect(output).toContain(probe)
  })
})

describe('environment capture', () => {
  test('records a dirty repository without reading documents or providers', () => {
    const runCommand: CommandRunner = (command, args) => {
      const key = `${command} ${args.join(' ')}`
      const values: Record<string, string> = {
        'git rev-parse HEAD': 'c'.repeat(40),
        'git status --porcelain': ' M synthetic',
        'pnpm --version': '11.10.0',
        'java -version': 'openjdk synthetic',
      }
      return { stdout: values[key] ?? '', stderr: '', status: key in values ? 0 : 1 }
    }

    const manifest = captureEnvironment({
      runId: 'synthetic-run',
      config: {
        experimentId: 'synthetic-experiment',
        seed: 'synthetic-seed',
        cost: {
          currency: 'USD',
          cpuMachineHour: 0.1,
          gpuMachineHour: 1,
          basis: 'Synthetic declared proxy tariffs.',
        },
      },
      configBytes: Buffer.from('{}'),
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      runCommand,
    })

    expect(manifest).toMatchObject({
      runId: 'synthetic-run',
      git: { commit: 'c'.repeat(40), dirty: true },
      runtime: { pnpm: '11.10.0', java: 'openjdk synthetic' },
      providers: [],
      startedAt: '2026-08-05T00:00:00.000Z',
    })
  })
})
