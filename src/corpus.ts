import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import pg, { type QueryResultRow } from 'pg'

import { inspectPdf } from './pdf-signals/inspect-pdf.js'
import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type { PdfInspectionThresholds } from './pdf-signals/types.js'

const { Pool } = pg
const sha256Pattern = /^[a-f0-9]{64}$/u

export const CURRENT_PUBLICATION_DOCUMENTS_SQL = `
  WITH ranked AS (
    SELECT
      version.document_id,
      version.id AS document_version_id,
      row_number() OVER (
        PARTITION BY version.document_id
        ORDER BY version.id DESC
      ) AS rank
    FROM byline_document_versions AS version
    INNER JOIN byline_collections AS collection
      ON collection.id = version.collection_id
    WHERE collection.path = $1
      AND version.is_deleted = false
  )
  SELECT document_id, document_version_id
  FROM ranked
  WHERE rank = 1
  ORDER BY document_id, document_version_id
`

export const CURRENT_PUBLICATION_FILES_SQL = `
  WITH ranked AS (
    SELECT
      version.document_id,
      version.id AS document_version_id,
      row_number() OVER (
        PARTITION BY version.document_id
        ORDER BY version.id DESC
      ) AS rank
    FROM byline_document_versions AS version
    INNER JOIN byline_collections AS collection
      ON collection.id = version.collection_id
    WHERE collection.path = $1
      AND version.is_deleted = false
  )
  SELECT
    ranked.document_id,
    ranked.document_version_id,
    file.field_path,
    file.file_id,
    file.filename,
    file.original_filename,
    file.mime_type,
    file.file_size,
    file.file_hash,
    file.storage_provider,
    file.storage_path,
    file.storage_url
  FROM ranked
  INNER JOIN byline_store_file AS file
    ON file.document_version_id = ranked.document_version_id
  WHERE ranked.rank = 1
    AND file.field_name = 'publicationFile'
  ORDER BY ranked.document_id, file.field_path, file.locale
`

export interface CurrentPublicationDocument {
  documentId: string
  documentVersionId: string
}

export interface CurrentPublicationFile {
  documentId: string
  documentVersionId: string
  fieldPath: string
  fileId: string
  filename: string
  originalFilename: string
  mimeType: string
  fileSize: number
  fileHash: string | null
  storageProvider: string
  storagePath: string
  storageUrl: string | null
}

export interface ReadOnlyQueryEvidence {
  transactionReadOnly: true
  statements: string[]
}

export interface CurrentPublicationRead {
  documents: CurrentPublicationDocument[]
  files: CurrentPublicationFile[]
  evidence: ReadOnlyQueryEvidence
}

interface CurrentPublicationRow {
  document_id: string
  document_version_id: string
}

interface CurrentPublicationFileRow extends CurrentPublicationRow {
  field_path: string
  file_id: string
  filename: string
  original_filename: string
  mime_type: string
  file_size: number | string
  file_hash: string | null
  storage_provider: string
  storage_path: string
  storage_url: string | null
}

export interface PrivateCorpusSource {
  documentId: string
  documentVersionId: string
  attachmentOrdinal: number
  fieldPath: string
  storedFile: CorpusStoredFile
}

export interface CorpusStoredFile {
  id?: string
  filename: string
  originalFilename: string
  mimeType: string
  fileSize: number
  fileHash?: string
  storageProvider: string
  storagePath: string
  storageUrl?: string
}

interface MappedCorpusSource extends PrivateCorpusSource {
  caseId: string
  sourceKey: string
}

export interface CorpusRunSummary {
  schemaVersion: 1
  runId: string
  collection: 'publications'
  observedAt: string
  counts: {
    documents: number
    attachments: number
    includedPdfs: number
    excludedNonPdfs: number
    unreadablePdfs: number
    inspectedPdfs: number
    inspectedPages: number
  }
  expectedMigrationRecord: {
    pdfs: 341
    nonPdfs: 3
    observedPdfDifference: number
    explanation: string
  }
  readOnlyEvidence: {
    database: ReadOnlyQueryEvidence
    storageMethods: ['GET', 'LOCAL_READ']
    sqlMutations: 0
    storageWrites: 0
    storageDeletes: 0
  }
  outputHashes: {
    corpusJsonl: string
    inspectionJsonl: string
  }
}

interface CorpusRecord {
  schemaVersion: 1
  caseId: string
  contentHash: string | null
  mediaType: string
  sizeBytes: number
  status: 'included' | 'excluded' | 'unreadable'
  exclusionReason?: string
  attachmentOrdinal: number
}

function statementKind(statement: string): string {
  return statement.trimStart().split(/\s+/u, 1)[0]?.toUpperCase() ?? ''
}

/**
 * Read current publication documents inside a database-enforced read-only
 * transaction. This deliberately bypasses server bootstrap because bootstrap
 * applies migrations and is therefore unsuitable for evidence gathering.
 */
