import { buildT3PageBudget } from './t3-page-budget.js'

const dense = {
  runId: 'dense-page-test',
  status: 'succeeded' as const,
  wallMs: 40_000,
  recognitionRegions: 10,
  wallMsPerRecognitionRegion: 4_000,
  provider: {
    id: 'paddleocr-vl',
    version: 'test',
    model: 'PaddleOCR-VL-0.9B',
    execution: 'local',
    device: 'cpu',
  },
  source: { caseId: 'F129', page: 2, contentHash: 'a'.repeat(64) },
}

const censored = {
  caseId: 'F129',
  status: 'censored' as const,
  observedMinimumWallMs: 1_461_000,
}

const sample = {
  calibration: Array.from({ length: 8 }, (_, index) => ({ caseId: `C${index}` })),
  evaluation: Array.from({ length: 16 }, (_, index) => ({
    caseId: `E${index}`,
    pages: [1, 2],
  })),
  denominators: { evaluationDocuments: 16, annotationPages: 32 },
}

describe('T3 page-subset budget', () => {
  test('keeps the censored document lower bound separate from page projections', () => {
    const result = buildT3PageBudget({ dense, censored, sample })

    expect(result.subset).toMatchObject({
      calibrationDocuments: 8,
      calibrationPages: 16,
      evaluationDocuments: 16,
      evaluationPages: 32,
      totalPages: 48,
    })
    expect(result.projections.denseWarm.wallMs).toBe(1_920_000)
    expect(result.censored.observedMinimumWallMs).toBe(1_461_000)
    expect(result.allowance.denseWarmFits).toBe(true)
    expect(result.allowance.sensitivity2xFits).toBe(true)
    expect(result.labels.fullDocumentDuration).toBe('censored')
    expect(result.labels.subsetDurations).toBe('projected')
  })

  test('rejects a changed evaluation page denominator', () => {
    expect(() =>
      buildT3PageBudget({
        dense,
        censored,
        sample: { ...sample, evaluation: [{ caseId: 'E1', pages: [1] }] },
      })
    ).toThrow(/two pages/u)
  })
})
