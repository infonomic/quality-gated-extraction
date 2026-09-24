import { summariseT3PageRuns } from './summarise-t3-pages.js'
import type { ProviderRunCell } from './run-matrix.js'
import type { PageDeclaration } from './run-t3-pages.js'

const declaration: PageDeclaration = {
  status: 'frozen',
  provenance: { sampleHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) },
  denominators: { calibrationPages: 1, evaluationPages: 1, totalPages: 2 },
  calibration: [
    {
      caseId: 'F001',
      stratum: 'born-digital-en',
      documentPageCount: 2,
      pages: [1],
    },
  ],
  evaluation: [
    {
      caseId: 'F002',
      stratum: 'scanned-degraded-thai-mixed',
      documentPageCount: 2,
      pages: [2],
    },
  ],
}

function cell(caseId: string, page: number, wallMs: number): ProviderRunCell {
  return {
    schemaVersion: 1,
    caseId,
    page,
    inputContentHash: 'c'.repeat(64),
    tier: 'T3',
    provider: {
      id: 'paddleocr-vl',
      version: 'pinned',
      model: 'PaddleOCR-VL-0.9B',
      execution: 'local',
    },
    status: 'succeeded',
    cache: { hit: false },
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:00:01.000Z',
    artifactKey: 'd'.repeat(64),
    wallMs,
  }
}

describe('T3 page summary', () => {
  test('keeps calibration and evaluation denominators separate', () => {
    const summary = summariseT3PageRuns({
      declaration,
      cellsByName: new Map([
        ['calibration-F001-P0001-T3.json', cell('F001', 1, 100)],
        ['evaluation-F002-P0002-T3.json', cell('F002', 2, 300)],
      ]),
    })

    expect(summary.overall.timing.totalWallMs).toBe(400)
    expect(summary.byPartition.calibration.timing.totalWallMs).toBe(100)
    expect(summary.byPartition.evaluation.timing.totalWallMs).toBe(300)
    expect(summary.evaluationByStratum['scanned-degraded-thai-mixed']?.pages).toEqual({
      numerator: 1,
      denominator: 1,
      excludedCount: 0,
    })
    expect(summary.censoredFullDocumentObservation.includedInPageTiming).toBe(false)
  })

  test('rejects a missing page cell', () => {
    expect(() => summariseT3PageRuns({ declaration, cellsByName: new Map() })).toThrow(/missing=/u)
  })
})
