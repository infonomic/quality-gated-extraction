import { timingAndCostMetrics } from './cost.js'

describe('timing and cost metrics', () => {
  test('keeps raw, fixed, provider marginal, billed and proxy values separate', () => {
    const result = timingAndCostMetrics({
      wallMs: 2000,
      t0WallMs: 100,
      fixedOverheadMs: 500,
      providerMs: 1400,
      providerTimingStatus: 'observed',
      billedCost: null,
      machineHourlyRate: 1,
    })
    expect(result.rawWallMs).toMatchObject({ numerator: 2000, denominator: 1, excludedCount: 0 })
    expect(result.marginalDuration).toMatchObject({
      numerator: 1400,
      basis: 'provider-reported',
    })
    expect(result.t0NormalisedRatio.value).toBe(20)
    expect(result.billedUsage).toEqual({
      numerator: 0,
      denominator: 0,
      excludedCount: 1,
      value: null,
    })
    expect(result.machineTimeProxy.value).toBeCloseTo(2 / 3600)
  })

  test('labels wall-minus-overhead as a client-observed proxy', () => {
    const result = timingAndCostMetrics({
      wallMs: 2000,
      t0WallMs: 100,
      fixedOverheadMs: 500,
      providerMs: null,
      providerTimingStatus: 'unavailable',
      billedCost: 0,
      machineHourlyRate: 0.1,
    })
    expect(result.marginalDuration).toMatchObject({
      numerator: 1500,
      basis: 'client-observed-wall-minus-baseline-proxy',
    })
    expect(result.t0NormalisedRatio.value).toBe(20)
    expect(result.billedUsage.value).toBe(0)
  })

  test('rejects a zero T0 baseline instead of treating it as unavailable evidence', () => {
    expect(() =>
      timingAndCostMetrics({
        wallMs: 1,
        t0WallMs: 0,
        fixedOverheadMs: 0,
        providerMs: null,
        providerTimingStatus: 'unavailable',
        billedCost: null,
        machineHourlyRate: 0.1,
      })
    ).toThrow('T0 baseline must be a positive observed duration')
  })
})
