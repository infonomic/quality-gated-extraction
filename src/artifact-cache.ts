import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'
import type {
  BenchmarkProviderArtifact,
  ExtractionTier,
  ParameterValue,
  ProviderIdentity,
} from './providers/types.js'

export interface CachedArtifact extends BenchmarkProviderArtifact {
  schemaVersion: 1
  caseId: string
  cacheKey: string
  tier: ExtractionTier
}

export interface ArtifactCacheDescriptor {
  contentHash: string
  provider: ProviderIdentity
  parameters: Record<string, ParameterValue>
  representationSchemaVersion: 1
}

export class ArtifactCacheCorruptionError extends Error {
  constructor(
    readonly cacheKey: string,
    message: string
  ) {
    super(`Artifact cache ${cacheKey} is corrupt: ${message}`)
    this.name = 'ArtifactCacheCorruptionError'
  }
}

export class ArtifactCacheConflictError extends Error {
  constructor(readonly cacheKey: string) {
    super(`Artifact cache ${cacheKey} already contains different immutable bytes`)
    this.name = 'ArtifactCacheConflictError'
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

export function artifactCacheKey(descriptor: ArtifactCacheDescriptor): string {
  const parametersHash = sha256(canonicalJson(descriptor.parameters))
  return sha256(
    canonicalJson({
      contentHash: descriptor.contentHash,
      providerId: descriptor.provider.id,
      providerVersion: descriptor.provider.version,
      model: descriptor.provider.model ?? null,
      parametersHash,
      representationSchemaVersion: descriptor.representationSchemaVersion,
    })
  )
}

function artifactBytes(artifact: CachedArtifact): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(artifact)}\n`)
}

export class ArtifactCache {
  private readonly registry = createSchemaRegistry()

  constructor(private readonly rootDirectory: string) {}

  private artifactPath(cacheKey: string): string {
    return path.join(this.rootDirectory, cacheKey.slice(0, 2), `${cacheKey}.json`)
  }

  async get(cacheKey: string, caseId: string): Promise<CachedArtifact | null> {
    const destination = this.artifactPath(cacheKey)
    let bytes: Uint8Array
    try {
      bytes = await readFile(destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }

    let cached: CachedArtifact
    try {
      cached = JSON.parse(new TextDecoder().decode(bytes)) as CachedArtifact
    } catch (error) {
      throw new ArtifactCacheCorruptionError(
        cacheKey,
        error instanceof Error ? error.message : 'invalid JSON'
      )
    }
    if (cached.cacheKey !== cacheKey) {
      throw new ArtifactCacheCorruptionError(cacheKey, 'embedded cache key does not match path')
    }
    const rebound = { ...cached, caseId }
    await this.validate(rebound)
    return rebound
  }

  async put(artifact: CachedArtifact): Promise<void> {
    await this.validate(artifact)
    const destination = this.artifactPath(artifact.cacheKey)
    const directory = path.dirname(destination)
    await mkdir(directory, { recursive: true })
    const bytes = artifactBytes(artifact)
    const temporary = path.join(
      directory,
      `.${artifact.cacheKey}.${process.pid}.${randomUUID()}.tmp`
    )
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await link(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(destination)
      if (!existing.equals(bytes)) throw new ArtifactCacheConflictError(artifact.cacheKey)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private async validate(artifact: CachedArtifact): Promise<void> {
    const validation = (await this.registry).validate('artifact', artifact)
    if (!validation.valid) {
      throw new ArtifactCacheCorruptionError(
        artifact.cacheKey,
        formatValidationErrors(validation.errors)
      )
    }
  }
}
