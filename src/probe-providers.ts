import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { captureEnvironment } from './environment.js'
import {
  createSyntheticBornDigitalPdf,
  createSyntheticScannedPdf,
} from './fixtures/synthetic-pdf.js'
import {
  syntheticScanEnglishControl,
  syntheticScanThaiControl,
} from './fixtures/synthetic-scan-image.js'
import { DoclingBenchmarkProvider } from './providers/docling.js'
import { PaddleOcrVlBenchmarkProvider } from './providers/paddleocr-vl.js'
import { TikaBenchmarkProvider } from './providers/tika.js'
import { probeProvider } from './providers/types.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { FetchImplementation } from './providers/http.js'
import type {
  BenchmarkProvider,
  BenchmarkProviderArtifact,
  ExecutionLocation,
  ProviderProbeResult,
} from './providers/types.js'

interface CliOptions {
  runId: string
  extractSynthetic: boolean
  configPath: string
}

interface TimingCalibration {
  providerId: string
  tiers: Array<'T0' | 'T1' | 'T2' | 'T3'>
  method: 'wall-minus-provider' | 'endpoint-round-trip'
  calibrationControl: 'T1-born-digital' | 'version-endpoint' | 'health-endpoint'
  sampleCount: number
  fixedOverheadMs: number
  providerTimingStatus: 'observed' | 'unavailable'
  marginalTimeBasis: 'provider-reported' | 'client-wall-minus-fixed-overhead'
  samples: Array<{ wallMs: number; providerMs: number | null }>
  limitation: string
}

interface ProbeBundle {
  schemaVersion: 1
  runId: string
  probes: ProviderProbeResult[]
  syntheticArtifacts: Partial<
    Record<
      'T0' | 'T1' | 'T2' | 'T3',
      Partial<Record<'bornDigital' | 'scanned' | 'scannedRepeat', BenchmarkProviderArtifact>>
    >
  >
  timingCalibrations: TimingCalibration[]
  syntheticControls: {
    scanned: {
      expectedEnglish: string
      expectedThai: string
      results: Partial<
        Record<
          'T0' | 'T1' | 'T2' | 'T3',
          {
            thaiCharacters: number
            thaiScriptPresent: boolean
            englishControlPresent: boolean
            thaiControlPresent: boolean
          }
        >
      >
    }
  }
}

function parseOptions(args: string[]): CliOptions {
  let runId: string | undefined
  let extractSynthetic = false
  let configPath = 'config/default.json'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') {
      // pnpm's argument separator is forwarded to package scripts.
    } else if (argument === '--run-id') {
      runId = args[index + 1]
      index += 1
    } else if (argument === '--extract-synthetic') {
      extractSynthetic = true
    } else if (argument === '--config') {
      configPath = args[index + 1] ?? ''
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) {
    throw new Error('--run-id is required and must be filesystem-safe')
  }
  if (!configPath) throw new Error('--config requires a path')
  return { runId, extractSynthetic, configPath }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper == null) throw new Error('Cannot calculate a median without samples')
  const lower = sorted[middle - 1]
  return sorted.length % 2 === 0 && lower != null ? (lower + upper) / 2 : upper
}

function normaliseControlText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en').replace(/\s+/gu, '')
}

