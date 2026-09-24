import {
  normaliseForCer,
  normaliseForWer,
  stripComparisonMarkup,
  tokeniseForWer,
} from './text-normalisation.js'

const thaiControl = 'การฟื้นฟูป่า ประเทศไทย'
const t2Observed = 'ก า ร ฟื้น ฟู ป ่ า ป ร ะ เท ศ ไ ท ย'
const t3Observed = 'การพื้นพูป่า ประเทศไทย'

describe('precommitted text normalisation', () => {
  test('treats the observed T2 Thai spacing artefact as cosmetic for CER', () => {
    expect(normaliseForCer(t2Observed)).toBe(normaliseForCer(thaiControl))
  })

  test('preserves the observed T3 Thai character substitutions for CER', () => {
    expect(normaliseForCer(t3Observed)).not.toBe(normaliseForCer(thaiControl))
  })

  test('removes artificial Thai spacing before deterministic word segmentation', () => {
    expect(normaliseForWer(t2Observed, 'thai')).toBe(normaliseForWer(thaiControl, 'thai'))
    expect(tokeniseForWer(t2Observed, 'thai')).toEqual(tokeniseForWer(thaiControl, 'thai'))
    expect(tokeniseForWer(t3Observed, 'thai')).not.toEqual(tokeniseForWer(thaiControl, 'thai'))
  })

  test('collapses English whitespace, excludes punctuation and preserves case', () => {
    expect(tokeniseForWer('Forest,\n  restoration!', 'english')).toEqual(['Forest', 'restoration'])
    expect(tokeniseForWer('Forest', 'english')).not.toEqual(tokeniseForWer('forest', 'english'))
  })

  test('strips HTML presentation tags while retaining table-cell boundaries', () => {
    const clean = 'Treatments Control'
    const html =
      "<table border=1><tr><td style='text-align: center;'>Treatments</td><td>Control</td></tr></table>"
    expect(normaliseForCer(html)).toBe(normaliseForCer(clean))
    expect(tokeniseForWer(html, 'english')).toEqual(['Treatments', 'Control'])
  })

  test('unwraps paired inline and display math delimiters symmetrically', () => {
    const clean = 'coefficient estimate \\pm SE = -1.91 \\pm 0.68, \\xi = -2.80'
    const marked = 'coefficient estimate $ \\pm $ SE = $ -1.91 \\pm 0.68 $, $ \\xi = -2.80 $'
    expect(normaliseForCer(marked)).toBe(normaliseForCer(clean))
    expect(stripComparisonMarkup('cost $5 and $$x$$')).toBe('cost $5 and x')
  })

  test('handles greater-than signs inside tag attributes and preserves comparison text', () => {
    expect(stripComparisonMarkup('<div data-note="x > y">Caption</div>')).toBe(' Caption ')
    expect(stripComparisonMarkup('growth < decline')).toBe('growth < decline')
  })
})
