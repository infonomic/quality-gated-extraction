import {
  type GateCalibrationExample,
  type GateThresholdGrid,
  gateThresholdCandidates,
  selectGateThresholds,
} from './gate-calibration.js'

const grid: GateThresholdGrid = {
  characterSanity: [0.9, 0.95],
  textRetention: [0.5],
  usablePageRatio: [0.5],
  structuralYield: [1],
  scriptConsistency: [0.8],
}

function example(
  characterSanity: number,
  readingAccepted: boolean,
  structurallyAccepted = readingAccepted
): GateCalibrationExample {
  return {
    tier: 'T1',
    components: {
      characterSanity,
      textRetention: 1,
      usablePageRatio: 1,
      structuralYield: 1,
      scriptConsistency: 1,
    },
    readingAccepted,
    structurallyAccepted,
  }
}

describe('quality-gate calibration contract', () => {
  test('enumerates the declared cartesian threshold grid', () => {
    expect(gateThresholdCandidates(grid)).toHaveLength(2)
  })

  test('minimises unsafe accepts before unnecessary rejects', () => {
    const result = selectGateThresholds(
      [example(0.92, false), example(0.99, true), example(0.99, true)],
      grid
    )
    expect(result.selected.thresholds.characterSanity).toBe(0.95)
    expect(result.selected.totalFalseAccepts).toBe(0)
  })

  test('uses the higher threshold as the declared conservative tie-break', () => {
    const result = selectGateThresholds([example(1, true)], grid)
    expect(result.selected.thresholds.characterSanity).toBe(0.95)
  })

  test('scores the two independent oracle axes separately', () => {
    const result = selectGateThresholds([example(1, true, false)], grid)
    expect(result.selected.reading.falseAccepts).toBe(0)
    expect(result.selected.structural.falseAccepts).toBe(1)
  })
})
