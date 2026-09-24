import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ArtifactCache,
  ArtifactCacheConflictError,
  ArtifactCacheCorruptionError,
  artifactCacheKey,
  type CachedArtifact,
} from './artifact-cache.js'

const descriptor = {
  contentHash: 'a'.repeat(64),
  provider: { id: 'synthetic', version: '1.0.0', model: 'model-a', execution: 'local' as const },
  parameters: { alpha: 1, enabled: true },
  representationSchemaVersion: 1 as const,
}

function artifact(caseId: string, cacheKey = artifactCacheKey(descriptor)): CachedArtifact {
  return {
    schemaVersion: 1,
    caseId,
    cacheKey,
    tier: 'T3',
    provider: descriptor.provider,
    parameters: descriptor.parameters,
    representations: { text: 'synthetic text' },
    timings: { wallMs: 10, providerMs: null, providerTimingStatus: 'unavailable' },
    warnings: [],
  }
}

describe('immutable artifact cache', () => {
  test('changes key for parameter, model, provider version, content or schema changes', () => {
    const original = artifactCacheKey(descriptor)
    const mutations = [
      { ...descriptor, contentHash: 'b'.repeat(64) },
      { ...descriptor, provider: { ...descriptor.provider, version: '2.0.0' } },
      { ...descriptor, provider: { ...descriptor.provider, model: 'model-b' } },
      { ...descriptor, parameters: { ...descriptor.parameters, alpha: 2 } },
      { ...descriptor, representationSchemaVersion: 2 as never },
    ]
    expect(mutations.every((mutation) => artifactCacheKey(mutation) !== original)).toBe(true)
  })

  test('shares a content-addressed hit across authorised aliases', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'forru-artifact-cache-'))
    const cache = new ArtifactCache(directory)
    const key = artifactCacheKey(descriptor)
    await cache.put(artifact('F001', key))

    const alias = await cache.get(key, 'F002')
    expect(alias?.caseId).toBe('F002')
    expect(alias?.cacheKey).toBe(key)
    expect(alias?.representations.text).toBe('synthetic text')
  })

  test('refuses to overwrite immutable bytes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'forru-artifact-cache-'))
    const cache = new ArtifactCache(directory)
    const first = artifact('F001')
    await cache.put(first)
    await expect(
      cache.put({ ...first, representations: { text: 'different text' } })
    ).rejects.toBeInstanceOf(ArtifactCacheConflictError)
  })

  test('fails closed while leaving corrupt bytes in place', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'forru-artifact-cache-'))
    const cache = new ArtifactCache(directory)
    const key = artifactCacheKey(descriptor)
    const destination = path.join(directory, key.slice(0, 2), `${key}.json`)
    await writeFile(destination, '{partial', { flag: 'wx' }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, '{partial', { flag: 'wx' })
    })

    await expect(cache.get(key, 'F001')).rejects.toBeInstanceOf(ArtifactCacheCorruptionError)
    expect(await readFile(destination, 'utf8')).toBe('{partial')
  })
})