async function calibrateTimings(
  providers: BenchmarkProvider[],
  artifactsByTier: ProbeBundle['syntheticArtifacts']
): Promise<TimingCalibration[]> {
  const calibrations: TimingCalibration[] = []
  const providerIds = [...new Set(providers.map((provider) => provider.id))]

  for (const providerId of providerIds) {
    const matchingProviders = providers.filter((provider) => provider.id === providerId)
    const tiers = [...new Set(matchingProviders.map((provider) => provider.tier))]
    const artifacts = tiers.flatMap((tier) => Object.values(artifactsByTier[tier] ?? {}))
    const providerTimed = artifacts.filter(
      (artifact) => artifact.timings.providerTimingStatus === 'observed'
    )

    if (providerTimed.length > 0) {
      const calibrationArtifact =
        providerId === 'docling-serve' ? artifactsByTier.T1?.bornDigital : providerTimed[0]
      if (!calibrationArtifact) throw new Error(`No timing calibration artifact for ${providerId}`)
      const calibrationSample = {
        wallMs: roundMilliseconds(calibrationArtifact.timings.wallMs),
        providerMs: roundMilliseconds(calibrationArtifact.timings.providerMs ?? 0),
      }
      const samples = [calibrationSample]
      calibrations.push({
        providerId,
        tiers,
        method: 'wall-minus-provider',
        calibrationControl: 'T1-born-digital',
        sampleCount: samples.length,
        fixedOverheadMs: roundMilliseconds(
          Math.max(0, calibrationSample.wallMs - (calibrationSample.providerMs ?? 0))
        ),
        providerTimingStatus: 'observed',
        marginalTimeBasis: 'provider-reported',
        samples,
        limitation:
          'Fixed service overhead is measured once per run on the T1 born-digital synthetic control as client wall time minus provider-reported processing time. It includes synchronous scheduling and serialisation; Docling polling and processing can overlap, so the components are reported separately rather than assumed to sum exactly to wall time.',
      })
      continue
    }

    const representative = matchingProviders[0]
    if (!representative?.measureTransportBaseline || artifacts.length === 0) continue
    const baselineSamples = await representative.measureTransportBaseline(5)
    const samples = baselineSamples.map((wallMs) => ({
      wallMs: roundMilliseconds(wallMs),
      providerMs: null,
    }))
    calibrations.push({
      providerId,
      tiers,
      method: 'endpoint-round-trip',
      calibrationControl: providerId === 'apache-tika' ? 'version-endpoint' : 'health-endpoint',
      sampleCount: samples.length,
      fixedOverheadMs: roundMilliseconds(median(samples.map((sample) => sample.wallMs))),
      providerTimingStatus: 'unavailable',
      marginalTimeBasis: 'client-wall-minus-fixed-overhead',
      samples,
      limitation:
        'The API exposes no provider-side duration. Marginal time is a client-observed proxy: extraction wall time minus the median lightweight endpoint round trip, not measured model compute.',
    })
  }

  return calibrations
}

