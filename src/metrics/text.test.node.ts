import { characterErrorRate, editDistance, wordErrorRate } from './text.js'

describe('text metrics', () => {
  test('hand-checks perfect, insertion, deletion and substitution distances', () => {
    expect(editDistance([...`abc`], [...`abc`])).toBe(0)
    expect(editDistance([...`abc`], [...`abxc`])).toBe(1)
    expect(editDistance([...`abc`], [...`ac`])).toBe(1)
    expect(editDistance([...`abc`], [...`axc`])).toBe(1)
  })

  test('reports exact CER numerator, denominator and exclusions', () => {
    expect(characterErrorRate('abc', 'axc')).toEqual({
      numerator: 1,
      denominator: 3,
      excludedCount: 0,
      value: 1 / 3,
    })
    expect(characterErrorRate('', '')).toEqual({
      numerator: 0,
      denominator: 0,
      excludedCount: 0,
      value: 0,
    })
    expect(characterErrorRate('', 'x')).toEqual({
      numerator: 1,
      denominator: 0,
      excludedCount: 1,
      value: null,
    })
  })

  test('locks the observed Thai spacing and glyph-substitution behavior', () => {
    const control = 'การฟื้นฟูป่า ประเทศไทย'
    const t2 = 'ก า ร ฟื้น ฟู ป ่ า ป ร ะ เท ศ ไ ท ย'
    const t3 = 'การพื้นพูป่า ประเทศไทย'
    expect(characterErrorRate(control, t2).numerator).toBe(0)
    expect(wordErrorRate(control, t2, 'thai').numerator).toBe(0)
    expect(characterErrorRate(control, t3).numerator).toBeGreaterThan(0)
    expect(wordErrorRate(control, t3, 'thai').numerator).toBeGreaterThan(0)
  })
})
