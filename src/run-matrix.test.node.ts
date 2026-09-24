import { assertMatrixComplete, expectedMatrixCells, reachedNewCellLimit } from './run-matrix.js'
import type { ProviderRunCell } from './run-matrix.js'

const sample = {
  calibration: [{ caseId: 'F001', stratum: 'born-digital-en' as const }],
  evaluation: [{ caseId: 'F002', stratum: 'scanned-degraded-en' as const }],
}

function cell(caseId: string, tier: ProviderRunCell['tier']): ProviderRunCell {
  return {
    schemaVersion: 1,
    caseId,
    tier,
    provider: { id: 'synthetic', version: '1', execution: 'local' },
    status: tier === 'T3' ? 'unavailable' : 'succeeded',
    cache: { hit: false },
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:00:01.000Z',
    ...(tier === 'T3'
      ? { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Synthetic unavailable tier' } }
      : { artifactKey: tier.slice(1).padEnd(64, 'a'), wallMs: 1 }),
  }
}

describe('provider matrix completeness', () => {
  test('orders calibration before evaluation and requires every document-tier cell', () => {
    expect(expectedMatrixCells(sample)).toEqual([
      'calibration-F001-T0.json',
      'calibration-F001-T1.json',
      'calibration-F001-T2.json',
      'evaluation-F002-T0.json',
      'evaluation-F002-T1.json',
      'evaluation-F002-T2.json',
    ])
    const cells = ['F001', 'F002'].flatMap((caseId) =>
      (['T0', 'T1', 'T2'] as const).map((tier) => cell(caseId, tier))
    )
    expect(() => assertMatrixComplete(sample, cells)).not.toThrow()
  })

  test('rejects a missing document-tier cell rather than shrinking the denominator', () => {
    const cells = ['F001', 'F002'].flatMap((caseId) =>
      (['T0', 'T1'] as const).map((tier) => cell(caseId, tier))
    )
    expect(() => assertMatrixComplete(sample, cells)).toThrow(/missing=.*T2/u)
  })

  test('stops only after the requested number of newly written cells', () => {
    expect(reachedNewCellLimit(0, 1)).toBe(false)
    expect(reachedNewCellLimit(1, 1)).toBe(true)
    expect(reachedNewCellLimit(2, 2)).toBe(true)
    expect(reachedNewCellLimit(100, null)).toBe(false)
  })
})
