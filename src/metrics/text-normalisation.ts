export type EvaluationScript = 'english' | 'thai' | 'mixed'

const unicodeWhitespace = /\p{White_Space}+/gu
const pairedDisplayMathDelimiters = /\$\$([\s\S]*?)\$\$/gu
const pairedInlineMathDelimiters = /\$(?!\d)([\s\S]*?)\$/gu

function nfc(value: string): string {
  return value.normalize('NFC')
}

/**
 * Remove provider presentation markup symmetrically from references and
 * hypotheses. Tag boundaries become spaces so WER cannot concatenate adjacent
 * table cells; CER removes those spaces in its later whitespace stage.
 */
export function stripComparisonMarkup(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    const next = value[index + 1] ?? ''
    if (character !== '<' || !/[A-Za-z/!?]/u.test(next)) {
      output += character
      continue
    }

    let quote: '"' | "'" | null = null
    let end = -1
    for (let candidate = index + 1; candidate < value.length; candidate += 1) {
      const candidateCharacter = value[candidate] ?? ''
      if (quote) {
        if (candidateCharacter === quote) quote = null
      } else if (candidateCharacter === '"' || candidateCharacter === "'") {
        quote = candidateCharacter
      } else if (candidateCharacter === '>') {
        end = candidate
        break
      }
    }
    if (end >= 0) {
      output += ' '
      index = end
    } else {
      // A lone `<` that never closes is content, not a valid tag.
      output += character
    }
  }
  return output.replace(pairedDisplayMathDelimiters, '$1').replace(pairedInlineMathDelimiters, '$1')
}

export function normaliseForCer(value: string): string {
  return nfc(stripComparisonMarkup(value)).replace(unicodeWhitespace, '').normalize('NFC')
}

export function normaliseForWer(value: string, script: EvaluationScript): string {
  const normalised = nfc(stripComparisonMarkup(value))
  if (script === 'thai') return nfc(normalised.replace(unicodeWhitespace, ''))
  return normalised.replace(unicodeWhitespace, ' ').trim()
}

export function tokeniseForWer(value: string, script: EvaluationScript): string[] {
  const locale = script === 'english' ? 'en' : 'th'
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  return [...segmenter.segment(normaliseForWer(value, script))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment)
}
