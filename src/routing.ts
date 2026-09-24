import { createHash } from 'node:crypto'

import { canonicalJson } from './artifact-cache.js'
import type { ExtractionTier } from './providers/types.js'
import type { Stratum } from './sample.js'

export interface RoutingThresholds {
  minimumTextLayerCoverage: number
  maximumFullPageImageRatio: number
  maximumEncodingAnomalyRatio: number
}

export interface RoutingSignals {
  textLayerCoverage?: number | null
  fullPageImageRatio?: number | null
  encodingAnomalyRatio?: number | null
  meanImageAreaRatio?: number | null
  charsPerPageCv?: number | null
  mixedScript?: boolean | null
}

export interface InitialRouteDecision {
  initialTier: 'T0' | 'T1' | 'T2'
  rationale: string[]
  confidence: number
}

export function chooseInitialTier(
  signals: RoutingSignals,
  thresholds: RoutingThresholds
): InitialRouteDecision {
  const missing = [
    signals.textLayerCoverage,
    signals.fullPageImageRatio,
    signals.encodingAnomalyRatio,
  ].some((value) => value == null)
  const rationale: string[] = missing ? ['MISSING_REQUIRED_SIGNAL'] : []
  if (
    signals.textLayerCoverage != null &&
    signals.textLayerCoverage < thresholds.minimumTextLayerCoverage
  ) {
    rationale.push('LOW_TEXT_LAYER_COVERAGE')
  }
  if (
    signals.fullPageImageRatio != null &&
    signals.fullPageImageRatio >= thresholds.maximumFullPageImageRatio
  ) {
    rationale.push('HIGH_FULL_PAGE_IMAGE_RATIO')
  }
  if (
    signals.encodingAnomalyRatio != null &&
    signals.encodingAnomalyRatio >= thresholds.maximumEncodingAnomalyRatio
  ) {
    rationale.push('ENCODING_ANOMALY')
  }
  if (rationale.some((reason) => reason !== 'MISSING_REQUIRED_SIGNAL')) {
    if (signals.mixedScript) rationale.push('MIXED_SCRIPT')
    return { initialTier: 'T2', rationale, confidence: missing ? 0.5 : 1 }
  }
  if ((signals.meanImageAreaRatio ?? 0) >= 0.2 || (signals.charsPerPageCv ?? 0) >= 0.75) {
    rationale.push('STRUCTURE_COMPLEXITY')
    return { initialTier: 'T1', rationale, confidence: missing ? 0.5 : 1 }
  }
  rationale.push('TEXT_LAYER_INTACT')
  return { initialTier: 'T0', rationale, confidence: missing ? 0.5 : 1 }
}

interface SamplePartition {
  calibration: Array<{ caseId: string; stratum: Stratum }>
  evaluation: Array<{ caseId: string; stratum: Stratum }>
}

export function assertDisjointSample(sample: SamplePartition): void {
  const calibration = new Set(sample.calibration.map((item) => item.caseId))
  const overlap = sample.evaluation.find((item) => calibration.has(item.caseId))
  if (overlap) throw new Error(`Calibration/evaluation overlap: ${overlap.caseId}`)
}

export interface ThresholdCandidate {
  thresholds: RoutingThresholds
  correct: number
  denominator: number
}

