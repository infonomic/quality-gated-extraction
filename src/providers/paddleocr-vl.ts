import { type FetchImplementation, fetchOrThrow, versionFromOpenApi } from './http.js'
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
} from './types.js'

export interface PaddleOcrVlBenchmarkProviderOptions {
  baseUrl: string
  model?: string
  version?: string
  timeoutMs?: number
  execution?: ExecutionLocation
  apiKey?: string
  fetchImpl?: FetchImplementation
}

interface PaddleLayoutResult {
  prunedResult?: unknown
  markdown?: {
    text?: string
  }
}

interface PaddleResponse {
  errorCode?: number
  errorMsg?: string
  result?: {
    layoutParsingResults?: PaddleLayoutResult[]
  }
}

export function paddleFileType(mimeType: string): 0 | 1 {
  return mimeType.startsWith('image/') ? 1 : 0
}

export class PaddleOcrVlBenchmarkProvider implements BenchmarkProvider {
  readonly tier = 'T3' as const
  readonly id = 'paddleocr-vl'
  readonly execution: ExecutionLocation

  private readonly baseUrl: string
  private readonly model: string
  private readonly declaredVersion: string | undefined
  private readonly timeoutMs: number
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchImplementation
  private versionPromise: Promise<string> | undefined

  constructor(options: PaddleOcrVlBenchmarkProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model ?? 'PaddleOCR-VL-0.9B'
    this.declaredVersion = options.version
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.execution = resolveExecutionLocation(options.baseUrl, options.execution)
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
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
        model: this.model,
        execution: this.execution,
      },
      parameters: {
        fileType: 0,
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        returnMarkdownImages: false,
        prettifyMarkdown: true,
        visualize: false,
      },
    }
  }

  async extract(input: BenchmarkProviderInput): Promise<BenchmarkProviderArtifact> {
    const version = await this.probeVersion()
    const fileType = paddleFileType(input.mimeType)
    const started = performance.now()
    const response = await fetchOrThrow(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/layout-parsing`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          file: Buffer.from(input.data).toString('base64'),
          fileType,
          useDocOrientationClassify: false,
          useDocUnwarping: false,
          returnMarkdownImages: false,
          prettifyMarkdown: true,
          visualize: false,
        }),
      },
      this.timeoutMs
    )
    const value = (await response.json()) as PaddleResponse
    if (value.errorCode != null && value.errorCode !== 0) {
      throw new ProviderResponseError(this.id, `error ${value.errorCode}: ${value.errorMsg ?? ''}`)
    }
    const results = value.result?.layoutParsingResults
    if (!results?.length)
      throw new ProviderResponseError(this.id, 'layoutParsingResults is missing')

    const pages = results.map((result, index) => ({
      page: index + 1,
      text: result.markdown?.text ?? '',
      blocks: result.prunedResult == null ? [] : [sanitiseProviderStructure(result.prunedResult)],
    }))
    const markdown = pages.map((page) => page.text).join('\n\n')

    return {
      provider: {
        id: this.id,
        version,
        model: this.model,
        execution: this.execution,
      },
      parameters: {
        fileType,
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        returnMarkdownImages: false,
        prettifyMarkdown: true,
        visualize: false,
      },
      representations: {
        text: markdown,
        markdown,
        structure: results.map((result) => sanitiseProviderStructure(result.prunedResult ?? null)),
      },
      pages,
      timings: {
        wallMs: performance.now() - started,
        providerMs: null,
        providerTimingStatus: 'unavailable',
      },
      warnings: [],
    }
  }

  async measureTransportBaseline(samples: number): Promise<number[]> {
    const timings: number[] = []
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now()
      await fetchOrThrow(
        this.id,
        this.fetchImpl,
        `${this.baseUrl}/health`,
        { method: 'GET' },
        Math.min(this.timeoutMs, 10_000)
      )
      timings.push(performance.now() - started)
    }
    return timings
  }

  private async readVersion(): Promise<string> {
    if (this.declaredVersion) return this.declaredVersion
    const response = await fetchOrThrow(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/openapi.json`,
      { method: 'GET' },
      Math.min(this.timeoutMs, 10_000)
    )
    return `api@${versionFromOpenApi(await response.json(), this.id)}`
  }
}
