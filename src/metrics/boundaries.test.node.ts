import {
  assignFixedTokenChunks,
  assignStructureAwareChunks,
  boundaryMetrics,
  chunkingContract,
} from './boundaries.js'

describe('boundary metrics', () => {
  const opportunities = [
    {
      id: 'join',
      type: 'table-cell' as const,
      expectedAction: 'join' as const,
      beforeElementId: 'a',
      afterElementId: 'b',
    },
    {
      id: 'break',
      type: 'heading-body' as const,
      expectedAction: 'break' as const,
      beforeElementId: 'b',
      afterElementId: 'c',
    },
  ]

  test('hand-checks one split and one merge violation', () => {
    const result = boundaryMetrics(opportunities, { a: '1', b: '2', c: '2' })
    expect(result.splitViolations).toEqual({
      numerator: 1,
      denominator: 1,
      excludedCount: 0,
      value: 1,
    })
    expect(result.mergeViolations.numerator).toBe(1)
    expect(result.totalViolationsPer100.value).toBe(100)
  })

  test('counts an unavailable element assignment against its boundary type', () => {
    const result = boundaryMetrics(opportunities, { a: '1', b: '1' })
    expect(result.splitViolations).toMatchObject({ denominator: 1, excludedCount: 0 })
    expect(result.mergeViolations).toMatchObject({ denominator: 0, excludedCount: 1 })
  })

  test('pins and executes versioned structure-aware and fixed-token contracts', () => {
    expect(chunkingContract.schemaVersion).toBe(1)
    expect(chunkingContract.fixedToken).toContain('fixed-token-cap')
    const elements = [
      { id: 'a', text: 'one two', readingOrder: 0 },
      { id: 'b', text: 'three four', readingOrder: 1 },
      { id: 'c', text: 'five', readingOrder: 2 },
    ]
    expect(assignFixedTokenChunks(elements, 3, 'english')).toEqual({
      a: { firstChunk: 'fixed-0', lastChunk: 'fixed-0' },
      b: { firstChunk: 'fixed-0', lastChunk: 'fixed-1' },
      c: { firstChunk: 'fixed-1', lastChunk: 'fixed-1' },
    })
    expect(assignStructureAwareChunks(elements, opportunities, 10, 'english')).toEqual({
      a: { firstChunk: 'structure-0', lastChunk: 'structure-0' },
      b: { firstChunk: 'structure-0', lastChunk: 'structure-0' },
      c: { firstChunk: 'structure-1', lastChunk: 'structure-1' },
    })
  })
})
