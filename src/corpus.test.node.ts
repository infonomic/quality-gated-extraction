import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  assignPrivateCaseIds,
  CURRENT_PUBLICATION_DOCUMENTS_SQL,
  CURRENT_PUBLICATION_FILES_SQL,
  inspectCorpus,
  type PrivateCorpusSource,
  readStoredFileBytes,
} from './corpus.js'
import { createSyntheticBornDigitalPdf } from './fixtures/synthetic-pdf.js'
import { createSchemaRegistry } from './schema-registry.js'

const thresholds = {
  minimumTextCharsPerPage: 32,
  fullPageImageAreaRatio: 0.8,
  mixedScriptMinimumRatio: 0.1,
}

function source(
  documentId: string,
  storagePath: string,
  mimeType = 'application/pdf'
): PrivateCorpusSource {
  return {
    documentId,
    documentVersionId: `${documentId}-version`,
    attachmentOrdinal: 0,
    fieldPath: 'files.0.filesGroup.publicationFile',
    storedFile: {
      filename: 'private.pdf',
      originalFilename: 'private-original.pdf',
      mimeType,
      fileSize: 100,
      storageProvider: 's3',
      storagePath,
      storageUrl: `https://storage.invalid/${storagePath}`,
    },
  }
}

describe('read-only corpus boundaries', () => {
  test('assigns stable case ids without exposing source values', () => {
    const first = assignPrivateCaseIds([
      source('document-b', 'private/b.pdf'),
      source('document-a', 'private/a.pdf'),
    ])
    const repeat = assignPrivateCaseIds([
      source('document-a', 'private/a.pdf'),
      source('document-b', 'private/b.pdf'),
    ])

    expect(first.map(({ caseId, sourceKey }) => ({ caseId, sourceKey }))).toEqual(
      repeat.map(({ caseId, sourceKey }) => ({ caseId, sourceKey }))
    )
    expect(first.map((item) => item.caseId)).toEqual(['F001', 'F002'])
  })

  test('database statements contain no mutation operation', () => {
    for (const statement of [CURRENT_PUBLICATION_DOCUMENTS_SQL, CURRENT_PUBLICATION_FILES_SQL]) {
      expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/iu)
      expect(statement).toMatch(/^\s*WITH\b/iu)
    }
  })

  test('remote storage is read with GET and never a write method', async () => {
    const calls: RequestInit[] = []
    const bytes = await readStoredFileBytes(
      source('document-a', 'private/a.pdf').storedFile,
      '/not-used',
      async (_input, init) => {
        calls.push(init ?? {})
        return new Response('pdf bytes', { status: 200 })
      }
    )

    expect(bytes.toString()).toBe('pdf bytes')
    expect(calls).toEqual([expect.objectContaining({ method: 'GET' })])
    expect(calls.map((call) => call.method)).not.toContain('PUT')
    expect(calls.map((call) => call.method)).not.toContain('DELETE')
  })

  test('rejects local paths outside the uploads root', async () => {
    const storedFile = {
      ...source('document-a', 'private/a.pdf').storedFile,
      storageUrl: undefined,
      storagePath: '../private.pdf',
    }
    await expect(readStoredFileBytes(storedFile, '/safe/uploads')).rejects.toThrow(
      'STORAGE_PATH_OUTSIDE_UPLOADS'
    )
  })
})

describe('corpus inspection', () => {
  let temporaryDirectory = ''

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'forru-corpus-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  test('accounts for included, excluded and unreadable attachments deterministically', async () => {
    const pdf = Buffer.from(createSyntheticBornDigitalPdf())
    const malformed = Buffer.from('not a PDF')
    const sources = [
      source('document-a', 'private/a.pdf'),
      source('document-b', 'private/b.pdf'),
      source(
        'document-c',
        'private/c.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        const body = url.endsWith('/a.pdf') ? pdf : malformed
        return new Response(body, { status: 200 })
      })
    )
    const common = {
      runId: 'synthetic-corpus',
      outputDirectory: temporaryDirectory,
      uploadsDirectory: path.join(temporaryDirectory, 'uploads'),
      documents: [
        { documentId: 'document-a', documentVersionId: 'document-a-version' },
        { documentId: 'document-b', documentVersionId: 'document-b-version' },
        { documentId: 'document-c', documentVersionId: 'document-c-version' },
      ],
      sources,
      databaseEvidence: {
        transactionReadOnly: true as const,
        statements: ['BEGIN', 'SET', 'SHOW', 'WITH', 'WITH', 'ROLLBACK'],
      },
      thresholds,
      observedAt: '2026-08-05T00:00:00.000Z',
    }
    const first = await inspectCorpus(common)
    const repeat = await inspectCorpus(common)

    expect(first.counts).toEqual({
      documents: 3,
      attachments: 3,
      includedPdfs: 1,
      excludedNonPdfs: 1,
      unreadablePdfs: 1,
      inspectedPdfs: 1,
      inspectedPages: 1,
    })
    expect(repeat.outputHashes).toEqual(first.outputHashes)
    expect(
      first.counts.includedPdfs + first.counts.excludedNonPdfs + first.counts.unreadablePdfs
    ).toBe(first.counts.attachments)

    const corpus = (await readFile(path.join(temporaryDirectory, 'corpus.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(corpus).toHaveLength(3)
    expect(JSON.stringify(corpus)).not.toContain('private/')
    expect(JSON.stringify(corpus)).not.toContain('filename')
    const contentHashes = corpus.flatMap((record) =>
      typeof record.contentHash === 'string' ? [record.contentHash] : []
    )
    expect(contentHashes).toContain(createHash('sha256').update(pdf).digest('hex'))
  })

  test('requires a content hash for an included corpus record', async () => {
    const registry = await createSchemaRegistry()
    const result = registry.validate('corpus', {
      schemaVersion: 1,
      caseId: 'F001',
      contentHash: null,
      mediaType: 'application/pdf',
      sizeBytes: 1,
      status: 'included',
      attachmentOrdinal: 0,
    })
    expect(result.valid).toBe(false)
  })
})
