import { type PolicyCase, simulatePolicies } from './policies.js'

const cases: PolicyCase[] = [
  {
    caseId: 'F001',
    stratum: 'born-digital-en',
    staticTier: 'T0',
    gatedTier: 'T0',
    tiers: { T0: { status: 'succeeded', wallMs: 10 } },
  },
  {
    caseId: 'F002',
    stratum: 'scanned-degraded-en',
    staticTier: 'T2',
    gatedTier: 'T3',
    tiers: {
      T0: { status: 'succeeded', wallMs: 20 },
      T2: { status: 'succeeded', wallMs: 200 },
      T3: { status: 'censored' },
    },
  },
]

describe('cached policy simulation', () => {
  test('uses one document denominator and excludes unavailable selected arms without imputation', () => {
    const result = simulatePolicies({
      cases,
      qualityPages: [
        {
          caseId: 'F001',
          page: 1,
          stratum: 'born-digital-en',
          usableTiers: ['T0', 'T1'],
          structurallyAdequateTiers: ['T1'],
        },
        {
          caseId: 'F002',
          page: 1,
          stratum: 'scanned-degraded-en',
          usableTiers: ['T2', 'T3'],
          structurallyAdequateTiers: ['T3'],
        },
      ],
      allT3Pages: [
        {
          caseId: 'F001',
          page: 1,
          stratum: 'born-digital-en',
          status: 'succeeded',
          wallMs: 1000,
        },
        {
          caseId: 'F002',
          page: 1,
          stratum: 'scanned-degraded-en',
          status: 'failed',
        },
      ],
    })
    expect(result.policies.allT0.selectedDocuments).toMatchObject({
      numerator: 2,
      denominator: 2,
      excludedCount: 0,
    })
    expect(result.policies.staticInspection.observedWallMs).toMatchObject({
      numerator: 210,
      denominator: 2,
      excludedCount: 0,
    })
    expect(result.policies.gated.selectedDocuments).toMatchObject({
      numerator: 2,
      denominator: 2,
      excludedCount: 0,
    })
    expect(result.policies.gated.observedTimingDocuments).toMatchObject({
      numerator: 1,
      denominator: 2,
      excludedCount: 1,
    })
    expect(
      result.policies.gated.quality.gateErrors.readingSufficiency.falseEscalations
    ).toMatchObject({
      denominator: 2,
      excludedCount: 0,
    })
    expect(result.policies.allT0.quality.gateErrors.structuralAdequacy.falseAccepts).toMatchObject({
      numerator: 2,
      denominator: 2,
      excludedCount: 0,
    })
    expect(result.allT3PageBaseline.pages).toMatchObject({
      numerator: 1,
      denominator: 2,
      excludedCount: 1,
    })
    expect(result.allT3PageBaseline.limitation).toContain('full-document')
  })

  test('refuses changed or incomplete case identities', () => {
    expect(() =>
      simulatePolicies({
        cases: [...cases, cases[0] as PolicyCase],
        qualityPages: [],
        allT3Pages: [],
      })
    ).toThrow('Policy cases must be unique')
    expect(() =>
      simulatePolicies({
        cases: [{ ...(cases[0] as PolicyCase), tiers: {} }],
        qualityPages: [],
        allT3Pages: [],
      })
    ).toThrow('missing its all-T0 arm')
    expect(() =>
      simulatePolicies({
        cases,
        qualityPages: [
          {
            caseId: 'F999',
            page: 1,
            stratum: 'born-digital-en',
            usableTiers: [],
            structurallyAdequateTiers: [],
          },
        ],
        allT3Pages: [],
      })
    ).toThrow('unknown case')
  })
})
