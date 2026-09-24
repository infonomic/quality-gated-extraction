import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  hasDeclaredOracleDerivation,
  hasFrozenAcceptanceCriterion,
  hasFrozenStructuralCriterion,
  normaliseOracleJudgement,
  type OracleJudgement,
} from './oracle.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import {
  type AnnotationPackManifest,
  type AnnotationRecord,
  validateAnnotationPack,
  validateAnnotationSemantics,
} from './validate-annotations.js'

interface RecordedOracleJudgement extends OracleJudgement {
  caseId: string
  page: number
  stratum: string
}

type OracleFile = Record<string, unknown> & {
  acceptanceCriterion?: unknown
  structuralCriterion?: unknown
  derivation?: unknown
}

export function foldOracleIntoAnnotation(
  annotation: AnnotationRecord,
  judgement: OracleJudgement
): AnnotationRecord {
  const structureExists =
    annotation.annotationStatus === 'structure-partial' ||
    annotation.annotationStatus === 'complete'
  return {
    ...annotation,
    annotationStatus: structureExists ? annotation.annotationStatus : 'oracle-complete',
    script: judgement.script,
    lowestUsableTier: judgement.lowestUsableTier,
    usableTiers: judgement.usableTiers,
    lowestStructurallyAdequateTier: judgement.lowestStructurallyAdequateTier,
    structurallyAdequateTiers: judgement.structurallyAdequateTiers,
    structuralAssessmentConfirmed: judgement.structuralAssessmentConfirmed,
    higherTierDegraded: judgement.higherTierDegraded,
    degradedTiers: judgement.degradedTiers,
    acceptanceCriterionId: 'reading-sufficiency-v1',
    structuralCriterionId: 'structural-adequacy-v1',
    annotator: judgement.annotator,
    judgedAt: judgement.judgedAt,
    structuralScope: structureExists
      ? annotation.structuralScope
      : {
          status: 'unavailable',
          ruleId: 'not-annotated-v1',
          description: 'Structural annotation was not produced in the oracle pass.',
        },
    textReference: annotation.textReference ?? {
      status: 'unavailable',
      reason:
        'Exact real-document transcription was not feasible within the submission deadline; CER/WER unavailable.',
    },
  }
}

async function writeAtomic(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, contents, { flag: 'wx' })
  await rename(temporary, destination)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const runId = valueAfter('--run-id') ?? 'phase3-matrix-20260805'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId)) throw new Error('Unsafe run ID')
  const manifestPath = path.resolve(
    valueAfter('--manifest') ?? 'annotations/private/annotation-pack.json'
  )
  const oraclePath = path.resolve(
    valueAfter('--oracle') ?? path.join('work', runId, 'adjudication/oracle.json')
  )
  const requireAll = args.includes('--require-all')
  const oracle = JSON.parse(await readFile(oraclePath, 'utf8')) as OracleFile
  if (!hasFrozenAcceptanceCriterion(oracle.acceptanceCriterion)) {
    throw new Error('Oracle acceptance criterion differs from reading-sufficiency-v1')
  }
  if (!hasFrozenStructuralCriterion(oracle.structuralCriterion)) {
    throw new Error('Oracle structural criterion differs from structural-adequacy-v1')
  }
  if (!hasDeclaredOracleDerivation(oracle.derivation)) {
    throw new Error('Oracle degradation derivation is missing or differs from the declared rule')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AnnotationPackManifest
  const privateRoot = path.dirname(manifestPath)
  const registry = await createSchemaRegistry()
  const expectedKeys = new Set(manifest.annotations.map((item) => `${item.caseId}:${item.page}`))
  const oracleKeys = Object.keys(oracle).filter(
    (key) => key !== 'acceptanceCriterion' && key !== 'structuralCriterion' && key !== 'derivation'
  )
  const unexpected = oracleKeys.filter((key) => !expectedKeys.has(key))
  if (unexpected.length > 0) {
    throw new Error(`Oracle contains pages outside the frozen pack: ${unexpected.join(', ')}`)
  }
  const missing = [...expectedKeys].filter((key) => oracle[key] == null)
  if (requireAll && missing.length > 0) {
    throw new Error(
      `Oracle incomplete: ${missing.length}/${manifest.annotations.length} pages missing`
    )
  }
  let folded = 0
  for (const expected of manifest.annotations) {
    const key = `${expected.caseId}:${expected.page}`
    const raw = oracle[key]
    if (!raw) continue
    const recorded = raw as Partial<RecordedOracleJudgement>
    if (
      recorded.caseId !== expected.caseId ||
      recorded.page !== expected.page ||
      recorded.stratum !== expected.stratum
    ) {
      throw new Error(`${key} oracle identity or stratum differs from the frozen pack`)
    }
    const judgement = normaliseOracleJudgement(recorded, recorded.judgedAt)
    const destination = path.resolve(privateRoot, expected.annotationFile)
    const annotation = JSON.parse(await readFile(destination, 'utf8')) as AnnotationRecord
    const foldedAnnotation = foldOracleIntoAnnotation(annotation, judgement)
    const schema = registry.validate('annotation', foldedAnnotation)
    const errors = schema.valid
      ? validateAnnotationSemantics(foldedAnnotation, expected)
      : [formatValidationErrors(schema.errors)]
    if (errors.length > 0) throw new Error(`${key}: ${errors.join('; ')}`)
    await writeAtomic(destination, `${JSON.stringify(foldedAnnotation, null, 2)}\n`)
    folded += 1
  }
  const validation = await validateAnnotationPack({
    manifestPath,
    requireOracle: requireAll,
  })
  console.log(JSON.stringify({ folded, missing: missing.length, validation }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
