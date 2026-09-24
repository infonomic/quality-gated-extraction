export type ExtractionTier = 'T0' | 'T1' | 'T2' | 'T3'
export type ExecutionLocation = 'local' | 'private' | 'hosted'
export type ParameterValue = string | number | boolean | null

export interface ProviderIdentity {
  id: string
  version: string
  model?: string
  execution: ExecutionLocation
}

export interface BenchmarkProviderInput {
  data: Uint8Array
  filename: string
  mimeType: string
  language?: string
}

export interface BenchmarkProviderArtifact {
  provider: ProviderIdentity
  parameters: Record<string, ParameterValue>
  representations: {
    text: string
    markdown?: string
    structure?: unknown
  }
  pages?: Array<{
    page: number
    text?: string
    blocks?: unknown[]
  }>
  timings: {
    wallMs: number
    providerMs: number | null
    providerTimingStatus: 'observed' | 'unavailable'
  }
  usage?: {
    cpuSeconds?: number
    gpuSeconds?: number
    inputTokens?: number
    outputTokens?: number
    billedCost?: number
    currency?: string
  }
  warnings: string[]
}

export interface BenchmarkProvider {
  readonly tier: ExtractionTier
  readonly id: string
  readonly execution: ExecutionLocation
  probeVersion(): Promise<string>
  describe(): Promise<{
    provider: ProviderIdentity
    parameters: Record<string, ParameterValue>
  }>
  extract(input: BenchmarkProviderInput): Promise<BenchmarkProviderArtifact>
  measureTransportBaseline?(samples: number): Promise<number[]>
}

const forbiddenStructuredKeys = new Set([
  'filename',
  'origin',
  'path',
  'sourceurl',
  'storagepath',
  'uri',
  'url',
])

/**
 * Remove source-identifying and location-bearing fields before provider JSON
 * crosses the benchmark adapter boundary. The benchmark retains semantic
 * structure, but never trusts an unconstrained provider payload as safe.
 */
export function sanitiseProviderStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitiseProviderStructure)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !forbiddenStructuredKeys.has(key.toLowerCase()))
      .map(([key, child]) => [key, sanitiseProviderStructure(child)])
  )
}

export interface ProviderProbeResult {
  schemaVersion: 1
  tier: ExtractionTier
  id: string
  execution: ExecutionLocation
  status: 'available' | 'unavailable'
  version?: string
  checkedAt: string
  error?: {
    code: string
    message: string
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string
  ) {
    super(`${provider} request failed: ${status} ${statusText}`)
    this.name = 'ProviderHttpError'
  }
}

export class ProviderResponseError extends Error {
  constructor(
    readonly provider: string,
    message: string
  ) {
    super(`${provider} response invalid: ${message}`)
    this.name = 'ProviderResponseError'
  }
}

export function resolveExecutionLocation(
  baseUrl: string,
  requested?: ExecutionLocation
): ExecutionLocation {
  const hostname = new URL(baseUrl).hostname
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (loopback) {
    if (requested && requested !== 'local') {
      throw new Error(`loopback provider ${hostname} must declare local execution`)
    }
    return 'local'
  }
  if (!requested) {
    throw new Error(`execution must be declared for non-loopback provider ${hostname}`)
  }
  if (requested === 'local') {
    throw new Error(`non-loopback provider ${hostname} cannot declare local execution`)
  }
  return requested
}

export async function probeProvider(
  provider: BenchmarkProvider,
  now: () => Date = () => new Date()
): Promise<ProviderProbeResult> {
  try {
    return {
      schemaVersion: 1,
      tier: provider.tier,
      id: provider.id,
      execution: provider.execution,
      status: 'available',
      version: await provider.probeVersion(),
      checkedAt: now().toISOString(),
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      tier: provider.tier,
      id: provider.id,
      execution: provider.execution,
      status: 'unavailable',
      checkedAt: now().toISOString(),
      error: {
        code: error instanceof ProviderHttpError ? 'PROVIDER_HTTP_ERROR' : 'PROVIDER_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Unknown provider error',
      },
    }
  }
}
