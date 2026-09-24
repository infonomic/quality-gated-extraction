import { TikaClient, tikaExtractor } from '@byline/extract-tika'

import { resolveExecutionLocation } from './types.js'
import type {
  BenchmarkProvider,
  BenchmarkProviderArtifact,
  BenchmarkProviderInput,
  ExecutionLocation,
} from './types.js'

export interface TikaBenchmarkProviderOptions {
  baseUrl: string
  timeoutMs?: number
  execution?: ExecutionLocation
}

export class TikaBenchmarkProvider implements BenchmarkProvider {
  readonly tier = 'T0' as const
  readonly id = 'apache-tika'
  readonly execution: ExecutionLocation

  private readonly client: TikaClient
  private readonly extractor: ReturnType<typeof tikaExtractor>
  private versionPromise: Promise<string> | undefined

  constructor(options: TikaBenchmarkProviderOptions) {
    this.execution = resolveExecutionLocation(options.baseUrl, options.execution)
    this.client = new TikaClient({ baseUrl: options.baseUrl, timeoutMs: options.timeoutMs })
    this.extractor = tikaExtractor({
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      ocrStrategy: 'no_ocr',
    })
  }

  probeVersion(): Promise<string> {
    this.versionPromise ??= this.client.version()
    return this.versionPromise
  }

  async describe() {
    return {
      provider: {
        id: this.id,
        version: await this.probeVersion(),
        execution: this.execution,
      },
      parameters: { ocrStrategy: 'no_ocr' },
    }
  }

  async extract(input: BenchmarkProviderInput): Promise<BenchmarkProviderArtifact> {
    const version = await this.probeVersion()
    const started = performance.now()
    const result = await this.extractor.extract({
      data: input.data,
      filename: input.filename,
      mimeType: input.mimeType,
      language: input.language,
    })

    return {
      provider: {
        id: this.id,
        version,
        execution: this.execution,
      },
      parameters: {
        ocrStrategy: 'no_ocr',
      },
      representations: {
        text: result.plainText,
      },
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
      await this.client.version()
      timings.push(performance.now() - started)
    }
    return timings
  }
}
