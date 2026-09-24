import { type EvaluationScript, tokeniseForWer } from './text-normalisation.js'
import { ratio } from './types.js'
import type { BoundaryOpportunity } from '../validate-annotations.js'

export const chunkingContract = {
  schemaVersion: 1,
  structureAware: 'annotation-elements-with-explicit-break-or-join-boundaries',
  fixedToken: 'unicode-word-segments-in-reading-order-with-a-fixed-token-cap',
} as const

export interface ChunkMembership {
  firstChunk: string
  lastChunk: string
}

export interface ChunkableElement {
  id: string
  text: string
  readingOrder: number
}

function membership(value: string | ChunkMembership): ChunkMembership {
  return typeof value === 'string' ? { firstChunk: value, lastChunk: value } : value
}

function assertTokenCap(maxTokens: number): void {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('maxTokens must be a positive integer')
  }
}

export function assignFixedTokenChunks(
  elements: ChunkableElement[],
  maxTokens: number,
  script: EvaluationScript
): Record<string, ChunkMembership> {
  assertTokenCap(maxTokens)
  let tokenCursor = 0
  const assignments: Record<string, ChunkMembership> = {}
  for (const element of elements.slice().sort((a, b) => a.readingOrder - b.readingOrder)) {
    const tokenCount = tokeniseForWer(element.text, script).length
    const first = Math.floor(tokenCursor / maxTokens)
    const last = Math.floor((tokenCursor + Math.max(tokenCount, 1) - 1) / maxTokens)
    assignments[element.id] = { firstChunk: `fixed-${first}`, lastChunk: `fixed-${last}` }
    tokenCursor += tokenCount
  }
  return assignments
}

export function assignStructureAwareChunks(
  elements: ChunkableElement[],
  opportunities: BoundaryOpportunity[],
  maxTokens: number,
  script: EvaluationScript
): Record<string, ChunkMembership> {
  assertTokenCap(maxTokens)
  const ordered = elements.slice().sort((a, b) => a.readingOrder - b.readingOrder)
  const actions = new Map(
    opportunities.map((item) => [
      `${item.beforeElementId}:${item.afterElementId}`,
      item.expectedAction,
    ])
  )
  const assignments: Record<string, ChunkMembership> = {}
  let chunk = 0
  let tokensInChunk = 0
  for (const [index, element] of ordered.entries()) {
    const tokens = tokeniseForWer(element.text, script).length
    const previous = ordered[index - 1]
    const expectedBreak =
      previous != null && actions.get(`${previous.id}:${element.id}`) === 'break'
    if (index > 0 && (expectedBreak || (tokensInChunk > 0 && tokensInChunk + tokens > maxTokens))) {
      chunk += 1
      tokensInChunk = 0
    }
    assignments[element.id] = {
      firstChunk: `structure-${chunk}`,
      lastChunk: `structure-${chunk}`,
    }
    tokensInChunk += tokens
  }
  return assignments
}

export function boundaryMetrics(
  opportunities: BoundaryOpportunity[],
  chunkByElementId: Readonly<Record<string, string | ChunkMembership>>
) {
  let splitViolations = 0
  let mergeViolations = 0
  let excludedJoins = 0
  let excludedBreaks = 0
  let joinOpportunities = 0
  let breakOpportunities = 0
  for (const opportunity of opportunities) {
    const before = chunkByElementId[opportunity.beforeElementId]
    const after = chunkByElementId[opportunity.afterElementId]
    if (before == null || after == null) {
      if (opportunity.expectedAction === 'join') excludedJoins += 1
      else excludedBreaks += 1
      continue
    }
    const beforeChunk = membership(before).lastChunk
    const afterChunk = membership(after).firstChunk
    if (opportunity.expectedAction === 'join') {
      joinOpportunities += 1
      if (beforeChunk !== afterChunk) splitViolations += 1
    } else {
      breakOpportunities += 1
      if (beforeChunk === afterChunk) mergeViolations += 1
    }
  }
  const excludedCount = excludedJoins + excludedBreaks
  const denominator = joinOpportunities + breakOpportunities
  return {
    splitViolations: ratio(splitViolations, joinOpportunities, excludedJoins),
    mergeViolations: ratio(mergeViolations, breakOpportunities, excludedBreaks),
    totalViolationsPer100: {
      ...ratio((splitViolations + mergeViolations) * 100, denominator, excludedCount),
      unit: 'violations-per-100-opportunities' as const,
    },
  }
}
