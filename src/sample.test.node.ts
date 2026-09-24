import { freezeSample, type Stratum, strata } from './sample.js'

const config = {
  seed: 'synthetic-seed',
  sample: {
    strata: [...strata],
    calibrationPerStratum: 2,
    evaluationPerStratum: 4,
    annotatedPagesPerDocument: 2,
  },
  inspection: { mixedScriptMinimumRatio: 0.1 },
  routing: {
    defaults: {
      minimumTextLayerCoverage: 0.5,
      maximumFullPageImageRatio: 0.5,
      maximumEncodingAnomalyRatio: 0.02,
    },
  },
}

function inspection(caseId: string, stratum: Stratum) {
  const degraded = stratum.startsWith('scanned-degraded')
  const thai = stratum === 'scanned-degraded-thai-mixed'
  const layout = stratum === 'layout-heavy-born-digital'
  return {
    schemaVersion: 1 as const,
    caseId,
    contentHash: caseId.padEnd(64, 'a').slice(0, 64),
    pageCount: 3,
    pages: [1, 2, 3].map((page) => ({
      page,
      textChars: degraded ? 0 : 100 + page,
      imageAreaRatio: degraded ? 1 : layout ? 0.3 : 0,
      encodingAnomalyCount: 0,
      thaiChars: thai ? 10 : 0,
      latinChars: thai ? 10 : 100,
      warnings: [],
    })),
    signals: {
      totalTextChars: degraded ? 0 : 303,
      charsPerPage: degraded ? 0 : 101,
      textLayerCoverage: degraded ? 0 : 1,
      charsPerPageCv: layout ? 0.8 : 0,
      meanImageAreaRatio: degraded ? 1 : layout ? 0.3 : 0,
      fullPageImageRatio: degraded ? 1 : 0,
      encodingAnomalyRatio: 0,
      thaiCharRatio: thai ? 0.5 : 0,
      latinCharRatio: thai ? 0.5 : 1,
      mixedScript: thai,
    },
    metadata: {},
    warnings: [],
  }
}

function corpus(perStratum = 6) {
  let sequence = 1
  return strata.flatMap((stratum) =>
    Array.from({ length: perStratum }, () => {
      const caseId = `F${String(sequence).padStart(3, '0')}`
      sequence += 1
      return inspection(caseId, stratum)
    })
  )
}

describe('sample freeze', () => {
  test('is stable, stratified and calibration/evaluation disjoint', () => {
    const inspections = corpus()
    const first = freezeSample({
      runId: 'synthetic-run',
      config,
      configHash: 'a'.repeat(64),
      inspectionHash: 'b'.repeat(64),
      inspections,
    })
    const reordered = freezeSample({
      runId: 'synthetic-run',
      config,
      configHash: 'a'.repeat(64),
      inspectionHash: 'b'.repeat(64),
      inspections: [...inspections].reverse(),
    })

    expect(first.calibration).toHaveLength(8)
    expect(first.evaluation).toHaveLength(16)
    expect(first.denominators.annotationPages).toBe(32)
    for (const stratum of strata) {
      expect(first.calibration.filter((item) => item.stratum === stratum)).toHaveLength(2)
      expect(first.evaluation.filter((item) => item.stratum === stratum)).toHaveLength(4)
    }
    const calibration = new Set(first.calibration.map((item) => item.caseId))
    expect(first.evaluation.some((item) => calibration.has(item.caseId))).toBe(false)
    expect(first.evaluation.every((item) => item.pages.length === 2)).toBe(true)
    expect(reordered.calibration).toEqual(first.calibration)
    expect(reordered.evaluation).toEqual(first.evaluation)
  })

  test('records the deliberate evaluation fallback without borrowing cases', () => {
    const result = freezeSample({
      runId: 'synthetic-run',
      config,
      configHash: 'a'.repeat(64),
      inspectionHash: 'b'.repeat(64),
      inspections: corpus(),
      evaluationPerStratum: 1,
    })

    expect(result.fallback).toEqual({
      applied: true,
      reasonCode: 'T3_PROJECTED_RUNTIME',
      originalEvaluationPerStratum: 4,
      selectedEvaluationPerStratum: 1,
    })
    expect(result.calibration).toHaveLength(8)
    expect(result.evaluation).toHaveLength(4)
  })

  test('applies audited manual stratum adjustments before seeded selection', () => {
    const inspections = corpus(7)
    const adjustedCase = inspections.find(
      (item) => item.caseId === 'F022' && item.signals.thaiCharRatio > 0
    )
    expect(adjustedCase).toBeDefined()

    const result = freezeSample({
      runId: 'synthetic-run',
      config,
      configHash: 'a'.repeat(64),
      inspectionHash: 'b'.repeat(64),
      inspections,
      manualReviewComplete: true,
      manualAdjustments: [
        {
          caseId: 'F022',
          from: 'scanned-degraded-thai-mixed',
          to: 'scanned-degraded-en',
          reasonCode: 'REPEATED_THAI_WATERMARK_ONLY',
        },
      ],
    })

    expect(result.manualReview.adjustments).toEqual([
      {
        caseId: 'F022',
        from: 'scanned-degraded-thai-mixed',
        to: 'scanned-degraded-en',
        reasonCode: 'REPEATED_THAI_WATERMARK_ONLY',
      },
    ])
    expect(
      [...result.calibration, ...result.evaluation].filter(
        (item) => item.stratum === 'scanned-degraded-thai-mixed'
      )
    ).toHaveLength(6)
    expect(
      [...result.calibration, ...result.evaluation].some(
        (item) => item.caseId === 'F022' && item.stratum === 'scanned-degraded-thai-mixed'
      )
    ).toBe(false)
    expect(
      [...result.calibration, ...result.evaluation].find((item) => item.caseId === 'F022')?.stratum
    ).not.toBe('scanned-degraded-thai-mixed')
  })

  test('rejects adjustments whose preliminary stratum is not reproduced', () => {
    expect(() =>
      freezeSample({
        runId: 'synthetic-run',
        config,
        configHash: 'a'.repeat(64),
        inspectionHash: 'b'.repeat(64),
        inspections: corpus(7),
        manualReviewComplete: true,
        manualAdjustments: [
          {
            caseId: 'F001',
            from: 'scanned-degraded-en',
            to: 'born-digital-en',
            reasonCode: 'SYNTHETIC_INVALID_FROM',
          },
        ],
      })
    ).toThrow(/declares/u)
  })

  test('fails when any stratum cannot satisfy both sets', () => {
    expect(() =>
      freezeSample({
        runId: 'synthetic-run',
        config,
        configHash: 'a'.repeat(64),
        inspectionHash: 'b'.repeat(64),
        inspections: corpus(5),
      })
    ).toThrow(/required/u)
  })
})
