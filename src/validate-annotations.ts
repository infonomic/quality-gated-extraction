import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { Stratum } from './sample.js'

export type ExtractionTier = 'T0' | 'T1' | 'T2' | 'T3'
export type OracleTier = ExtractionTier | 'unusable'

export interface AnnotationElement {
  id: string
  type: 'heading' | 'table-cell' | 'caption' | 'reference' | 'body'
  text: string
  readingOrder: number
}

export interface BoundaryOpportunity {
  id: string
  type: 'heading-body' | 'table-cell' | 'caption' | 'reference'
  expectedAction: 'break' | 'join'
  beforeElementId: string
  afterElementId: string
}

export interface StructuralScope {
  status: 'unavailable' | 'partial' | 'complete'
  ruleId: 'not-annotated-v1' | 'table-header-first-five-rows-and-all-non-body-v1' | 'full-page-v1'
  description: string
}

export type TextReference =
  | { status: 'unavailable'; reason: string }
  | { status: 'complete'; transcription: string }

export interface AnnotationRecord {
  schemaVersion: 1
  annotationStatus: 'pending' | 'oracle-complete' | 'structure-partial' | 'complete'
  caseId: string
  page: number
  script: 'pending' | 'english' | 'thai' | 'mixed' | 'other'
  elements: AnnotationElement[]
  boundaryOpportunities: BoundaryOpportunity[]
  lowestUsableTier?: OracleTier
  usableTiers?: ExtractionTier[]
  lowestStructurallyAdequateTier?: OracleTier
  structurallyAdequateTiers?: ExtractionTier[]
  structuralAssessmentConfirmed?: true
  higherTierDegraded?: boolean
  degradedTiers?: ExtractionTier[]
  acceptanceCriterionId?: 'reading-sufficiency-v1'
  structuralCriterionId?: 'structural-adequacy-v1'
  annotator?: string
  judgedAt?: string
  reviewedBy?: string
  structuralScope?: StructuralScope
  textReference?: TextReference
}

export interface ExpectedAnnotation {
  caseId: string
  page: number
  stratum: Stratum
  annotationFile: string
}

export interface AnnotationPackManifest {
  schemaVersion: 1
  subsetSha256: string
  denominators: { evaluationDocuments: number; evaluationPages: number }
  annotations: ExpectedAnnotation[]
}

const tierOrder: ExtractionTier[] = ['T0', 'T1', 'T2', 'T3']

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

export function deriveLowestUsableTier(usableTiers: ExtractionTier[]): OracleTier {
  return tierOrder.find((tier) => usableTiers.includes(tier)) ?? 'unusable'
}

/**
 * A tier is degraded when it is rejected between a cheaper and a more
 * expensive accepted tier on either independent oracle axis. The result is
 * ordered and deduplicated so it can be persisted and audited deterministically.
 */
export function deriveDegradedTiers(
  usableTiers: ExtractionTier[],
  structurallyAdequateTiers: ExtractionTier[]
): ExtractionTier[] {
  const degraded = new Set<ExtractionTier>()
  for (const accepted of [usableTiers, structurallyAdequateTiers]) {
    const acceptedIndexes = tierOrder
      .map((tier, index) => (accepted.includes(tier) ? index : -1))
      .filter((index) => index >= 0)
    if (acceptedIndexes.length < 2) continue
    const first = acceptedIndexes[0]
    const last = acceptedIndexes.at(-1)
    if (first === undefined || last === undefined) continue
    for (let index = first + 1; index < last; index += 1) {
      const tier = tierOrder[index]
      if (tier && !accepted.includes(tier)) degraded.add(tier)
    }
  }
  return tierOrder.filter((tier) => degraded.has(tier))
}

export function validateAnnotationSemantics(
  annotation: AnnotationRecord,
  expected: Pick<ExpectedAnnotation, 'caseId' | 'page' | 'stratum'>
): string[] {
  const errors: string[] = []
  if (annotation.caseId !== expected.caseId || annotation.page !== expected.page) {
    errors.push(`identity must be ${expected.caseId} page ${expected.page}`)
  }
  if (annotation.annotationStatus === 'pending') return errors

  const usableTiers = annotation.usableTiers ?? []
  const sortedUsableTiers = tierOrder.filter((tier) => usableTiers.includes(tier))
  if (usableTiers.join(',') !== sortedUsableTiers.join(',')) {
    errors.push('usable tiers must be unique and ordered T0 through T3')
  }
  const derivedLowest = deriveLowestUsableTier(usableTiers)
  if (annotation.lowestUsableTier !== derivedLowest) {
    errors.push(`lowest usable tier must be derived as ${derivedLowest}`)
  }
  const structurallyAdequateTiers = annotation.structurallyAdequateTiers ?? []
  const sortedStructurallyAdequateTiers = tierOrder.filter((tier) =>
    structurallyAdequateTiers.includes(tier)
  )
  if (structurallyAdequateTiers.join(',') !== sortedStructurallyAdequateTiers.join(',')) {
    errors.push('structurally adequate tiers must be unique and ordered T0 through T3')
  }
  const derivedStructuralLowest = deriveLowestUsableTier(structurallyAdequateTiers)
  if (annotation.lowestStructurallyAdequateTier !== derivedStructuralLowest) {
    errors.push(`lowest structurally adequate tier must be derived as ${derivedStructuralLowest}`)
  }
  const derivedDegradedTiers = deriveDegradedTiers(usableTiers, structurallyAdequateTiers)
  if ((annotation.degradedTiers ?? []).join(',') !== derivedDegradedTiers.join(',')) {
    errors.push(
      `degraded tiers must be derived as ${derivedDegradedTiers.length ? derivedDegradedTiers.join(',') : 'none'}`
    )
  }
  if (annotation.higherTierDegraded !== derivedDegradedTiers.length > 0) {
    errors.push(`higher-tier degradation must be derived as ${derivedDegradedTiers.length > 0}`)
  }
  if (annotation.structuralScope?.status === 'unavailable') return errors

  const elementIds = annotation.elements.map((element) => element.id)
  if (!unique(elementIds)) errors.push('element IDs must be unique')
  const readingOrder = annotation.elements.map((element) => element.readingOrder)
  if (!unique(readingOrder.map(String))) errors.push('reading-order values must be unique')
  const expectedOrder = annotation.elements.map((_, index) => index)
  if (
    readingOrder
      .slice()
      .sort((a, b) => a - b)
      .join(',') !== expectedOrder.join(',')
  ) {
    errors.push('reading-order values must be contiguous from zero')
  }
  const boundaryIds = annotation.boundaryOpportunities.map((boundary) => boundary.id)
  if (!unique(boundaryIds)) errors.push('boundary IDs must be unique')
  const knownElements = new Set(elementIds)
  for (const boundary of annotation.boundaryOpportunities) {
    if (!knownElements.has(boundary.beforeElementId)) {
      errors.push(`${boundary.id} references unknown before element ${boundary.beforeElementId}`)
    }
    if (!knownElements.has(boundary.afterElementId)) {
      errors.push(`${boundary.id} references unknown after element ${boundary.afterElementId}`)
    }
    if (boundary.beforeElementId === boundary.afterElementId) {
      errors.push(`${boundary.id} must join two different elements`)
    }
  }
  return errors
}

