import { replayEscalation, tuneRoutingThresholds } from './routing.js'
import type { GateResult, InitialRouteDecision, ReplayArtifact } from './routing.js'

const failed = (reason: string, score: number): GateResult => ({
  passed: false,
  components: { quality: score },
  reasons: [reason],
})

const artifact = (tier: ReplayArtifact['tier'], gate: GateResult): ReplayArtifact => ({
  tier,
  artifactKey: tier.slice(1).padEnd(64, 'a'),
  gate,
})

const initial = (initialTier: InitialRouteDecision['initialTier']): InitialRouteDecision => ({
  initialTier,
  rationale: ['TEXT_LAYER_INTACT'],
  confidence: 1,
})

describe('calibration-only threshold tuning', () => {
  test('reads calibration inspections only and records all grid candidates', async () => {
    const reads: string[] = []
    const result = await tuneRoutingThresholds({
      sample: {
        calibration: [
          { caseId: 'F001', stratum: 'born-digital-en' },
          { caseId: 'F002', stratum: 'scanned-degraded-en' },
        ],
        evaluation: [{ caseId: 'F003', stratum: 'born-digital-en' }],
      },
      grid: {
        minimumTextLayerCoverage: [0.25, 0.5],
        maximumFullPageImageRatio: [0.5],
        maximumEncodingAnomalyRatio: [0.02],
      },
      readInspection: async (caseId) => {
        reads.push(caseId)
        if (caseId === 'F003') throw new Error('evaluation evidence was opened')
        return caseId === 'F001'
          ? { textLayerCoverage: 1, fullPageImageRatio: 0, encodingAnomalyRatio: 0 }
          : { textLayerCoverage: 0, fullPageImageRatio: 1, encodingAnomalyRatio: 0 }
      },
    })

    expect(reads).toEqual(['F001', 'F002'])
    expect(result.candidates).toHaveLength(2)
    expect(result.calibrationCaseIds).toEqual(['F001', 'F002'])
  })

  test('fails before reads when calibration and evaluation overlap', async () => {
    let reads = 0
    await expect(
      tuneRoutingThresholds({
        sample: {
          calibration: [{ caseId: 'F001', stratum: 'born-digital-en' }],
          evaluation: [{ caseId: 'F001', stratum: 'born-digital-en' }],
        },
        grid: {
          minimumTextLayerCoverage: [0.5],
          maximumFullPageImageRatio: [0.5],
          maximumEncodingAnomalyRatio: [0.02],
        },
        readInspection: async () => {
          reads += 1
          return {}
        },
      })
    ).rejects.toThrow(/overlap/u)
    expect(reads).toBe(0)
  })
})

describe('routing escalation replay', () => {
  test('uses the signal-conditioned T0 to T2 to T3 path without repeats', () => {
    const result = replayEscalation({
      initial: initial('T0'),
      artifacts: {
        T0: artifact('T0', failed('TEXT_RETENTION_FAILED', 0.2)),
        T2: artifact('T2', failed('SCRIPT_CONSISTENCY_FAILED', 0.4)),
        T3: artifact('T3', { passed: true, components: { quality: 1 }, reasons: [] }),
      },
      maxEscalations: 2,
    })

    expect(result.status).toBe('accepted')
    expect(result.steps.map((step) => step.tier)).toEqual(['T0', 'T2', 'T3'])
    expect(new Set(result.steps.map((step) => step.tier)).size).toBe(result.steps.length)
  })

  test('enforces the two-escalation cap without re-comparing earlier artifacts', () => {
    const result = replayEscalation({
      initial: initial('T0'),
      artifacts: {
        T0: artifact('T0', failed('STRUCTURAL_YIELD_FAILED', 0.8)),
        T1: artifact('T1', failed('STRUCTURAL_YIELD_FAILED', 0.4)),
        T3: artifact('T3', failed('TERMINAL_TIER_FAILED', 0.1)),
      },
      maxEscalations: 2,
    })

    expect(result.status).toBe('low-confidence')
    expect(result.steps).toHaveLength(3)
    expect(result.steps.at(-1)?.reasons).toContain('TERMINAL_TIER_FAILED')
    expect(result.selectedArtifactKey).toBe(artifact('T3', failed('', 0)).artifactKey)
  })

  test('stops before a third escalation', () => {
    const result = replayEscalation({
      initial: initial('T0'),
      artifacts: {
        T0: artifact('T0', failed('STRUCTURAL_YIELD_FAILED', 0.5)),
        T1: artifact('T1', failed('TEXT_RETENTION_FAILED', 0.4)),
        T2: artifact('T2', failed('SCRIPT_CONSISTENCY_FAILED', 0.3)),
        T3: artifact('T3', { passed: true, components: { quality: 1 }, reasons: [] }),
      },
      maxEscalations: 2,
    })

    expect(result.status).toBe('low-confidence')
    expect(result.steps.map((step) => step.tier)).toEqual(['T0', 'T1', 'T2'])
    expect(result.steps.at(-1)?.reasons).toContain('MAX_ESCALATIONS_REACHED')
  })
})
