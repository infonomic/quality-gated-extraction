import { type MetricValue, ratio } from './types.js'

export interface TimingObservation {
  wallMs: number
  t0WallMs: number
  fixedOverheadMs: number
  providerMs: number | null
  providerTimingStatus: 'observed' | 'unavailable'
  billedCost: number | null
  machineHourlyRate: number
}

function measurement(value: number, excludedCount = 0): MetricValue {
  return ratio(value, 1, excludedCount)
}

export function timingAndCostMetrics(observation: TimingObservation) {
  if (observation.wallMs < 0 || observation.fixedOverheadMs < 0) {
    throw new Error('Observed durations cannot be negative')
  }
  if (observation.t0WallMs <= 0) {
    throw new Error('T0 baseline must be a positive observed duration')
  }
  if (observation.machineHourlyRate < 0) throw new Error('Machine-hour rate cannot be negative')
  const providerReported =
    observation.providerTimingStatus === 'observed' && observation.providerMs != null
  const marginalMs = providerReported
    ? (observation.providerMs ?? 0)
    : Math.max(0, observation.wallMs - observation.fixedOverheadMs)
  return {
    rawWallMs: measurement(observation.wallMs),
    fixedOverheadMs: measurement(observation.fixedOverheadMs),
    marginalDuration: {
      ...measurement(marginalMs),
      basis: providerReported
        ? ('provider-reported' as const)
        : ('client-observed-wall-minus-baseline-proxy' as const),
    },
    t0NormalisedRatio: ratio(observation.wallMs, observation.t0WallMs),
    billedUsage:
      observation.billedCost == null
        ? ratio(0, 0, 1)
        : { ...measurement(observation.billedCost), currency: 'USD' as const },
    machineTimeProxy: {
      ...measurement((observation.wallMs / 3_600_000) * observation.machineHourlyRate),
      currency: 'USD' as const,
      label: 'disclosed-proxy' as const,
    },
  }
}
