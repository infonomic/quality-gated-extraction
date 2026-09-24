import { ratio } from './types.js'

export type SelectedTier = 'T0' | 'T1' | 'T2' | 'T3'

const tierRank: Record<SelectedTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 }

export interface GateObservation {
  acceptableTiers: SelectedTier[]
  selectedTier: SelectedTier | null
}

export function gateMetrics(observations: GateObservation[]) {
  let falseAccepts = 0
  let falseEscalations = 0
  let excludedCount = 0
  for (const observation of observations) {
    if (observation.selectedTier == null) {
      excludedCount += 1
      continue
    }
    if (!observation.acceptableTiers.includes(observation.selectedTier)) {
      falseAccepts += 1
    } else if (
      observation.acceptableTiers.some(
        (acceptable) => tierRank[acceptable] < tierRank[observation.selectedTier as SelectedTier]
      )
    ) {
      falseEscalations += 1
    }
  }
  const denominator = observations.length - excludedCount
  return {
    falseAccepts: ratio(falseAccepts, denominator, excludedCount),
    falseEscalations: ratio(falseEscalations, denominator, excludedCount),
  }
}
