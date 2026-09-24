import {
  decideQualityGate,
  type QualityGateComponents,
  type QualityGateThresholds,
} from './quality-gate.js'
import type { ExtractionTier } from './validate-annotations.js'

export interface GateThresholdGrid {
  characterSanity: number[]
  textRetention: number[]
  usablePageRatio: number[]
  structuralYield: number[]
  scriptConsistency: number[]
}

export interface GateCalibrationExample {
  tier: ExtractionTier
  components: QualityGateComponents
  readingAccepted: boolean
  structurallyAccepted: boolean
}

export interface GateCandidateScore {
  thresholds: QualityGateThresholds
  reading: { falseAccepts: number; falseRejects: number }
  structural: { falseAccepts: number; falseRejects: number }
  totalFalseAccepts: number
  worstAxisFalseAccepts: number
  totalFalseRejects: number
  worstAxisFalseRejects: number
}

export function gateThresholdCandidates(grid: GateThresholdGrid): QualityGateThresholds[] {
  const candidates: QualityGateThresholds[] = []
  for (const characterSanity of grid.characterSanity) {
    for (const textRetention of grid.textRetention) {
      for (const usablePageRatio of grid.usablePageRatio) {
        for (const structuralYield of grid.structuralYield) {
          for (const scriptConsistency of grid.scriptConsistency) {
            candidates.push({
              characterSanity,
              textRetention,
              usablePageRatio,
              structuralYield,
              scriptConsistency,
            })
          }
        }
      }
    }
  }
  return candidates
}

function axisErrors(
  examples: GateCalibrationExample[],
  thresholds: QualityGateThresholds,
  accepted: (example: GateCalibrationExample) => boolean
): { falseAccepts: number; falseRejects: number } {
  let falseAccepts = 0
  let falseRejects = 0
  for (const example of examples) {
    const passed = decideQualityGate(example.components, thresholds).passed
    const expected = accepted(example)
    if (passed && !expected) falseAccepts += 1
    if (!passed && expected) falseRejects += 1
  }
  return { falseAccepts, falseRejects }
}

export function scoreGateCandidate(
  examples: GateCalibrationExample[],
  thresholds: QualityGateThresholds
): GateCandidateScore {
  const reading = axisErrors(examples, thresholds, (example) => example.readingAccepted)
  const structural = axisErrors(examples, thresholds, (example) => example.structurallyAccepted)
  return {
    thresholds,
    reading,
    structural,
    totalFalseAccepts: reading.falseAccepts + structural.falseAccepts,
    worstAxisFalseAccepts: Math.max(reading.falseAccepts, structural.falseAccepts),
    totalFalseRejects: reading.falseRejects + structural.falseRejects,
    worstAxisFalseRejects: Math.max(reading.falseRejects, structural.falseRejects),
  }
}

const componentOrder: Array<keyof QualityGateThresholds> = [
  'characterSanity',
  'textRetention',
  'usablePageRatio',
  'structuralYield',
  'scriptConsistency',
]

export function selectGateThresholds(
  examples: GateCalibrationExample[],
  grid: GateThresholdGrid
): { selected: GateCandidateScore; candidates: GateCandidateScore[] } {
  if (examples.length === 0) throw new Error('Gate calibration requires examples')
  const candidates = gateThresholdCandidates(grid).map((thresholds) =>
    scoreGateCandidate(examples, thresholds)
  )
  candidates.sort((left, right) => {
    const objective =
      left.totalFalseAccepts - right.totalFalseAccepts ||
      left.worstAxisFalseAccepts - right.worstAxisFalseAccepts ||
      left.totalFalseRejects - right.totalFalseRejects ||
      left.worstAxisFalseRejects - right.worstAxisFalseRejects
    if (objective !== 0) return objective
    for (const component of componentOrder) {
      const conservative = right.thresholds[component] - left.thresholds[component]
      if (conservative !== 0) return conservative
    }
    return 0
  })
  const selected = candidates[0]
  if (!selected) throw new Error('Gate threshold grid produced no candidates')
  return { selected, candidates }
}