export function providersFromEnvironment(
  options: { timeoutMs?: number; fetchImpl?: FetchImplementation } = {}
): {
  providers: BenchmarkProvider[]
  unavailable: ProviderProbeResult[]
} {
  const executionFromEnvironment = (name: string): ExecutionLocation | undefined => {
    const value = process.env[name]
    if (value == null) return undefined
    if (value === 'local' || value === 'private' || value === 'hosted') return value
    throw new Error(`${name} must be local, private, or hosted`)
  }
  const providers: BenchmarkProvider[] = [
    new TikaBenchmarkProvider({
      baseUrl: process.env.TIKA_BASE_URL ?? 'http://127.0.0.1:9998',
      timeoutMs: options.timeoutMs,
      execution: executionFromEnvironment('TIKA_EXECUTION'),
    }),
    new DoclingBenchmarkProvider({
      baseUrl: process.env.DOCLING_BASE_URL ?? 'http://127.0.0.1:5001',
      profile: 'layout',
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      execution: executionFromEnvironment('DOCLING_EXECUTION'),
    }),
    new DoclingBenchmarkProvider({
      baseUrl: process.env.DOCLING_BASE_URL ?? 'http://127.0.0.1:5001',
      profile: 'ocr',
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      execution: executionFromEnvironment('DOCLING_EXECUTION'),
      ocrLanguages: ['eng', 'tha'],
    }),
  ]
  const unavailable: ProviderProbeResult[] = []
  const paddleBaseUrl = process.env.PADDLEOCR_VL_BASE_URL

  if (paddleBaseUrl) {
    providers.push(
      new PaddleOcrVlBenchmarkProvider({
        baseUrl: paddleBaseUrl,
        execution: executionFromEnvironment('PADDLEOCR_VL_EXECUTION'),
        model: process.env.PADDLEOCR_VL_MODEL,
        version: process.env.PADDLEOCR_VL_VERSION,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      })
    )
  } else {
    unavailable.push({
      schemaVersion: 1,
      tier: 'T3',
      id: 'paddleocr-vl',
      execution: 'local',
      status: 'unavailable',
      checkedAt: new Date().toISOString(),
      error: {
        code: 'NOT_CONFIGURED',
        message: 'No local or private PaddleOCR-VL endpoint is configured.',
      },
    })
  }
  return { providers, unavailable }
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
    execution: { timeoutMs: number }
  }
  const registry = await createSchemaRegistry()
  const configValidation = registry.validate('benchmark-config', config)
  if (!configValidation.valid) {
    throw new Error(
      `Invalid benchmark configuration: ${formatValidationErrors(configValidation.errors)}`
    )
  }
  const baseManifest = captureEnvironment({
    runId: options.runId,
    config,
    configBytes,
  })
  const { providers, unavailable } = providersFromEnvironment({
    timeoutMs: config.execution.timeoutMs,
  })
  const probes = [
    ...(await Promise.all(providers.map((provider) => probeProvider(provider)))),
    ...unavailable,
  ]
  for (const probe of probes) {
    const validation = registry.validate('provider-probe', probe)
    if (!validation.valid) {
      throw new Error(`Invalid provider probe: ${formatValidationErrors(validation.errors)}`)
    }
  }

  const syntheticArtifacts: ProbeBundle['syntheticArtifacts'] = {}
  if (options.extractSynthetic) {
    const availableTiers = new Set(
      probes.filter((probe) => probe.status === 'available').map((probe) => probe.tier)
    )
    const fixtures = [
      {
        name: 'bornDigital' as const,
        input: {
          data: createSyntheticBornDigitalPdf(),
          filename: 'synthetic-born-digital.pdf',
          mimeType: 'application/pdf',
          language: 'eng',
        },
      },
      {
        name: 'scanned' as const,
        input: {
          data: createSyntheticScannedPdf(),
          filename: 'synthetic-scan.pdf',
          mimeType: 'application/pdf',
          language: 'eng+tha',
        },
      },
    ]
    const scannedFixture = fixtures[1]
    if (!scannedFixture) throw new Error('Synthetic scanned fixture is missing')
    for (const provider of providers) {
      if (!availableTiers.has(provider.tier)) continue
      const artifacts: Partial<
        Record<'bornDigital' | 'scanned' | 'scannedRepeat', BenchmarkProviderArtifact>
      > = {}
      for (const fixture of fixtures) {
        artifacts[fixture.name] = await provider.extract(fixture.input)
      }
      if (provider.tier === 'T3') {
        artifacts.scannedRepeat = await provider.extract(scannedFixture.input)
      }
      syntheticArtifacts[provider.tier] = artifacts
    }
  }

  const timingCalibrations = options.extractSynthetic
    ? await calibrateTimings(providers, syntheticArtifacts)
    : []
  const controlResults: ProbeBundle['syntheticControls']['scanned']['results'] = {}
  for (const [tier, artifacts] of Object.entries(syntheticArtifacts)) {
    const text = artifacts.scanned?.representations.text ?? ''
    controlResults[tier as 'T0' | 'T1' | 'T2' | 'T3'] = {
      thaiCharacters: [...text].filter((character) => /[\u0E00-\u0E7F]/u.test(character)).length,
      thaiScriptPresent: /[\u0E00-\u0E7F]/u.test(text),
      englishControlPresent: normaliseControlText(text).includes(
        normaliseControlText(syntheticScanEnglishControl)
      ),
      thaiControlPresent: normaliseControlText(text).includes(
        normaliseControlText(syntheticScanThaiControl)
      ),
    }
  }

  const bundle: ProbeBundle = {
    schemaVersion: 1,
    runId: options.runId,
    probes,
    syntheticArtifacts,
    timingCalibrations,
    syntheticControls: {
      scanned: {
        expectedEnglish: syntheticScanEnglishControl,
        expectedThai: syntheticScanThaiControl,
        results: controlResults,
      },
    },
  }
  const directory = resolve('work', options.runId)
  const probeDestination = resolve(directory, 'provider-probe.json')
  const runDestination = resolve(directory, 'run.json')
  await mkdir(directory, { recursive: true })
  const baseRuntime = baseManifest.runtime as Record<string, unknown>
  const manifest = {
    ...baseManifest,
    runtime: {
      ...baseRuntime,
      tika: probes.find((probe) => probe.id === 'apache-tika')?.version ?? null,
      docling: probes.find((probe) => probe.id === 'docling-serve')?.version ?? null,
    },
    providers: probes.map((probe) => ({
      tier: probe.tier,
      id: probe.id,
      version: probe.version ?? null,
      model:
        probe.tier === 'T3'
          ? (syntheticArtifacts.T3?.scanned?.provider.model ??
            process.env.PADDLEOCR_VL_MODEL ??
            null)
          : null,
      status: probe.status,
      execution: probe.execution,
    })),
    timingCalibrations,
    evidence: {
      phase: 'phase-1-provider-spike',
      authoritative: true,
      providerProbeFile: 'provider-probe.json',
    },
    limitations: [
      'Phase 1 uses deterministic synthetic fixtures only; no FORRU documents were read.',
      'Docling fixed overhead is estimated once per run from the synthetic matrix and includes its synchronous polling and response overhead.',
      'Tika and PaddleOCR-VL do not expose provider-side duration; their marginal values are explicitly labelled client-observed proxies.',
      ...probes
        .filter((probe) => probe.status === 'unavailable')
        .map((probe) => `${probe.tier} ${probe.id} was unavailable for this run.`),
    ],
    finishedAt: new Date().toISOString(),
  }
  const runValidation = registry.validate('run', manifest)
  if (!runValidation.valid) {
    throw new Error(`Invalid run manifest: ${formatValidationErrors(runValidation.errors)}`)
  }
  await writeFile(probeDestination, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' })
  await writeFile(runDestination, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${runDestination}\n${probeDestination}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
