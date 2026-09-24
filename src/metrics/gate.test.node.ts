import { gateMetrics } from './gate.js'

describe('quality-gate metrics', () => {
  test('separates unsafe accepts, unnecessary escalations and unavailable decisions', () => {
    const result = gateMetrics([
      { acceptableTiers: ['T2'], selectedTier: 'T1' },
      { acceptableTiers: ['T0', 'T2'], selectedTier: 'T2' },
      { acceptableTiers: ['T1'], selectedTier: 'T1' },
      { acceptableTiers: [], selectedTier: 'T3' },
      { acceptableTiers: ['T0'], selectedTier: null },
    ])
    expect(result.falseAccepts).toEqual({
      numerator: 2,
      denominator: 4,
      excludedCount: 1,
      value: 0.5,
    })
    expect(result.falseEscalations).toMatchObject({
      numerator: 1,
      denominator: 4,
      excludedCount: 1,
    })
  })

  test('treats a selected tier inside a non-monotonic gap as an unsafe accept', () => {
    const result = gateMetrics([
      { acceptableTiers: ['T1', 'T3'], selectedTier: 'T2' },
      { acceptableTiers: ['T1', 'T3'], selectedTier: 'T3' },
    ])
    expect(result.falseAccepts).toMatchObject({ numerator: 1, denominator: 2 })
    expect(result.falseEscalations).toMatchObject({ numerator: 1, denominator: 2 })
  })
})
