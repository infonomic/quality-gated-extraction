import { summariseMatrix } from './summarise-matrix.js'
import type { CachedArtifact } from './artifact-cache.js'
import type { ProviderRunCell } from './run-matrix.js'

function run(
  caseId: string,
  tier: ProviderRunCell['tier'],
  status: ProviderRunCell['status'] = 'succeeded'
): ProviderRunCell {
  return {
    schemaVersion: 1,
    caseId,
    tier,
    provider: { id: tier === 'T3' ? 'paddle' : 'docling', version: '1', execution: 'local' },
    status,
    cache: { hit: false },
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:00:01.000Z',
    ...(status === 'succeeded'
      ? { artifactKey: tier.slice(1).padEnd(64, 'a'), wallMs: 100 }
      : status === 'censored'
        ? {
            observedMinimumWallMs: 1_461_000,
            error: { code: 'CENSORED', message: 'Synthetic lower bound' },
          }
        : { error: { code: 'FAILED', message: 'Synthetic failure' } }),
  }
}

function artifact(caseId: string, tier: CachedArtifact['tier']): CachedArtifact {
  return {
    schemaVersion: 1,
    caseId,
    cacheKey: tier.slice(1).padEnd(64, 'a'),
    tier,
    provider: { id: tier === 'T3' ? 'paddle' : 'docling', version: '1', execution: 'local' },
    parameters: {},
    representations: { text: 'synthetic' },
    timings: {
      wallMs: 100,
      providerMs: tier === 'T3' ? null : 80,
      providerTimingStatus: tier === 'T3' ? 'unavailable' : 'observed',
    },
    warnings: [],
  }
}

describe('safe matrix timing summary', () => {
  test('keeps denominators, exclusions and timing bases explicit', () => {
    const cells = [
      run('F001', 'T1'),
      run('F002', 'T1', 'failed'),
      run('F001', 'T3'),
      run('F002', 'T3', 'censored'),
    ]
    const artifacts = new Map([
      ['F001:T1', artifact('F001', 'T1')],
      ['F001:T3', artifact('F001', 'T3')],
    ])
    const summary = summariseMatrix({
      sample: {
        calibration: [{ caseId: 'F001', stratum: 'born-digital-en', pageCount: 2 }],
        evaluation: [{ caseId: 'F002', stratum: 'scanned-degraded-en', pageCount: 3 }],
      },
      cells,
      artifacts,
      timingCalibrations: [
        {
          providerId: 'docling',
          fixedOverheadMs: 10,
          marginalTimeBasis: 'provider-reported',
        },
        {
          providerId: 'paddle',
          fixedOverheadMs: 10,
          marginalTimeBasis: 'client-wall-minus-fixed-overhead',
        },
      ],
      cost: { cpuMachineHour: 0.1, gpuMachineHour: 1 },
    })

    expect(summary.byTier.T1.overall.documents).toEqual({
      numerator: 1,
      denominator: 2,
      excludedCount: 1,
      failed: 1,
      unavailable: 0,
      censored: 0,
    })
    expect(summary.byTier.T1.overall.timing).toMatchObject({
      marginalMs: 80,
      providerReportedDocuments: 1,
      clientObservedProxyDocuments: 0,
    })
    expect(summary.byTier.T3.overall.timing).toMatchObject({
      marginalMs: 90,
      providerReportedDocuments: 0,
      clientObservedProxyDocuments: 1,
      censoredDocuments: 1,
      censoredObservedMinimumWallMs: 1_461_000,
    })
    expect(summary.byTier.T3.overall.documents).toEqual({
      numerator: 1,
      denominator: 2,
      excludedCount: 1,
      failed: 0,
      unavailable: 0,
      censored: 1,
    })
    expect(summary.byTier.T3.overall.costProxy.value).toBeCloseTo(0.000025)
  })
})
