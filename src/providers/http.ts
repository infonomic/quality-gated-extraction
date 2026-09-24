import { ProviderHttpError } from './types.js'

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>

export async function fetchOrThrow(
  provider: string,
  fetchImpl: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const response = await fetchImpl(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  })
  if (response.ok) return response

  const body = await response.text().catch(() => '')
  throw new ProviderHttpError(provider, response.status, response.statusText, body.slice(0, 500))
}

export function versionFromOpenApi(value: unknown, provider: string): string {
  if (!value || typeof value !== 'object')
    throw new Error(`${provider} OpenAPI response is not an object`)
  const info = (value as { info?: unknown }).info
  if (!info || typeof info !== 'object') throw new Error(`${provider} OpenAPI response has no info`)
  const version = (info as { version?: unknown }).version
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`${provider} OpenAPI response has no version`)
  }
  return version.trim()
}
