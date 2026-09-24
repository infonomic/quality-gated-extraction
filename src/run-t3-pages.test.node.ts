import { expectedT3PageCells } from './run-t3-pages.js'

describe('T3 page matrix', () => {
  test('orders calibration before evaluation with stable page cell names', () => {
    expect(
      expectedT3PageCells({
        status: 'frozen',
        provenance: { sampleHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) },
        denominators: { calibrationPages: 2, evaluationPages: 2, totalPages: 4 },
        calibration: [
          {
            caseId: 'F001',
            stratum: 'born-digital-en',
            documentPageCount: 10,
            pages: [1, 10],
          },
        ],
        evaluation: [
          {
            caseId: 'F002',
            stratum: 'scanned-degraded-en',
            documentPageCount: 20,
            pages: [3, 20],
          },
        ],
      })
    ).toEqual([
      'calibration-F001-P0001-T3.json',
      'calibration-F001-P0010-T3.json',
      'evaluation-F002-P0003-T3.json',
      'evaluation-F002-P0020-T3.json',
    ])
  })
})
