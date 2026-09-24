import { evaluateQualityGate, type QualityGateThresholds } from './quality-gate.js'
import type { BenchmarkProviderArtifact } from './providers/types.js'

const thresholds: QualityGateThresholds = {
  characterSanity: 0.95,
  textRetention: 0.5,
  usablePageRatio: 0.5,
  structuralYield: 1,
  scriptConsistency: 0.8,
}

const healthyText = 'Forest restoration ecology การฟื้นฟูป่า ประเทศไทย'

function artifact(overrides: Partial<BenchmarkProviderArtifact> = {}): BenchmarkProviderArtifact {
  return {
    provider: { id: 'synthetic', version: '1', execution: 'local' },
    parameters: {},
    representations: { text: healthyText, structure: { blocks: [{ type: 'body' }] } },
    pages: [{ page: 1, text: healthyText }],
    timings: { wallMs: 1, providerMs: null, providerTimingStatus: 'unavailable' },
    warnings: [],
    ...overrides,
  }
}

const inspection = {
  pageCount: 1,
  totalTextChars: [...healthyText].length,
  thaiCharRatio: 0.5,
  latinCharRatio: 0.5,
  expectsStructure: true,
}

describe('quality gate components', () => {
  test('accepts retained bilingual structured text', () => {
    const result = evaluateQualityGate({ artifact: artifact(), inspection, thresholds })
    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  test('reports each implemented component failure independently', () => {
    const result = evaluateQualityGate({
      artifact: artifact({
        representations: { text: `Thai lost ${'�'.repeat(10)}` },
        pages: [{ page: 1, text: '' }],
      }),
      inspection: { ...inspection, totalTextChars: 100 },
      thresholds,
    })

    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'CHARACTER_SANITY_FAILED',
        'TEXT_RETENTION_FAILED',
        'USABLE_PAGE_RATIO_FAILED',
        'STRUCTURAL_YIELD_FAILED',
        'SCRIPT_CONSISTENCY_FAILED',
      ])
    )
  })

  test('keeps unavailable optional evidence null instead of converting it to zero', () => {
    const result = evaluateQualityGate({
      artifact: artifact({ pages: undefined, representations: { text: 'Forest restoration' } }),
      inspection: {
        pageCount: 1,
        totalTextChars: 0,
        thaiCharRatio: 0,
        latinCharRatio: 0,
        expectsStructure: false,
      },
      thresholds,
    })

    expect(result.components).toMatchObject({
      textRetention: null,
      usablePageRatio: null,
      structuralYield: null,
      scriptConsistency: null,
    })
  })

  test('flags the observed F003 generation-collapse ratio without tuning on evaluation', () => {
    const result = evaluateQualityGate({
      artifact: artifact({
        representations: { text: 'ก'.repeat(230), structure: { blocks: [{ type: 'body' }] } },
        pages: [{ page: 40, text: 'ก'.repeat(230) }],
      }),
      inspection: {
        pageCount: 1,
        totalTextChars: 2623,
        thaiCharRatio: 1,
        latinCharRatio: 0,
        expectsStructure: false,
      },
      thresholds,
    })

    expect(result.components.textRetention).toBeCloseTo(230 / 2623)
    expect(result.reasons).toContain('TEXT_RETENTION_FAILED')
  })

  test('does not mistake script consistency for a Thai-fragmentation detector', () => {
    const fragmentedThai = 'ก า ร ฟ ื้ น ฟ ู ป ่ า'
    const result = evaluateQualityGate({
      artifact: artifact({
        representations: {
          text: fragmentedThai,
          structure: { blocks: [{ type: 'body' }] },
        },
        pages: [{ page: 1, text: fragmentedThai }],
      }),
      inspection: {
        pageCount: 1,
        totalTextChars: 12,
        thaiCharRatio: 1,
        latinCharRatio: 0,
        expectsStructure: false,
      },
      thresholds,
    })

    expect(result.components.scriptConsistency).toBe(1)
    expect(result.reasons).not.toContain('SCRIPT_CONSISTENCY_FAILED')
  })
})
