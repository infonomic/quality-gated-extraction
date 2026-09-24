import { gateMetrics, type SelectedTier } from './metrics/gate.js'
import { ratio } from './metrics/types.js'
import type { Stratum } from './sample.js'

export interface PolicyTierObservation {
  status: 'succeeded' | 'failed' | 'unavailable' | 'censored'
  wallMs?: number
}

export interface PolicyCase {
  caseId: string
  stratum: Stratum
  staticTier: SelectedTier | null
  gatedTier: SelectedTier | null
  tiers: Partial<Record<SelectedTier, PolicyTierObservation>>
}

export interface PolicyQualityPage {
  caseId: string
  page: number
  stratum: Stratum
  usableTiers: SelectedTier[]
  structurallyAdequateTiers: SelectedTier[]
}

export interface T3PageBaselineObservation {
  caseId: string
  page: number
  stratum: Stratum
  status: 'succeeded' | 'failed' | 'unavailable' | 'censored'
  wallMs?: number
}

type PolicyName = 'allT0' | 'staticInspection' | 'gated'

function selectedTier(policy: PolicyName, item: PolicyCase): SelectedTier | null {
  if (policy === 'allT0') return 'T0'
  return policy === 'staticInspection' ? item.staticTier : item.gatedTier
}

function summarisePolicy(
  policy: PolicyName,
  cases: PolicyCase[],
  qualityPages: PolicyQualityPage[]
) {
  const selections = cases.map((item) => ({ item, tier: selectedTier(policy, item) }))
  const selectionsByCase = new Map(selections.map(({ item, tier }) => [item.caseId, tier]))
  const observed = selections.filter(({ item, tier }) => {
    if (tier == null) return false
    const cell = item.tiers[tier]
    return cell?.status === 'succeeded' && cell.wallMs != null
  })
  const totalWallMs = observed.reduce(
    (sum, { item, tier }) => sum + (tier == null ? 0 : (item.tiers[tier]?.wallMs ?? 0)),
    0
  )
  const excludedCount = cases.length - observed.length
  const selected = selections.filter(({ tier }) => tier != null)
  const unselectedCount = cases.length - selected.length
  return {
    selectedDocuments: {
      numerator: selected.length,
      denominator: cases.length,
      excludedCount: unselectedCount,
      value: selected.length,
    },
    observedTimingDocuments: {
      numerator: observed.length,
      denominator: cases.length,
      excludedCount,
      value: observed.length,
    },
    timingCoverage: ratio(observed.length, cases.length, excludedCount),
    tierCounts: Object.fromEntries(
      (['T0', 'T1', 'T2', 'T3'] as const).map((tier) => [
        tier,
        {
          numerator: selections.filter((item) => item.tier === tier).length,
          denominator: cases.length,
          excludedCount: selections.filter((item) => item.tier == null).length,
          value: selections.filter((item) => item.tier === tier).length,
        },
      ])
    ),
    observedWallMs: {
      numerator: totalWallMs,
      denominator: observed.length,
      excludedCount,
      value: totalWallMs,
      label: 'observed' as const,
    },
    meanWallMs: ratio(totalWallMs, observed.length, excludedCount),
    quality: {
      scope: 'predeclared-evaluation-pages' as const,
      pages: ratio(
        qualityPages.filter((page) => selectionsByCase.get(page.caseId) != null).length,
        qualityPages.length,
        qualityPages.filter((page) => selectionsByCase.get(page.caseId) == null).length
      ),
      gateErrors: {
        readingSufficiency: gateMetrics(
          qualityPages.map((page) => ({
            acceptableTiers: page.usableTiers,
            selectedTier: selectionsByCase.get(page.caseId) ?? null,
          }))
        ),
        structuralAdequacy: gateMetrics(
          qualityPages.map((page) => ({
            acceptableTiers: page.structurallyAdequateTiers,
            selectedTier: selectionsByCase.get(page.caseId) ?? null,
          }))
        ),
      },
    },
  }
}

export function simulatePolicies(options: {
  cases: PolicyCase[]
  qualityPages: PolicyQualityPage[]
  allT3Pages: T3PageBaselineObservation[]
}) {
  const caseIds = options.cases.map((item) => item.caseId)
  if (new Set(caseIds).size !== caseIds.length) throw new Error('Policy cases must be unique')
  for (const item of options.cases) {
    if (item.tiers.T0 == null) throw new Error(`${item.caseId} is missing its all-T0 arm`)
  }
  const caseIdSet = new Set(caseIds)
  const qualityPageIds = options.qualityPages.map((item) => `${item.caseId}:${item.page}`)
  if (new Set(qualityPageIds).size !== qualityPageIds.length) {
    throw new Error('Policy quality pages must be unique')
  }
  const unknownQualityCase = options.qualityPages.find((item) => !caseIdSet.has(item.caseId))
  if (unknownQualityCase) {
    throw new Error(`Policy quality page belongs to unknown case ${unknownQualityCase.caseId}`)
  }
  const pageIds = options.allT3Pages.map((item) => `${item.caseId}:${item.page}`)
  if (new Set(pageIds).size !== pageIds.length) throw new Error('All-T3 page cells must be unique')
  const observedT3 = options.allT3Pages.filter(
    (item) => item.status === 'succeeded' && item.wallMs != null
  )
  const t3WallMs = observedT3.reduce((sum, item) => sum + (item.wallMs ?? 0), 0)
  return {
    schemaVersion: 1,
    denominator: { documents: options.cases.length, qualityPages: options.qualityPages.length },
    policies: {
      allT0: summarisePolicy('allT0', options.cases, options.qualityPages),
      staticInspection: summarisePolicy('staticInspection', options.cases, options.qualityPages),
      gated: summarisePolicy('gated', options.cases, options.qualityPages),
    },
    allT3PageBaseline: {
      scope: 'predeclared-independent-page-submissions' as const,
      label: 'sampled' as const,
      pages: {
        numerator: observedT3.length,
        denominator: options.allT3Pages.length,
        excludedCount: options.allT3Pages.length - observedT3.length,
        value: observedT3.length,
      },
      observedWallMs: {
        numerator: t3WallMs,
        denominator: observedT3.length,
        excludedCount: options.allT3Pages.length - observedT3.length,
        value: t3WallMs,
      },
      limitation: 'Not a completed full-document all-T3 policy arm.',
      quality: {
        readingSufficiency: gateMetrics(
          options.qualityPages.map((page) => ({
            acceptableTiers: page.usableTiers,
            selectedTier: 'T3',
          }))
        ),
        structuralAdequacy: gateMetrics(
          options.qualityPages.map((page) => ({
            acceptableTiers: page.structurallyAdequateTiers,
            selectedTier: 'T3',
          }))
        ),
      },
    },
  }
}
