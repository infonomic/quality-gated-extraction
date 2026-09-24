import { type AnnotationRecord, validateAnnotationSemantics } from './validate-annotations.js'

const expected = { caseId: 'F005', page: 2, stratum: 'scanned-degraded-en' as const }

function complete(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    schemaVersion: 1,
    annotationStatus: 'complete',
    caseId: 'F005',
    page: 2,
    script: 'english',
    elements: [
      { id: 'e1', type: 'heading', text: 'Heading', readingOrder: 0 },
      { id: 'e2', type: 'body', text: 'Body', readingOrder: 1 },
    ],
    boundaryOpportunities: [
      {
        id: 'b1',
        type: 'heading-body',
        expectedAction: 'break',
        beforeElementId: 'e1',
        afterElementId: 'e2',
      },
    ],
    lowestUsableTier: 'T1',
    usableTiers: ['T1', 'T2', 'T3'],
    lowestStructurallyAdequateTier: 'T0',
    structurallyAdequateTiers: ['T0', 'T2'],
    structuralAssessmentConfirmed: true,
    higherTierDegraded: true,
    degradedTiers: ['T1'],
    acceptanceCriterionId: 'reading-sufficiency-v1',
    structuralCriterionId: 'structural-adequacy-v1',
    annotator: 'synthetic',
    judgedAt: '2026-08-05T00:00:00.000Z',
    structuralScope: {
      status: 'complete',
      ruleId: 'full-page-v1',
      description: 'Full synthetic page.',
    },
    textReference: { status: 'unavailable', reason: 'Not transcribed.' },
    ...overrides,
  }
}

describe('annotation semantics', () => {
  test('accepts an internally consistent completed annotation', () => {
    expect(validateAnnotationSemantics(complete(), expected)).toEqual([])
  })

  test('keeps reading and structural judgements independent', () => {
    expect(
      validateAnnotationSemantics(
        complete({
          lowestUsableTier: 'T2',
          usableTiers: ['T2'],
          lowestStructurallyAdequateTier: 'T0',
          structurallyAdequateTiers: ['T0', 'T3'],
          higherTierDegraded: true,
          degradedTiers: ['T1', 'T2'],
        }),
        expected
      )
    ).toEqual([])
  })

  test('allows a pending shell without fabricating human fields', () => {
    expect(
      validateAnnotationSemantics(
        {
          schemaVersion: 1,
          annotationStatus: 'pending',
          caseId: 'F005',
          page: 2,
          script: 'pending',
          elements: [],
          boundaryOpportunities: [],
        },
        expected
      )
    ).toEqual([])
  })

  test('rejects non-contiguous order, unknown boundaries and a non-derived oracle tier', () => {
    const errors = validateAnnotationSemantics(
      complete({
        elements: [
          { id: 'e1', type: 'heading', text: 'Heading', readingOrder: 2 },
          { id: 'e1', type: 'body', text: 'Body', readingOrder: 2 },
        ],
        lowestUsableTier: 'T0',
        boundaryOpportunities: [
          {
            id: 'b1',
            type: 'heading-body',
            expectedAction: 'break',
            beforeElementId: 'missing',
            afterElementId: 'e1',
          },
        ],
      }),
      expected
    )
    expect(errors).toContain('element IDs must be unique')
    expect(errors).toContain('reading-order values must be unique')
    expect(errors).toContain('reading-order values must be contiguous from zero')
    expect(errors).toContain('b1 references unknown before element missing')
    expect(errors).toContain('lowest usable tier must be derived as T1')
  })

  test('rejects a non-derived structural tier independently', () => {
    expect(
      validateAnnotationSemantics(
        complete({
          lowestStructurallyAdequateTier: 'T1',
          structurallyAdequateTiers: ['T2', 'T3'],
        }),
        expected
      )
    ).toContain('lowest structurally adequate tier must be derived as T2')
  })

  test('rejects degradation fields that diverge from the tier gaps', () => {
    const errors = validateAnnotationSemantics(
      complete({ higherTierDegraded: false, degradedTiers: [] }),
      expected
    )
    expect(errors).toContain('degraded tiers must be derived as T1')
    expect(errors).toContain('higher-tier degradation must be derived as true')
  })

  test('accepts an oracle-only record without treating empty structure as complete', () => {
    expect(
      validateAnnotationSemantics(
        complete({
          annotationStatus: 'oracle-complete',
          elements: [],
          boundaryOpportunities: [],
          structuralScope: {
            status: 'unavailable',
            ruleId: 'not-annotated-v1',
            description: 'Not annotated.',
          },
        }),
        expected
      )
    ).toEqual([])
  })
})
