export interface MetricValue {
  numerator: number
  denominator: number
  excludedCount: number
  value: number | null
}

export function ratio(numerator: number, denominator: number, excludedCount = 0): MetricValue {
  return {
    numerator,
    denominator,
    excludedCount,
    value:
      denominator === 0
        ? numerator === 0 && excludedCount === 0
          ? 0
          : null
        : numerator / denominator,
  }
}
