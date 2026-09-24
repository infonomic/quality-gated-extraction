import {
  createSyntheticBornDigitalPdf,
  createSyntheticScannedPdf,
} from '../fixtures/synthetic-pdf.js'
import {
  createSyntheticScanImage,
  syntheticScanEnglishControl,
  syntheticScanHeight,
  syntheticScanThaiControl,
  syntheticScanWidth,
} from '../fixtures/synthetic-scan-image.js'
import { createDoclingFormData, DoclingBenchmarkProvider } from './docling.js'
import { PaddleOcrVlBenchmarkProvider } from './paddleocr-vl.js'
import { TikaBenchmarkProvider } from './tika.js'
import { probeProvider, resolveExecutionLocation } from './types.js'
import type { FetchImplementation } from './http.js'
import type { BenchmarkProviderInput } from './types.js'

const input: BenchmarkProviderInput = {
  data: createSyntheticBornDigitalPdf(),
  filename: 'synthetic.pdf',
  mimeType: 'application/pdf',
  language: 'eng',
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('synthetic PDF fixtures', () => {
  test('builds deterministic born-digital and scan-like PDFs', () => {
    const bornDigital = createSyntheticBornDigitalPdf()
    const scanned = createSyntheticScannedPdf()
    expect(Buffer.from(bornDigital).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(Buffer.from(scanned).subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(Buffer.from(bornDigital).toString('ascii')).toContain('Synthetic FORRU')
    expect(Buffer.from(scanned).toString('ascii')).not.toContain('Synthetic FORRU')
    expect(createSyntheticScanImage()).toHaveLength(syntheticScanWidth * syntheticScanHeight)
    expect(Buffer.from(scanned).includes(Buffer.from(syntheticScanEnglishControl))).toBe(false)
    expect(Buffer.from(scanned).includes(Buffer.from(syntheticScanThaiControl))).toBe(false)
  })
})

describe('execution declarations', () => {
  test('infers local only for loopback services', () => {
    expect(resolveExecutionLocation('http://127.0.0.1:9998')).toBe('local')
    expect(() => resolveExecutionLocation('https://extract.example.test')).toThrow(
      'execution must be declared'
    )
    expect(() => resolveExecutionLocation('https://extract.example.test', 'local')).toThrow(
      'cannot declare local execution'
    )
    expect(() => resolveExecutionLocation('http://localhost:5001', 'hosted')).toThrow(
      'must declare local execution'
    )
    expect(resolveExecutionLocation('https://extract.example.test', 'private')).toBe('private')
  })
})

describe('T0 Tika adapter', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('pins no_ocr and normalises a Tika 3.3.0 response', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (resource, init) => {
      const url = resource.toString()
      requests.push({ url, init })
      if (url.endsWith('/version')) return new Response('Apache Tika 3.3.0')
      return jsonResponse([
        {
          'X-TIKA:content': 'Synthetic extracted text',
          'Content-Type': 'application/pdf',
          'xmpTPg:NPages': '1',
          'pdf:charsPerPage': ['24'],
        },
      ])
    }
    vi.stubGlobal('fetch', fetchImpl)

    const provider = new TikaBenchmarkProvider({ baseUrl: 'http://127.0.0.1:9998' })
    const artifact = await provider.extract(input)
    const extractionRequest = requests.find((request) => request.url.endsWith('/rmeta/text'))
    const headers = extractionRequest?.init?.headers as Record<string, string>

    expect(artifact.provider).toMatchObject({
      id: 'apache-tika',
      version: 'Apache Tika 3.3.0',
      execution: 'local',
    })
    expect(artifact.parameters).toEqual({ ocrStrategy: 'no_ocr' })
    expect(artifact.representations.text).toContain('Synthetic extracted text')
    expect(headers['X-Tika-PDFOcrStrategy']).toBe('no_ocr')
    expect(headers['X-Tika-OCRLanguage']).toBeUndefined()
  })
})

describe('T1/T2 Docling adapter', () => {
  test('makes T1 OCR prohibition explicit in multipart fields', () => {
    const form = createDoclingFormData('layout', input, ['eng', 'tha'])
    expect(form.get('do_ocr')).toBe('false')
    expect(form.get('force_ocr')).toBe('false')
    expect(form.get('ocr_preset')).toBeNull()
    expect(form.getAll('ocr_lang')).toEqual([])
    expect(form.getAll('to_formats')).toEqual(['md', 'json'])
    expect(form.get('table_mode')).toBe('accurate')
    expect(form.get('pipeline')).toBe('standard')
  })

  test('pins T2 forced OCR and both OCR languages', () => {
    const form = createDoclingFormData('ocr', input, ['eng', 'tha'])
    expect(form.get('do_ocr')).toBe('true')
    expect(form.get('force_ocr')).toBe('true')
    expect(form.get('ocr_preset')).toBe('tesseract')
    expect(form.getAll('ocr_lang')).toEqual(['eng', 'tha'])
  })

  test('normalises Docling markdown, text, structure, and provider timing', async () => {
    let conversionHeaders: Headers | undefined
    const fetchImpl: FetchImplementation = async (resource, init) => {
      const url = resource.toString()
      if (url.endsWith('/version')) {
        return jsonResponse({
          'docling-serve': '1.29.0',
          docling: '2.118.0',
          'docling-core': '2.90.0',
          'docling-ibm-models': '3.13.3',
        })
      }
      conversionHeaders = new Headers(init?.headers)
      return jsonResponse({
        status: 'success',
        processing_time: 0.5,
        document: {
          md_content: '# Synthetic',
          json_content: {
            body: [],
            origin: { filename: 'synthetic.pdf', uri: 'file:///synthetic.pdf' },
            nested: { sourceUrl: 'https://example.test/source.pdf', semantic: 'retained' },
          },
        },
      })
    }
    const provider = new DoclingBenchmarkProvider({
      baseUrl: 'http://127.0.0.1:5001',
      profile: 'layout',
      apiKey: 'synthetic-secret',
      fetchImpl,
    })
    const artifact = await provider.extract(input)
    expect(artifact.provider).toMatchObject({
      id: 'docling-serve',
      version: 'docling-serve@1.29.0;docling@2.118.0;docling-core@2.90.0;docling-ibm-models@3.13.3',
    })
    expect(artifact.parameters).toMatchObject({
      doOcr: false,
      forceOcr: false,
      toFormats: 'md,json',
    })
    expect(artifact.representations).toMatchObject({
      text: '# Synthetic',
      markdown: '# Synthetic',
      structure: { body: [], nested: { semantic: 'retained' } },
    })
    expect(artifact.timings.providerMs).toBe(500)
    expect(artifact.timings.providerTimingStatus).toBe('observed')
    expect(conversionHeaders?.get('X-Api-Key')).toBe('synthetic-secret')
    expect(conversionHeaders?.has('Authorization')).toBe(false)
  })

  test('fails closed when Docling omits its provider duration', async () => {
    const fetchImpl: FetchImplementation = async (resource) => {
      if (resource.toString().endsWith('/version')) {
        return jsonResponse({ 'docling-serve': '1.29.0' })
      }
      return jsonResponse({
        status: 'success',
        document: { md_content: '# Synthetic', json_content: { body: [] } },
      })
    }
    const provider = new DoclingBenchmarkProvider({
      baseUrl: 'http://127.0.0.1:5001',
      profile: 'layout',
      fetchImpl,
    })

    await expect(provider.extract(input)).rejects.toThrow('processing_time is missing or invalid')
  })
})

describe('T3 PaddleOCR-VL adapter', () => {
  test('uses the full pipeline endpoint without returning binary images', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetchImpl: FetchImplementation = async (resource, init) => {
      const url = resource.toString()
      if (url.endsWith('/openapi.json')) return jsonResponse({ info: { version: '3.3.0' } })
      if (url.endsWith('/health')) return jsonResponse({ errorCode: 0, errorMsg: 'Success' })
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        errorCode: 0,
        errorMsg: 'Success',
        result: {
          layoutParsingResults: [
            {
              prunedResult: {
                parsing_res_list: [],
                origin: { filename: 'synthetic.pdf' },
              },
              markdown: { text: '# Synthetic VLM' },
            },
          ],
        },
      })
    }
    const provider = new PaddleOcrVlBenchmarkProvider({
      baseUrl: 'http://127.0.0.1:8080',
      version: 'paddleocr@3.7.0;paddlepaddle@3.2.1;paddlex@3.7.2;api@0.1.0',
      fetchImpl,
    })
    const artifact = await provider.extract(input)

    expect(requestBody).toMatchObject({
      fileType: 0,
      returnMarkdownImages: false,
      visualize: false,
    })
    expect(String(requestBody?.file)).not.toContain('://')
    expect(artifact.provider).toMatchObject({
      id: 'paddleocr-vl',
      version: 'paddleocr@3.7.0;paddlepaddle@3.2.1;paddlex@3.7.2;api@0.1.0',
      model: 'PaddleOCR-VL-0.9B',
    })
    expect(artifact.representations.markdown).toBe('# Synthetic VLM')
    expect(artifact.representations.structure).toEqual([{ parsing_res_list: [] }])
    expect(artifact.timings).toMatchObject({
      providerMs: null,
      providerTimingStatus: 'unavailable',
    })
    await expect(provider.measureTransportBaseline(2)).resolves.toHaveLength(2)
  })

  test('declares image input to the Paddle endpoint explicitly', async () => {
    let requestBody: Record<string, unknown> | undefined
    const provider = new PaddleOcrVlBenchmarkProvider({
      baseUrl: 'http://127.0.0.1:8080',
      version: 'pinned-test-version',
      fetchImpl: async (_resource, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({
          errorCode: 0,
          result: {
            layoutParsingResults: [{ markdown: { text: 'image page' }, prunedResult: {} }],
          },
        })
      },
    })

    const artifact = await provider.extract({ ...input, mimeType: 'image/png' })

    expect(requestBody?.fileType).toBe(1)
    expect(artifact.parameters.fileType).toBe(1)
  })
})

describe('provider probes', () => {
  test('records unavailability without timing or artifact fields', async () => {
    const provider = {
      tier: 'T3' as const,
      id: 'unavailable-vlm',
      execution: 'local' as const,
      probeVersion: async () => {
        throw new Error('not running')
      },
      describe: async () => {
        throw new Error('not running')
      },
      extract: async () => {
        throw new Error('not running')
      },
    }
    const result = await probeProvider(provider, () => new Date('2026-08-05T00:00:00.000Z'))
    expect(result).toMatchObject({
      status: 'unavailable',
      error: { code: 'PROVIDER_UNAVAILABLE' },
    })
    expect(result).not.toHaveProperty('wallMs')
    expect(result).not.toHaveProperty('artifactKey')
  })
})
