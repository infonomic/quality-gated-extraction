import { buildT3PageSubsetDeclaration } from './predeclare-t3-pages.js'
import type { FrozenSample, InspectionRecord, Stratum } from './sample.js'

function inspection(caseId: string, stratum: Stratum): InspectionRecord {
  const degraded = stratum.startsWith('scanned-degraded')
  return {
    schemaVersion: 1,
    caseId,
    contentHash: caseId.padEnd(64, 'a').slice(0, 64),
    pageCount: 3,
    pages: [1, 2, 3].map((page) => ({
      page,
      textChars: degraded ? 0 : 100 + page,
      imageAreaRatio: degraded ? page / 3 : 0,
      encodingAnomalyCount: 0,
      thaiChars: 0,
      latinChars: degraded ? 0 : 100,
      warnings: [],
    })),
    signals: {
      totalTextChars: degraded ? 0 : 303,
      charsPerPage: degraded ? 0 : 101,
      textLayerCoverage: degraded ? 0 : 1,
      charsPerPageCv: 0,
      meanImageAreaRatio: degraded ? 0.5 : 0,
      fullPageImageRatio: degraded ? 1 : 0,
      encodingAnomalyRatio: 0,
      thaiCharRatio: 0,
      latinCharRatio: degraded ? 0 : 1,
      mixedScript: false,
    },
    metadata: {},
    warnings: [],
  }
}

const stratum: Stratum = 'scanned-degraded-en'
const calibrationInspection = inspection('F001', stratum)
const evaluationInspection = inspection('F002', stratum)
const sample = {
  schemaVersion: 1,
  runId: 'sample',
  seed: 'seed',
  configHash: 'a'.repeat(64),
  inspectionHash: 'b'.repeat(64),
  stratumRules: [],
  orderedCorpusCaseIds: ['F001', 'F002'],
  calibration: [{ caseId: 'F001', stratum, pageCount: 3 }],
  evaluation: [{ caseId: 'F002', stratum, pageCount: 3, pages: [2, 3] }],
  manualReview: { status: 'complete', reviewedCaseIds: ['F001', 'F002'], adjustments: [] },
  fallback: {
    applied: false,
    originalEvaluationPerStratum: 4,
    selectedEvaluationPerStratum: 4,
  },
  denominators: {
    corpusDocuments: 2,
    calibrationDocuments: 1,
    evaluationDocuments: 1,
    annotationPages: 2,
  },
} satisfies FrozenSample

const common = {
  sample,
  sampleHash: 'c'.repeat(64),
  inspections: [calibrationInspection, evaluationInspection],
  inspectionHash: sample.inspectionHash,
  config: { seed: sample.seed, sample: { annotatedPagesPerDocument: 2 } },
  configHash: sample.configHash,
  policy: {
    status: 'frozen' as const,
    configHash: sample.configHash,
    sampleHash: 'c'.repeat(64),
    policyHash: 'd'.repeat(64),
    evaluationMatrixCellsPresentAtFreeze: 0,
    evaluationCaseIdsOpened: [],
  },
  policyArtifactHash: 'e'.repeat(64),
  evaluationCellNames: ['calibration-F001-T0.json'],
}

describe('T3 page predeclaration', () => {
  test('reproduces frozen evaluation pages and selects calibration pages deterministically', () => {
    const result = buildT3PageSubsetDeclaration(common)

    expect(result.calibration[0]?.pages).toEqual([2, 3])
    expect(result.evaluation[0]?.pages).toEqual([2, 3])
    expect(result.evaluationBoundary.evaluationArtifactsOpenedAtDeclaration).toEqual([])
  })

  test('fails closed when an evaluation cell exists', () => {
    expect(() =>
      buildT3PageSubsetDeclaration({
        ...common,
        evaluationCellNames: ['evaluation-F002-T0.json'],
      })
    ).toThrow(/already open/u)
  })

  test('rejects a frozen evaluation page mismatch', () => {
    expect(() =>
      buildT3PageSubsetDeclaration({
        ...common,
        sample: {
          ...sample,
          evaluation: [{ caseId: 'F002', stratum, pageCount: 3, pages: [1, 2] }],
        },
      })
    ).toThrow(/does not reproduce/u)
  })
})
