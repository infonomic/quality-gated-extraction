import { foldOracleIntoAnnotation } from './fold-oracle.js'
import type { AnnotationRecord } from './validate-annotations.js'

describe('oracle fold-in', () => {
  test('marks only the oracle complete and makes unavailable evidence explicit', () => {
    const pending: AnnotationRecord = {
      schemaVersion: 1,
      annotationStatus: 'pending',
      caseId: 'F001',
      page: 1,
      script: 'pending',
      elements: [],
      boundaryOpportunities: [],
    }
    expect(
      foldOracleIntoAnnotation(pending, {
        script: 'mixed',
        lowestUsableTier: 'T1',
        usableTiers: ['T1', 'T3'],
        lowestStructurallyAdequateTier: 'T1',
        structurallyAdequateTiers: ['T1', 'T3'],
        structuralAssessmentConfirmed: true,
        higherTierDegraded: true,
        degradedTiers: ['T2'],
        notes: null,
        annotator: 'reviewer',
        judgedAt: '2026-08-05T00:00:00.000Z',
      })
    ).toMatchObject({
      annotationStatus: 'oracle-complete',
      lowestUsableTier: 'T1',
      usableTiers: ['T1', 'T3'],
      lowestStructurallyAdequateTier: 'T1',
      structurallyAdequateTiers: ['T1', 'T3'],
      structuralAssessmentConfirmed: true,
      higherTierDegraded: true,
      degradedTiers: ['T2'],
      structuralCriterionId: 'structural-adequacy-v1',
      structuralScope: { status: 'unavailable', ruleId: 'not-annotated-v1' },
      textReference: { status: 'unavailable' },
      elements: [],
    })
  })

  test('preserves a separately scoped partial structural annotation', () => {
    const partial: AnnotationRecord = {
      schemaVersion: 1,
      annotationStatus: 'structure-partial',
      caseId: 'F001',
      page: 1,
      script: 'english',
      elements: [{ id: 'e1', type: 'caption', text: 'Figure', readingOrder: 0 }],
      boundaryOpportunities: [],
      lowestUsableTier: 'T0',
      usableTiers: ['T0'],
      lowestStructurallyAdequateTier: 'T1',
      structurallyAdequateTiers: ['T1'],
      structuralAssessmentConfirmed: true,
      higherTierDegraded: false,
      degradedTiers: [],
      acceptanceCriterionId: 'reading-sufficiency-v1',
      structuralCriterionId: 'structural-adequacy-v1',
      annotator: 'reviewer',
      judgedAt: '2026-08-05T00:00:00.000Z',
      structuralScope: {
        status: 'partial',
        ruleId: 'table-header-first-five-rows-and-all-non-body-v1',
        description: 'Sampled structure.',
      },
      textReference: { status: 'unavailable', reason: 'Not transcribed.' },
    }
    expect(
      foldOracleIntoAnnotation(partial, {
        script: 'english',
        lowestUsableTier: 'T1',
        usableTiers: ['T1'],
        lowestStructurallyAdequateTier: 'T1',
        structurallyAdequateTiers: ['T1'],
        structuralAssessmentConfirmed: true,
        higherTierDegraded: false,
        degradedTiers: [],
        notes: null,
        annotator: 'reviewer',
        judgedAt: '2026-08-05T01:00:00.000Z',
      })
    ).toMatchObject({
      annotationStatus: 'structure-partial',
      structuralScope: { status: 'partial' },
      elements: [{ id: 'e1' }],
      lowestUsableTier: 'T1',
      lowestStructurallyAdequateTier: 'T1',
      structurallyAdequateTiers: ['T1'],
    })
  })
})
