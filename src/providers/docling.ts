import { FormData as UndiciFormData, fetch as undiciFetch } from 'undici'

import { type FetchImplementation, fetchOrThrow } from './http.js'
import {
  ProviderResponseError,
  resolveExecutionLocation,
  sanitiseProviderStructure,
} from './types.js'
import type {
  BenchmarkProvider,
  BenchmarkProviderArtifact,
  BenchmarkProviderInput,
  ExecutionLocation,
  ParameterValue,
} from './types.js'

export type DoclingProfile = 'layout' | 'ocr'

export interface DoclingBenchmarkProviderOptions {
  baseUrl: string
  profile: DoclingProfile
  timeoutMs?: number
  execution?: ExecutionLocation
  ocrLanguages?: string[]
  apiKey?: string
  fetchImpl?: FetchImplementation
}

interface DoclingResponse {
  status?: string
  processing_time?: number
  errors?: unknown[]
  document?: {
    md_content?: string
    text_content?: string
    json_content?: unknown
  }
}

const doclingVersionKeys = [
  'docling-serve',
  'docling',
  'docling-core',
  'docling-ibm-models',
  'docling-parse',
] as const

export function versionFromDocling(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new ProviderResponseError('docling-serve', 'version response is not an object')
  }
  const versions = value as Record<string, unknown>
  if (typeof versions['docling-serve'] !== 'string') {
    throw new ProviderResponseError('docling-serve', 'version response has no server version')
  }
  return doclingVersionKeys
    .filter((key) => typeof versions[key] === 'string')
    .map((key) => `${key}@${versions[key]}`)
    .join(';')
}

export function doclingParameters(
  profile: DoclingProfile,
  ocrLanguages: string[]
): Record<string, ParameterValue> {
  return {
    pipeline: 'standard',
    tableMode: 'accurate',
    imageExportMode: 'placeholder',
    toFormats: 'md,json',
    doOcr: profile === 'ocr',
    forceOcr: profile === 'ocr',
    ocrPreset: profile === 'ocr' ? 'tesseract' : null,
    ocrLanguages: profile === 'ocr' ? ocrLanguages.join(',') : null,
  }
}

export function createDoclingFormData(
  profile: DoclingProfile,
  input: BenchmarkProviderInput,
  ocrLanguages: string[]
): UndiciFormData {
  // Must be undici's FormData: undici's fetch does not recognise Node's global
  // FormData and silently drops the file field, which docling-serve rejects as
  // `422 {"loc":["body","files"],"msg":"Field required"}`.
  const form = new UndiciFormData()
  const fileBuffer = new ArrayBuffer(input.data.byteLength)
  new Uint8Array(fileBuffer).set(input.data)
  form.append('files', new Blob([fileBuffer], { type: input.mimeType }), input.filename)
  form.append('from_formats', 'pdf')
  form.append('to_formats', 'md')
  form.append('to_formats', 'json')
  form.append('pipeline', 'standard')
  form.append('table_mode', 'accurate')
  form.append('image_export_mode', 'placeholder')
  form.append('do_ocr', profile === 'ocr' ? 'true' : 'false')
  form.append('force_ocr', profile === 'ocr' ? 'true' : 'false')

  if (profile === 'ocr') {
    form.append('ocr_preset', 'tesseract')
    for (const language of ocrLanguages) form.append('ocr_lang', language)
  }
  return form
}

export class DoclingBenchmarkProvider implements BenchmarkProvider {
  readonly tier: 'T1' | 'T2'
  readonly id = 'docling-serve'
  readonly execution: ExecutionLocation

  private readonly baseUrl: string
  private readonly profile: DoclingProfile
  private readonly timeoutMs: number
  private readonly ocrLanguages: string[]
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchImplementation
  private versionPromise: Promise<string> | undefined

  constructor(options: DoclingBenchmarkProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.profile = options.profile
    this.tier = options.profile === 'layout' ? 'T1' : 'T2'
    this.execution = resolveExecutionLocation(options.baseUrl, options.execution)
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.ocrLanguages = options.ocrLanguages ?? ['eng', 'tha']
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchImplementation)
  }

  probeVersion(): Promise<string> {
    this.versionPromise ??= this.readVersion()
    return this.versionPromise
  }

  async describe() {
    return {
      provider: {
        id: this.id,
        version: await this.probeVersion(),
        execution: this.execution,
      },
      parameters: doclingParameters(this.profile, this.ocrLanguages),
    }
  }

  async extract(input: BenchmarkProviderInput): Promise<BenchmarkProviderArtifact> {
    const version = await this.probeVersion()
    const form = createDoclingFormData(this.profile, input, this.ocrLanguages)
    const started = performance.now()
    const response = await fetchOrThrow(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/v1/convert/file`,
      {
        method: 'POST',
        body: form,
        headers: this.apiKey ? { 'X-Api-Key': this.apiKey } : undefined,
      },
      this.timeoutMs
    )
    const value = (await response.json()) as DoclingResponse
    const document = value.document
    if (!document) throw new ProviderResponseError(this.id, 'document is missing')
    if (typeof value.processing_time !== 'number' || value.processing_time < 0) {
      throw new ProviderResponseError(this.id, 'processing_time is missing or invalid')
    }
    const markdown = document.md_content ?? ''
    const text = document.text_content ?? markdown

    return {
      provider: {
        id: this.id,
        version,
        execution: this.execution,
      },
      parameters: doclingParameters(this.profile, this.ocrLanguages),
      representations: {
        text,
        markdown,
        structure: sanitiseProviderStructure(document.json_content),
      },
      timings: {
        wallMs: performance.now() - started,
        providerMs: value.processing_time * 1000,
        providerTimingStatus: 'observed',
      },
      warnings: value.errors?.length ? ['DOCLING_REPORTED_ERRORS'] : [],
    }
  }

  private async readVersion(): Promise<string> {
    const response = await fetchOrThrow(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/version`,
      { method: 'GET' },
      Math.min(this.timeoutMs, 10_000)
    )
    return versionFromDocling(await response.json())
  }
}
