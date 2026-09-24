import {
  ACCEPTANCE_CRITERION,
  hasDeclaredOracleDerivation,
  hasFrozenAcceptanceCriterion,
  hasFrozenStructuralCriterion,
  normaliseOracleJudgement,
  ORACLE_DERIVATION,
  STRUCTURAL_CRITERION,
} from './oracle.js'

describe('human oracle judgement', () => {
  test('derives the lowest tier server-side and preserves a non-contiguous usable set', () => {
    expect(
      normaliseOracleJudgement(
        {
          script: 'thai',
          lowestUsableTier: 'T0',
          usableTiers: ['T1', 'T3'],
          structurallyAdequateTiers: ['T3'],
          structuralAssessmentConfirmed: true,
          higherTierDegraded: false,
          annotator: ' reviewer ',
          notes: 'non-monotonic',
        },
        '2026-08-05T00:00:00.000Z'
      )
    ).toEqual({
      script: 'thai',
      lowestUsableTier: 'T1',
      usableTiers: ['T1', 'T3'],
      lowestStructurallyAdequateTier: 'T3',
      structurallyAdequateTiers: ['T3'],
      structuralAssessmentConfirmed: true,
      higherTierDegraded: true,
      degradedTiers: ['T2'],
      annotator: 'reviewer',
      notes: 'non-monotonic',
      judgedAt: '2026-08-05T00:00:00.000Z',
    })
  })

  test('rejects duplicate, unknown and incomplete judgements', () => {
    const base = {
      script: 'english',
      usableTiers: ['T0'],
      structurallyAdequateTiers: [],
      structuralAssessmentConfirmed: true,
      higherTierDegraded: false,
      annotator: 'reviewer',
    }
    expect(() => normaliseOracleJudgement({ ...base, usableTiers: ['T0', 'T0'] })).toThrow('unique')
    expect(() => normaliseOracleJudgement({ ...base, usableTiers: ['T4'] })).toThrow('unknown')
    expect(() => normaliseOracleJudgement({ ...base, annotator: '' })).toThrow('annotator')
    // The structural axis is required, never defaulted: an absent array would
    // silently record that no tier preserved structure.
    const { structurallyAdequateTiers, ...withoutStructure } = base
    expect(() => normaliseOracleJudgement(withoutStructure)).toThrow('structurallyAdequateTiers')
    expect(() =>
      normaliseOracleJudgement({ ...base, structurallyAdequateTiers: ['T1', 'T1'] })
    ).toThrow('unique')
    expect(() =>
      normaliseOracleJudgement({ ...base, structuralAssessmentConfirmed: false })
    ).toThrow('structuralAssessmentConfirmed')
  })

  test('pins the full acceptance rubric, not only its identifier', () => {
    expect(hasFrozenAcceptanceCriterion(ACCEPTANCE_CRITERION)).toBe(true)
    expect(hasFrozenAcceptanceCriterion({ ...ACCEPTANCE_CRITERION, note: 'changed' })).toBe(false)
    expect(hasFrozenStructuralCriterion(STRUCTURAL_CRITERION)).toBe(true)
    expect(hasFrozenStructuralCriterion({ ...STRUCTURAL_CRITERION, note: 'changed' })).toBe(false)
    expect(hasDeclaredOracleDerivation({ ...ORACLE_DERIVATION, appliedAt: '2026-08-06' })).toBe(
      true
    )
    expect(hasDeclaredOracleDerivation({ ...ORACLE_DERIVATION, appliedAt: 'not-a-date' })).toBe(
      false
    )
  })
})