export async function validateAnnotationPack(options: {
  manifestPath: string
  requireOracle?: boolean
  requireStructure?: boolean
  requireTextReference?: boolean
  requireComplete?: boolean
}) {
  const manifestPath = path.resolve(options.manifestPath)
  const privateRoot = path.dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AnnotationPackManifest
  if (manifest.annotations.length !== manifest.denominators.evaluationPages) {
    throw new Error('Annotation manifest denominator does not match its records')
  }
  const identities = manifest.annotations.map((item) => `${item.caseId}:${item.page}`)
  if (!unique(identities)) throw new Error('Annotation manifest contains duplicate pages')

  const registry = await createSchemaRegistry()
  const byStratum = new Map<
    Stratum,
    { expected: number; oracleComplete: number; pending: number }
  >()
  let oracleComplete = 0
  let pending = 0
  let structurePartial = 0
  let structureComplete = 0
  let structureUnavailable = 0
  let textComplete = 0
  let textUnavailable = 0
  for (const expected of manifest.annotations) {
    const annotation = JSON.parse(
      await readFile(path.resolve(privateRoot, expected.annotationFile), 'utf8')
    ) as AnnotationRecord
    const schema = registry.validate('annotation', annotation)
    const errors = schema.valid
      ? validateAnnotationSemantics(annotation, expected)
      : [formatValidationErrors(schema.errors)]
    if (errors.length > 0) {
      throw new Error(`${expected.caseId} page ${expected.page}: ${errors.join('; ')}`)
    }
    const counts = byStratum.get(expected.stratum) ?? {
      expected: 0,
      oracleComplete: 0,
      pending: 0,
    }
    counts.expected += 1
    if (annotation.annotationStatus === 'pending') {
      pending += 1
      counts.pending += 1
    } else {
      oracleComplete += 1
      counts.oracleComplete += 1
      if (annotation.structuralScope?.status === 'partial') structurePartial += 1
      else if (annotation.structuralScope?.status === 'complete') structureComplete += 1
      else structureUnavailable += 1
      if (annotation.textReference?.status === 'complete') textComplete += 1
      else textUnavailable += 1
    }
    byStratum.set(expected.stratum, counts)
  }

  const requireOracle = options.requireComplete || options.requireOracle
  const requireStructure = options.requireComplete || options.requireStructure
  const requireTextReference = options.requireComplete || options.requireTextReference
  if (requireOracle && pending > 0) {
    throw new Error(
      `Human oracle incomplete: ${pending}/${manifest.annotations.length} pages pending`
    )
  }
  if (requireStructure && structureUnavailable > 0) {
    throw new Error(
      `Structural annotation unavailable: ${structureUnavailable}/${manifest.annotations.length} pages`
    )
  }
  if (requireTextReference && textUnavailable > 0) {
    throw new Error(
      `Text reference unavailable: ${textUnavailable}/${manifest.annotations.length} pages`
    )
  }
  return {
    schemaVersion: 1,
    status: pending === 0 ? ('oracle-complete' as const) : ('pending' as const),
    oracle: {
      numerator: oracleComplete,
      denominator: manifest.annotations.length,
      excludedCount: pending,
    },
    structure: {
      partial: structurePartial,
      complete: structureComplete,
      unavailable: structureUnavailable,
      denominator: manifest.annotations.length,
      excludedCount: pending + structureUnavailable,
    },
    textReference: {
      numerator: textComplete,
      denominator: manifest.annotations.length,
      excludedCount: pending + textUnavailable,
      unavailable: textUnavailable,
    },
    byStratum: Object.fromEntries(byStratum),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const manifestPath = args.find((arg) => !arg.startsWith('--'))
  if (!manifestPath) {
    throw new Error(
      'Usage: validate-annotations.ts <annotation-pack.json> [--require-oracle|--require-structure|--require-text-reference|--require-complete]'
    )
  }
  const result = await validateAnnotationPack({
    manifestPath,
    requireOracle: args.includes('--require-oracle'),
    requireStructure: args.includes('--require-structure'),
    requireTextReference: args.includes('--require-text-reference'),
    requireComplete: args.includes('--require-complete'),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
