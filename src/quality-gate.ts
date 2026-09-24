import type { BenchmarkProviderArtifact } from './providers/types.js'

export interface QualityGateThresholds {
  characterSanity: number
  textRetention: number
  usablePageRatio: number
  structuralYield: number
  scriptConsistency: number
}

export interface QualityGateInspection {
  pageCount: number
  totalTextChars: number
  thaiCharRatio: number
  latinCharRatio: number
  expectsStructure: boolean
}

export interface QualityGateDecision {
  passed: boolean
  components: {
    characterSanity: number
    textRetention: number | null
    usablePageRatio: number | null
    structuralYield: number | null
    scriptConsistency: number | null
  }
  reasons: string[]
}

export type QualityGateComponents = QualityGateDecision['components']

function letters(value: string, expression: RegExp): number {
  return [...value].filter((character) => expression.test(character)).length
}

export function characterSanity(value: string): number {
  const characters = [...value].filter((character) => !/\p{White_Space}/u.test(character))
  if (characters.length === 0) return 0
  const anomalous = characters.filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      codePoint === 0xfffd ||
      (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    )
  }).length
  const pathologicalRuns = value.match(/(.)\1{7,}/gu) ?? []
  const repeatedPenalty = pathologicalRuns.reduce((sum, run) => sum + run.length - 7, 0)
  return Math.max(0, 1 - (anomalous + repeatedPenalty) / characters.length)
}

function hasStructure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasStructure)
  if (value == null || typeof value !== 'object') return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.some(
    ([key, child]) =>
      hasStructure(child) ||
      (['type', 'label', 'text'].includes(key) && typeof child === 'string' && child.length > 0)
  )
}

function scriptConsistency(text: string, inspection: QualityGateInspection): number | null {
  const thaiExpected = inspection.thaiCharRatio >= 0.1
  const latinExpected = inspection.latinCharRatio >= 0.1
  if (!thaiExpected && !latinExpected) return null
  const thai = letters(text, /[\u0E00-\u0E7F]/u)
  const latin = letters(text, /\p{Script=Latin}/u)
  const total = thai + latin
  if (total === 0) return 0
  const ratios: number[] = []
  if (thaiExpected) ratios.push(Math.min(1, thai / total / inspection.thaiCharRatio))
  if (latinExpected) ratios.push(Math.min(1, latin / total / inspection.latinCharRatio))
  return Math.min(...ratios)
}

export function evaluateQualityGate(options: {
  artifact: BenchmarkProviderArtifact
  inspection: QualityGateInspection
  thresholds: QualityGateThresholds
}): QualityGateDecision {
  const text = options.artifact.representations.text
  const components: QualityGateComponents = {
    characterSanity: characterSanity(text),
    textRetention:
      options.inspection.totalTextChars > 0
        ? Math.min(1, [...text].length / options.inspection.totalTextChars)
        : null,
    usablePageRatio:
      options.artifact.pages == null
        ? null
        : options.inspection.pageCount === 0
          ? null
          : options.artifact.pages.filter((page) => [...(page.text ?? '')].length >= 32).length /
            options.inspection.pageCount,
    structuralYield: options.inspection.expectsStructure
      ? hasStructure(options.artifact.representations.structure)
        ? 1
        : 0
      : null,
    scriptConsistency: scriptConsistency(text, options.inspection),
  }
  return decideQualityGate(components, options.thresholds)
}

export function decideQualityGate(
  components: QualityGateComponents,
  thresholds: QualityGateThresholds
): QualityGateDecision {
  const reasons: string[] = []
  if (components.characterSanity < thresholds.characterSanity) {
    reasons.push('CHARACTER_SANITY_FAILED')
  }
  if (components.textRetention != null && components.textRetention < thresholds.textRetention) {
    reasons.push('TEXT_RETENTION_FAILED')
  }
  if (
    components.usablePageRatio != null &&
    components.usablePageRatio < thresholds.usablePageRatio
  ) {
    reasons.push('USABLE_PAGE_RATIO_FAILED')
  }
  if (
    components.structuralYield != null &&
    components.structuralYield < thresholds.structuralYield
  ) {
    reasons.push('STRUCTURAL_YIELD_FAILED')
  }
  if (
    components.scriptConsistency != null &&
    components.scriptConsistency < thresholds.scriptConsistency
  ) {
    reasons.push('SCRIPT_CONSISTENCY_FAILED')
  }
  return { passed: reasons.length === 0, components, reasons }
}
