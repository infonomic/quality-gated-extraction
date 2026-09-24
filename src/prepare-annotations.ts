import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { validateAnnotationPack } from './validate-annotations.js'
import type { PageDeclaration } from './run-t3-pages.js'

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writePending(
  destination: string,
  contents: string
): Promise<'created' | 'preserved'> {
  try {
    await writeFile(destination, contents, { flag: 'wx' })
    return 'created'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return 'preserved'
  }
}

async function main(): Promise<void> {
  const [runId = 'phase3-matrix-20260805'] = process.argv.slice(2).filter((arg) => arg !== '--')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(runId)) throw new Error('Unsafe run ID')
  const runDirectory = path.resolve('work', runId)
  const subsetPath = path.join(runDirectory, 't3-page-subset.json')
  const subsetBytes = await readFile(subsetPath)
  const subset = JSON.parse(subsetBytes.toString('utf8')) as PageDeclaration & {
    denominators: PageDeclaration['denominators'] & { evaluationDocuments: number }
  }
  const privateRoot = path.resolve('annotations/private')
  await mkdir(privateRoot, { recursive: true })

  const annotations = []
  let created = 0
  let preserved = 0
  for (const item of subset.evaluation) {
    const caseDirectory = path.join(privateRoot, item.caseId)
    await mkdir(caseDirectory, { recursive: true })
    for (const page of item.pages) {
      const stem = `${item.caseId}-P${String(page).padStart(4, '0')}`
      const imagePath = path.join(runDirectory, 't3-page-images', `${stem}.png`)
      const image = await readFile(imagePath)
      const annotationFile = path.join(
        item.caseId,
        `P${String(page).padStart(4, '0')}.private.json`
      )
      const result = await writePending(
        path.join(privateRoot, annotationFile),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            annotationStatus: 'pending',
            caseId: item.caseId,
            page,
            script: 'pending',
            elements: [],
            boundaryOpportunities: [],
          },
          null,
          2
        )}\n`
      )
      if (result === 'created') created += 1
      else preserved += 1
      annotations.push({
        caseId: item.caseId,
        page,
        stratum: item.stratum,
        imageFile: path.relative(privateRoot, imagePath),
        imageSha256: sha256(image),
        annotationFile,
      })
    }
  }
  if (annotations.length !== subset.denominators.evaluationPages) {
    throw new Error('Frozen evaluation page denominator does not match annotation pack')
  }
  const manifestPath = path.join(privateRoot, 'annotation-pack.json')
  await writePending(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'pending-human-annotation',
        subsetSha256: sha256(subsetBytes),
        denominators: {
          evaluationDocuments: subset.evaluation.length,
          evaluationPages: subset.denominators.evaluationPages,
        },
        annotations,
      },
      null,
      2
    )}\n`
  )
  await writePending(
    path.resolve('annotations/README.private.md'),
    `# Private annotation and oracle workflow\n\nThis pack contains the 32 evaluation pages frozen before evaluation opened. It is private because the page images, provider outputs and adjudications contain source-derived text.\n\nThe submission-critical pass is a two-axis human oracle. From \`benchmarks/extraction\`, run \`pnpm adjudicate\`, open \`http://127.0.0.1:7788\`, and judge every tier shown for every page under both reading sufficiency and structural adequacy. The UI shows typed structural views, retains each axis independently, and derives \`lowestUsableTier\` and \`lowestStructurallyAdequateTier\` from measured cost order. It also derives higher-tier degradation from rejected tiers between cheaper and more expensive accepted tiers on either axis; this is a readout, not a third annotator input. Confirm Criterion C explicitly even when no tier passes; the confirmation is persisted in the judgement. It writes only \`work/phase3-matrix-20260805/adjudication/oracle.json\`. Do not open policy results or metrics during this pass. Provider outputs must be visible for oracle comparison; this is different from content annotation.\n\nJudge all visible substantive text from the page image, including speech balloons, captions, labels and cover text. Provider image markup is a model decision, not evidence that a page contains no text; reject a tier that drops visible text under the ordinary reading-sufficiency rule. Reading and structural tier sets are independent; do not force one to be a subset of the other.\n\nAfter all 32 pages are judged, fold the private side file into the annotation records with \`pnpm fold:oracle -- --require-all\`, then verify \`pnpm validate:annotations -- annotations/private/annotation-pack.json --require-oracle\`.\n\nElement-level structural annotation is optional and separate from the required structural-adequacy oracle. Create it from the page image without consulting tier outputs. A partial page must use \`structuralScope.status: partial\` and the predeclared \`table-header-first-five-rows-and-all-non-body-v1\` rule: annotate every heading, caption and reference; for each table annotate the header row and first five data rows; omit body prose. Never label a partial page \`complete\`.\n\nExact real-document transcription is not required for the submission. Records folded from the oracle mark \`textReference.status: unavailable\` with the deadline reason, so real-document CER/WER stays unavailable. The Phase 1 synthetic control remains the character-accuracy result.\n\nIf feasible, have a second person review eight oracle pages (25%) and add \`reviewedBy\`; otherwise retain the single-annotator limitation.\n`
  )
  const validation = await validateAnnotationPack({ manifestPath })
  console.log(JSON.stringify({ created, preserved, validation }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
