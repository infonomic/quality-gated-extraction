import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { type FrozenSample, type InspectionRecord, selectPages, strata } from './sample.js'

interface FrozenPolicy {
  status: 'frozen'
  configHash: string
  sampleHash: string
  policyHash: string
  evaluationMatrixCellsPresentAtFreeze: number
  evaluationCaseIdsOpened: string[]
}

interface SelectionConfig {
  seed: string
  sample: { annotatedPagesPerDocument: number }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildT3PageSubsetDeclaration(options: {
  sample: FrozenSample
  sampleHash: string
  inspections: InspectionRecord[]
  inspectionHash: string
  config: SelectionConfig
  configHash: string
  policy: FrozenPolicy
  policyArtifactHash: string
  evaluationCellNames: string[]
}) {
  const evaluationCells = options.evaluationCellNames.filter((name) =>
    /^evaluation-.+\.json$/u.test(name)
  )
  if (evaluationCells.length > 0) {
    throw new Error(
      `Evaluation is already open; refusing page declaration: ${evaluationCells.sort().join(', ')}`
    )
  }
  if (
    options.policy.status !== 'frozen' ||
    options.policy.evaluationMatrixCellsPresentAtFreeze !== 0 ||
    options.policy.evaluationCaseIdsOpened.length !== 0
  ) {
    throw new Error('Frozen policy does not certify an untouched evaluation partition')
  }
  if (options.sampleHash !== options.policy.sampleHash) {
    throw new Error('Frozen policy sample hash does not match the selected sample')
  }
  if (
    options.configHash !== options.sample.configHash ||
    options.configHash !== options.policy.configHash
  ) {
    throw new Error('Config hash differs across config, sample and frozen policy')
  }
  if (
    options.inspectionHash !== options.sample.inspectionHash ||
    options.config.seed !== options.sample.seed
  ) {
    throw new Error('Selection inputs differ from the frozen sample provenance')
  }
  if (options.config.sample.annotatedPagesPerDocument !== 2) {
    throw new Error('The reviewed T3 subset decision requires exactly two pages per document')
  }

  const inspectionsByCase = new Map(
    options.inspections.map((inspection) => [inspection.caseId, inspection])
  )
  const selection = (partition: 'calibration' | 'evaluation') =>
    options.sample[partition].map((item) => {
      const inspection = inspectionsByCase.get(item.caseId)
      if (!inspection) throw new Error(`Missing frozen inspection for ${item.caseId}`)
      const pages = selectPages(
        inspection,
        item.stratum,
        options.config.sample.annotatedPagesPerDocument,
        options.sample.seed
      )
      if ('pages' in item && JSON.stringify(pages) !== JSON.stringify(item.pages)) {
        throw new Error(`Evaluation page rule does not reproduce frozen pages for ${item.caseId}`)
      }
      return {
        caseId: item.caseId,
        stratum: item.stratum,
        documentPageCount: item.pageCount,
        pages,
      }
    })

  const calibration = selection('calibration')
  const evaluation = selection('evaluation')
  const byStratum = Object.fromEntries(
    strata.map((stratum) => {
      const calibrationItems = calibration.filter((item) => item.stratum === stratum)
      const evaluationItems = evaluation.filter((item) => item.stratum === stratum)
      return [
        stratum,
        {
          calibrationDocuments: calibrationItems.length,
          calibrationPages: calibrationItems.reduce((sum, item) => sum + item.pages.length, 0),
          evaluationDocuments: evaluationItems.length,
          evaluationPages: evaluationItems.reduce((sum, item) => sum + item.pages.length, 0),
        },
      ]
    })
  )

  return {
    schemaVersion: 1,
    status: 'frozen',
    declaredAt: '2026-08-05',
    scope: 'T3 independent page-image submissions only; full-document T3 remains censored',
    selectionRule: {
      id: 'frozen-sample-page-score-v1',
      countPerDocument: options.config.sample.annotatedPagesPerDocument,
      implementation: 'src/sample.ts#selectPages',
      seed: options.sample.seed,
      tieBreak: 'sha256(seed, caseId:page, page number)',
      note: 'The identical rule that froze evaluation annotation pages is applied to calibration; frozen evaluation pages are independently reproduced and asserted unchanged.',
    },
    provenance: {
      configHash: options.configHash,
      inspectionHash: options.inspectionHash,
      sampleHash: options.sampleHash,
      policyArtifactHash: options.policyArtifactHash,
      policyHash: options.policy.policyHash,
    },
    evaluationBoundary: {
      evaluationMatrixCellsPresentAtPolicyFreeze: 0,
      evaluationMatrixCellsPresentAtDeclaration: 0,
      evaluationCaseIdsOpened: [],
      evaluationArtifactsOpenedAtDeclaration: [],
    },
    denominators: {
      calibrationDocuments: calibration.length,
      calibrationPages: calibration.reduce((sum, item) => sum + item.pages.length, 0),
      evaluationDocuments: evaluation.length,
      evaluationPages: evaluation.reduce((sum, item) => sum + item.pages.length, 0),
      totalDocuments: calibration.length + evaluation.length,
      totalPages: [...calibration, ...evaluation].reduce((sum, item) => sum + item.pages.length, 0),
      byStratum,
    },
    calibration,
    evaluation,
    reportingDecision:
      'Retain four evaluation documents and eight evaluation pages per stratum. Report per-stratum outcomes as raw counts with denominators, not population rates.',
  }
}

async function main(): Promise<void> {
  const [configPath, inspectionPath, samplePath, policyPath, cellsDirectory, outputPath] =
    process.argv.slice(2, 8)
  if (
    !configPath ||
    !inspectionPath ||
    !samplePath ||
    !policyPath ||
    !cellsDirectory ||
    !outputPath
  ) {
    throw new Error(
      'Usage: predeclare-t3-pages.ts <config.json> <inspection.jsonl> <sample.json> <policy.json> <cells-directory> <output.json>'
    )
  }
  const [configBytes, inspectionBytes, sampleBytes, policyBytes, cellNames] = await Promise.all([
    readFile(path.resolve(configPath)),
    readFile(path.resolve(inspectionPath)),
    readFile(path.resolve(samplePath)),
    readFile(path.resolve(policyPath)),
    readdir(path.resolve(cellsDirectory)),
  ])
  const declaration = buildT3PageSubsetDeclaration({
    config: JSON.parse(configBytes.toString('utf8')) as SelectionConfig,
    configHash: sha256(configBytes),
    inspections: inspectionBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as InspectionRecord),
    inspectionHash: sha256(inspectionBytes),
    sample: JSON.parse(sampleBytes.toString('utf8')) as FrozenSample,
    sampleHash: sha256(sampleBytes),
    policy: JSON.parse(policyBytes.toString('utf8')) as FrozenPolicy,
    policyArtifactHash: sha256(policyBytes),
    evaluationCellNames: cellNames,
  })
  const destination = path.resolve(outputPath)
  const contents = `${JSON.stringify(declaration, null, 2)}\n`
  await writeFile(destination, contents, { flag: 'wx' })
  await writeFile(
    `${destination}.manifest.json`,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifact: path.basename(destination),
        sha256: sha256(contents),
        immutableWrite: true,
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  )
  console.log(JSON.stringify(declaration.denominators, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
