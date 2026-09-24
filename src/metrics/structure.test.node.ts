import { structureMetrics, textSimilarity } from './structure.js'

describe('structural metrics', () => {
  test('uses the predeclared 0.90 same-type match', () => {
    expect(textSimilarity('abcdefghij', 'abcdefghiX')).toBe(0.9)
    const result = structureMetrics(
      [
        { type: 'heading', text: 'abcdefghij' },
        { type: 'body', text: 'body' },
      ],
      [
        { type: 'heading', text: 'abcdefghiX' },
        { type: 'caption', text: 'body' },
        { type: 'body', text: 'extra' },
      ]
    )
    expect(result.counts).toEqual({ truePositives: 1, falsePositives: 2, falseNegatives: 1 })
    expect(result.precision).toMatchObject({ numerator: 1, denominator: 3, excludedCount: 0 })
    expect(result.recall).toMatchObject({ numerator: 1, denominator: 2, excludedCount: 0 })
    expect(result.f1).toMatchObject({ numerator: 2, denominator: 5, excludedCount: 0 })
  })

  test('finds a maximum one-to-one match when candidate texts overlap', () => {
    const result = structureMetrics(
      [
        { type: 'body', text: 'same' },
        { type: 'body', text: 'same' },
      ],
      [
        { type: 'body', text: 'same' },
        { type: 'body', text: 'same' },
      ]
    )
    expect(result.counts.truePositives).toBe(2)
  })

  test('reports sampled recall but withholds precision and F1 for a partial reference', () => {
    const result = structureMetrics(
      [{ type: 'table-cell', text: 'sampled cell' }],
      [
        { type: 'table-cell', text: 'sampled cell' },
        { type: 'table-cell', text: 'outside sampled rows' },
      ],
      0.9,
      'partial-reference'
    )
    expect(result.counts).toEqual({
      truePositives: 1,
      falsePositives: null,
      falseNegatives: 0,
    })
    expect(result.recall.value).toBe(1)
    expect(result.precision).toMatchObject({ denominator: 0, excludedCount: 2, value: null })
    expect(result.f1.value).toBeNull()
  })

  test('does not penalise provider HTML around an otherwise matching caption', () => {
    const result = structureMetrics(
      [{ type: 'caption', text: 'Figure 4.1 Forest restoration' }],
      [
        {
          type: 'caption',
          text: '<div style="text-align: center;">Figure 4.1 Forest restoration</div>',
        },
      ]
    )
    expect(result.counts.truePositives).toBe(1)
    expect(result.recall.value).toBe(1)
  })
})