export async function readCurrentPublicationDocuments(
  connectionString: string
): Promise<CurrentPublicationRead> {
  if (!connectionString) throw new Error('BYLINE_DB_POSTGRES_CONNECTION_STRING is required')
  const pool = new Pool({ connectionString, max: 1 })
  const client = await pool.connect()
  const statements: string[] = []
  const query = async <Row extends QueryResultRow>(text: string, values?: unknown[]) => {
    const kind = statementKind(text)
    if (!['BEGIN', 'SET', 'SHOW', 'SELECT', 'WITH', 'ROLLBACK'].includes(kind)) {
      throw new Error(`Benchmark database guard rejected ${kind || 'unknown'} statement`)
    }
    statements.push(kind)
    return client.query<Row>(text, values)
  }

  try {
    await query('BEGIN TRANSACTION READ ONLY')
    await query("SET LOCAL statement_timeout = '60s'")
    const readOnly = await query<{ transaction_read_only: string }>('SHOW transaction_read_only')
    if (readOnly.rows[0]?.transaction_read_only !== 'on') {
      throw new Error('Postgres did not confirm a read-only transaction')
    }
    const documents = await query<CurrentPublicationRow>(CURRENT_PUBLICATION_DOCUMENTS_SQL, [
      'publications',
    ])
    const files = await query<CurrentPublicationFileRow>(CURRENT_PUBLICATION_FILES_SQL, [
      'publications',
    ])
    await query('ROLLBACK')
    return {
      documents: documents.rows.map((row) => ({
        documentId: row.document_id,
        documentVersionId: row.document_version_id,
      })),
      files: files.rows.map((row) => ({
        documentId: row.document_id,
        documentVersionId: row.document_version_id,
        fieldPath: row.field_path,
        fileId: row.file_id,
        filename: row.filename,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        fileSize: Number(row.file_size),
        fileHash: row.file_hash,
        storageProvider: row.storage_provider,
        storagePath: row.storage_path,
        storageUrl: row.storage_url,
      })),
      evidence: { transactionReadOnly: true, statements },
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export function privateSourceKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

export function assignPrivateCaseIds(sources: PrivateCorpusSource[]): MappedCorpusSource[] {
  return sources
    .map((source) => ({
      ...source,
      sourceKey: privateSourceKey([
        source.documentId,
        source.documentVersionId,
        String(source.attachmentOrdinal),
        source.fieldPath,
        source.storedFile.storagePath,
      ]),
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
    .map((source, index) => ({ ...source, caseId: `F${String(index + 1).padStart(3, '0')}` }))
}

export async function readStoredFileBytes(
  storedFile: CorpusStoredFile,
  uploadsDirectory: string,
  fetchImplementation: typeof fetch = fetch
): Promise<Buffer> {
  const url = storedFile.storageUrl
  if (url && /^https?:\/\//iu.test(url)) {
    const response = await fetchImplementation(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`STORAGE_HTTP_${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  const uploadsRoot = path.resolve(uploadsDirectory)
  const sourcePath = path.resolve(uploadsRoot, storedFile.storagePath)
  if (sourcePath !== uploadsRoot && !sourcePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error('STORAGE_PATH_OUTSIDE_UPLOADS')
  }
  return readFile(sourcePath)
}

async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.tmp`
  await writeFile(temporaryPath, contents)
  await rename(temporaryPath, filePath)
}

function jsonLines(values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

function hashText(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function safeStoredHash(storedFile: CorpusStoredFile): string | null {
  const value = storedFile.fileHash?.toLowerCase()
  return value && sha256Pattern.test(value) ? value : null
}

async function readOrCacheSource(
  source: MappedCorpusSource,
  sourceDirectory: string,
  uploadsDirectory: string
): Promise<Buffer> {
  const cachedPath = path.join(sourceDirectory, `${source.caseId}.bin`)
  const expectedHash = safeStoredHash(source.storedFile)
  const cached = await readFile(cachedPath).catch(() => null)
  if (cached != null) {
    const cachedHash = createHash('sha256').update(cached).digest('hex')
    if (expectedHash == null || cachedHash === expectedHash) return cached
  }
  const bytes = await readStoredFileBytes(source.storedFile, uploadsDirectory)
  await atomicWrite(cachedPath, bytes)
  return bytes
}

function validateOrThrow(
  name: 'corpus' | 'inspection',
  value: unknown,
  validate: Awaited<ReturnType<typeof createSchemaRegistry>>['validate']
): void {
  const result = validate(name, value)
  if (!result.valid) throw new Error(`${name} schema: ${formatValidationErrors(result.errors)}`)
}

export async function inspectCorpus(options: {
  runId: string
  outputDirectory: string
  uploadsDirectory: string
  documents: CurrentPublicationDocument[]
  sources: PrivateCorpusSource[]
  databaseEvidence: ReadOnlyQueryEvidence
  thresholds: PdfInspectionThresholds
  observedAt?: string
  progress?: (completed: number, total: number, caseId: string) => void
}): Promise<CorpusRunSummary> {
  const mapped = assignPrivateCaseIds(options.sources)
  const sourceDirectory = path.join(options.outputDirectory, 'source')
  await mkdir(sourceDirectory, { recursive: true })
  const registry = await createSchemaRegistry()
  const corpus: CorpusRecord[] = []
  const inspections: Array<Record<string, unknown>> = []

  for (let index = 0; index < mapped.length; index += 1) {
    const source = mapped[index] as MappedCorpusSource
    const mediaType = source.storedFile.mimeType.toLowerCase()
    if (mediaType !== 'application/pdf') {
      corpus.push({
        schemaVersion: 1,
        caseId: source.caseId,
        contentHash: safeStoredHash(source.storedFile),
        mediaType,
        sizeBytes: source.storedFile.fileSize,
        status: 'excluded',
        exclusionReason: 'NON_PDF_MEDIA_TYPE',
        attachmentOrdinal: source.attachmentOrdinal,
      })
      options.progress?.(index + 1, mapped.length, source.caseId)
      continue
    }

    try {
      const bytes = await readOrCacheSource(source, sourceDirectory, options.uploadsDirectory)
      const inspection = await inspectPdf(bytes, options.thresholds)
      corpus.push({
        schemaVersion: 1,
        caseId: source.caseId,
        contentHash: inspection.contentHash,
        mediaType,
        sizeBytes: bytes.byteLength,
        status: 'included',
        attachmentOrdinal: source.attachmentOrdinal,
      })
      inspections.push({ ...inspection, caseId: source.caseId })
    } catch (error) {
      const cached = await readFile(path.join(sourceDirectory, `${source.caseId}.bin`)).catch(
        () => null
      )
      corpus.push({
        schemaVersion: 1,
        caseId: source.caseId,
        contentHash:
          cached == null
            ? safeStoredHash(source.storedFile)
            : createHash('sha256').update(cached).digest('hex'),
        mediaType,
        sizeBytes: cached?.byteLength ?? source.storedFile.fileSize,
        status: 'unreadable',
        exclusionReason:
          error != null && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'UNKNOWN_READ_ERROR',
        attachmentOrdinal: source.attachmentOrdinal,
      })
    }
    options.progress?.(index + 1, mapped.length, source.caseId)
  }

  for (const record of corpus) validateOrThrow('corpus', record, registry.validate)
  for (const inspection of inspections) {
    validateOrThrow('inspection', inspection, registry.validate)
  }

  const corpusContents = jsonLines(corpus)
  const inspectionContents = jsonLines(inspections)
  await atomicWrite(path.join(options.outputDirectory, 'corpus.jsonl'), corpusContents)
  await atomicWrite(path.join(options.outputDirectory, 'inspection.jsonl'), inspectionContents)
  await atomicWrite(
    path.join(options.outputDirectory, 'source-map.jsonl'),
    jsonLines(
      mapped.map((source) => ({
        caseId: source.caseId,
        sourceKey: source.sourceKey,
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        fieldPath: source.fieldPath,
        storagePath: source.storedFile.storagePath,
        storageUrl: source.storedFile.storageUrl ?? null,
        filename: source.storedFile.filename,
        originalFilename: source.storedFile.originalFilename,
      }))
    )
  )

  const includedPdfs = corpus.filter((record) => record.status === 'included').length
  const excludedNonPdfs = corpus.filter((record) => record.status === 'excluded').length
  const unreadablePdfs = corpus.filter((record) => record.status === 'unreadable').length
  const inspectedPages = inspections.reduce(
    (sum, inspection) => sum + Number(inspection.pageCount ?? 0),
    0
  )
  const observedPdfDifference = includedPdfs + unreadablePdfs - 341
  const summary: CorpusRunSummary = {
    schemaVersion: 1,
    runId: options.runId,
    collection: 'publications',
    observedAt: options.observedAt ?? new Date().toISOString(),
    counts: {
      documents: options.documents.length,
      attachments: corpus.length,
      includedPdfs,
      excludedNonPdfs,
      unreadablePdfs,
      inspectedPdfs: inspections.length,
      inspectedPages,
    },
    expectedMigrationRecord: {
      pdfs: 341,
      nonPdfs: 3,
      observedPdfDifference,
      explanation:
        observedPdfDifference === 0 && excludedNonPdfs === 3
          ? 'Observed current attachments reproduce the migration record: 341 PDFs and 3 non-PDFs.'
          : 'Observed current attachments differ from the migration record; counts are reported without adjustment.',
    },
    readOnlyEvidence: {
      database: options.databaseEvidence,
      storageMethods: ['GET', 'LOCAL_READ'],
      sqlMutations: 0,
      storageWrites: 0,
      storageDeletes: 0,
    },
    outputHashes: {
      corpusJsonl: hashText(corpusContents),
      inspectionJsonl: hashText(inspectionContents),
    },
  }
  await atomicWrite(
    path.join(options.outputDirectory, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  )
  return summary
}