export async function tuneRoutingThresholds(options: {
  sample: SamplePartition
  grid: {
    minimumTextLayerCoverage: number[]
    maximumFullPageImageRatio: number[]
    maximumEncodingAnomalyRatio: number[]
  }
  readInspection: (caseId: string) => Promise<RoutingSignals>
}): Promise<{
  selected: RoutingThresholds
  candidates: ThresholdCandidate[]
  calibrationCaseIds: string[]
  policyHash: string
}> {
  assertDisjointSample(options.sample)
  const calibrationRecords = await Promise.all(
    options.sample.calibration.map(async (item) => ({
      ...item,
      signals: await options.readInspection(item.caseId),
    }))
  )
  const expectedTier = (stratum: Stratum): 'T0' | 'T1' | 'T2' => {
    if (stratum === 'born-digital-en') return 'T0'
    if (stratum === 'layout-heavy-born-digital') return 'T1'
    return 'T2'
  }
  const candidates: ThresholdCandidate[] = []
  for (const minimumTextLayerCoverage of options.grid.minimumTextLayerCoverage) {
    for (const maximumFullPageImageRatio of options.grid.maximumFullPageImageRatio) {
      for (const maximumEncodingAnomalyRatio of options.grid.maximumEncodingAnomalyRatio) {
        const thresholds = {
          minimumTextLayerCoverage,
          maximumFullPageImageRatio,
          maximumEncodingAnomalyRatio,
        }
        candidates.push({
          thresholds,
          correct: calibrationRecords.filter(
            (item) =>
              chooseInitialTier(item.signals, thresholds).initialTier === expectedTier(item.stratum)
          ).length,
          denominator: calibrationRecords.length,
        })
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.correct - left.correct ||
      right.thresholds.minimumTextLayerCoverage - left.thresholds.minimumTextLayerCoverage ||
      left.thresholds.maximumFullPageImageRatio - right.thresholds.maximumFullPageImageRatio ||
      left.thresholds.maximumEncodingAnomalyRatio - right.thresholds.maximumEncodingAnomalyRatio
  )
  const selected = candidates[0]?.thresholds
  if (!selected) throw new Error('Threshold grid produced no candidates')
  const calibrationCaseIds = options.sample.calibration.map((item) => item.caseId)
  const policyHash = createHash('sha256')
    .update(canonicalJson({ selected, calibrationCaseIds, candidates }))
    .digest('hex')
  return { selected, candidates, calibrationCaseIds, policyHash }
}

export interface GateResult {
  passed: boolean
  components: Record<string, number | null>
  reasons: string[]
}

export interface ReplayArtifact {
  tier: ExtractionTier
  artifactKey: string
  gate: GateResult
}

function nextTier(tier: ExtractionTier, reasons: string[]): ExtractionTier | null {
  const textFailure = reasons.some((reason) =>
    [
      'CHARACTER_SANITY_FAILED',
      'TEXT_RETENTION_FAILED',
      'USABLE_PAGE_RATIO_FAILED',
      'SCRIPT_CONSISTENCY_FAILED',
    ].includes(reason)
  )
  if (tier === 'T0') return textFailure ? 'T2' : 'T1'
  if (tier === 'T1') return textFailure ? 'T2' : 'T3'
  if (tier === 'T2') return 'T3'
  return null
}

export function replayEscalation(options: {
  initial: InitialRouteDecision
  artifacts: Partial<Record<ExtractionTier, ReplayArtifact>>
  maxEscalations: number
}): {
  status: 'accepted' | 'low-confidence' | 'unavailable'
  finalTier?: ExtractionTier
  selectedArtifactKey?: string
  steps: Array<ReplayArtifact & { nextTier?: ExtractionTier; reasons: string[] }>
} {
  const attempted = new Set<ExtractionTier>()
  const steps: Array<ReplayArtifact & { nextTier?: ExtractionTier; reasons: string[] }> = []
  let tier: ExtractionTier = options.initial.initialTier
  let escalations = 0

  while (true) {
    if (attempted.has(tier)) throw new Error(`Routing attempted tier ${tier} more than once`)
    attempted.add(tier)
    const artifact = options.artifacts[tier]
    if (!artifact) {
      return { status: 'unavailable', steps }
    }
    if (artifact.gate.passed) {
      steps.push({ ...artifact, reasons: artifact.gate.reasons })
      return {
        status: 'accepted',
        finalTier: tier,
        selectedArtifactKey: artifact.artifactKey,
        steps,
      }
    }

    const proposed = nextTier(tier, artifact.gate.reasons)
    if (proposed == null || escalations >= options.maxEscalations) {
      const reasons = [
        ...artifact.gate.reasons,
        proposed == null ? 'TERMINAL_TIER_FAILED' : 'MAX_ESCALATIONS_REACHED',
      ]
      steps.push({ ...artifact, reasons })
      return {
        status: 'low-confidence',
        finalTier: tier,
        selectedArtifactKey: artifact.artifactKey,
        steps,
      }
    }
    if (attempted.has(proposed)) throw new Error(`Routing would repeat tier ${proposed}`)
    steps.push({ ...artifact, reasons: artifact.gate.reasons, nextTier: proposed })
    tier = proposed
    escalations += 1
  }
}
