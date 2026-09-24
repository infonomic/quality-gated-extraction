import {
  deriveDegradedTiers,
  type ExtractionTier,
  type OracleTier,
} from './validate-annotations.js'

export const ACCEPTANCE_CRITERION = {
  id: 'reading-sufficiency-v1',
  summary:
    "Accept a tier's output for a page if a reader could obtain the page's content from it without material loss or corruption.",
  accept: [
    'all substantive content blocks present',
    'reading order preserves meaning',
    'characters correct',
    'lost table structure acceptable when values remain readable and in order',
    'running headers, folios and hyphenation artifacts ignored',
  ],
  reject: [
    'content blocks missing or empty',
    'columns interleaved so sentences run into unrelated text',
    'character corruption: replacement glyphs, wrong script, systematic substitutions',
    'table values no longer attributable to a row',
  ],
  note: 'Structural fidelity is not required by this criterion.',
} as const

/**
 * Second, independent axis. Criterion B asks whether a reader could recover the
 * page's content; it deliberately ignores structure. But structure is what a
 * search index and a retrieval assistant consume — headings for section-aware
 * chunking, table structure to attribute a value to its row, reading order for
 * coherent chunks, captions bound to their figure.
 *
 * Judged without this axis, T0's flat text passes criterion B on most
 * born-digital pages and the tier ladder above it looks unmotivated. The two
 * rates are reported separately and are not required to agree: a tier may be
 * readable but structurally flat (typical of T0), or structurally faithful yet
 * corrupted at character level (possible for forced OCR).
 */
export const STRUCTURAL_CRITERION = {
  id: 'structural-adequacy-v1',
  summary:
    "Accept a tier's output for a page if the page's structure survives well enough to drive section-aware chunking, table attribution and retrieval.",
  accept: [
    'headings recoverable as headings, not folded into body text',
    'table cells attributable to their row and column',
    'captions distinguishable from surrounding body text',
    'reading order correct across columns and around floats',
  ],
  reject: [
    'structure flattened into an undifferentiated text run',
    'table collapsed so values cannot be attributed',
    'caption merged into body text or into an unrelated block',
    'column or float order scrambled',
  ],
  note: 'Independent of reading sufficiency. A tier may satisfy one criterion and not the other.',
} as const

export const ORACLE_DERIVATION = {
  fields: ['higherTierDegraded', 'degradedTiers'],
  rule: 'A tier skipped between the lowest and highest accepted tier, on either axis, means a more expensive tier produced worse output than a cheaper one.',
  basis:
    'Derived from usableTiers and structurallyAdequateTiers. Not entered by the annotator; the checkbox was left unticked on all 32 pages.',
} as const

const tierOrder: ExtractionTier[] = ['T0', 'T1', 'T2', 'T3']
const scripts = ['english', 'thai', 'mixed', 'other'] as const

export interface OracleJudgement {
  script: (typeof scripts)[number]
  lowestUsableTier: OracleTier
  usableTiers: ExtractionTier[]
  lowestStructurallyAdequateTier: OracleTier
  structurallyAdequateTiers: ExtractionTier[]
  structuralAssessmentConfirmed: true
  higherTierDegraded: boolean
  degradedTiers: ExtractionTier[]
  notes: string | null
  annotator: string
  judgedAt: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Oracle judgement must be an object')
  }
  return value as Record<string, unknown>
}

export function normaliseOracleJudgement(
  value: unknown,
  judgedAt = new Date().toISOString()
): OracleJudgement {
  const input = record(value)
  if (!scripts.includes(input.script as (typeof scripts)[number])) {
    throw new Error('Oracle judgement requires a valid page script')
  }
  const annotator = typeof input.annotator === 'string' ? input.annotator.trim() : ''
  if (!annotator) throw new Error('Oracle judgement requires an annotator')
  const tierSet = (value: unknown, field: string): ExtractionTier[] => {
    if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
    if (value.some((tier) => !tierOrder.includes(tier as ExtractionTier))) {
      throw new Error(`${field} contains an unknown tier`)
    }
    const ordered = tierOrder.filter((tier) => value.includes(tier))
    if (ordered.length !== value.length) throw new Error(`${field} must be unique`)
    return ordered
  }
  const usableTiers = tierSet(input.usableTiers, 'usableTiers')
  // Required, not defaulted: an absent structural axis would otherwise record
  // "no tier preserved structure", which is a strong claim nobody made.
  const structurallyAdequateTiers = tierSet(
    input.structurallyAdequateTiers,
    'structurallyAdequateTiers'
  )
  if (input.structuralAssessmentConfirmed !== true) {
    throw new Error('structuralAssessmentConfirmed must be true')
  }
  const degradedTiers = deriveDegradedTiers(usableTiers, structurallyAdequateTiers)
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null
  return {
    script: input.script as OracleJudgement['script'],
    lowestUsableTier: usableTiers[0] ?? 'unusable',
    usableTiers,
    lowestStructurallyAdequateTier: structurallyAdequateTiers[0] ?? 'unusable',
    structurallyAdequateTiers,
    structuralAssessmentConfirmed: true,
    higherTierDegraded: degradedTiers.length > 0,
    degradedTiers,
    notes,
    annotator,
    judgedAt,
  }
}

export function hasFrozenAcceptanceCriterion(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(ACCEPTANCE_CRITERION)
}

export function hasFrozenStructuralCriterion(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(STRUCTURAL_CRITERION)
}

export function hasDeclaredOracleDerivation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const declaration = value as Record<string, unknown>
  return (
    JSON.stringify(declaration.fields) === JSON.stringify(ORACLE_DERIVATION.fields) &&
    declaration.rule === ORACLE_DERIVATION.rule &&
    declaration.basis === ORACLE_DERIVATION.basis &&
    typeof declaration.appliedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(declaration.appliedAt)
  )
}
