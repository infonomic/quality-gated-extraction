import type { PdfInspectionThresholds, PdfPageInspection, PdfRoutingSignals } from './types.js'

interface PageEvidence {
  text: string
  imageAreaRatio: number | null
  warnings?: string[]
}

interface CharacterCounts {
  textChars: number
  anomalousChars: number
  letterChars: number
  thaiChars: number
  latinChars: number
}

const allowedControlCharacters = new Set(['\t', '\n', '\r'])

function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  )
}

export function countCharacters(text: string): CharacterCounts {
  const normalised = text.normalize('NFC')
  let textChars = 0
  let anomalousChars = 0
  let letterChars = 0
  let thaiChars = 0
  let latinChars = 0

  for (const character of normalised) {
    if (!/\s/u.test(character)) textChars += 1
    const codePoint = character.codePointAt(0) ?? 0
    if (
      character === '\uFFFD' ||
      character === '\0' ||
      (/\p{Cc}/u.test(character) && !allowedControlCharacters.has(character)) ||
      isPrivateUse(codePoint)
    ) {
      anomalousChars += 1
    }
    if (/\p{L}/u.test(character)) {
      letterChars += 1
      if (/\p{Script=Thai}/u.test(character)) thaiChars += 1
      if (/\p{Script=Latin}/u.test(character)) latinChars += 1
    }
  }

  return { textChars, anomalousChars, letterChars, thaiChars, latinChars }
}

export function calculateSignals(
  pageEvidence: PageEvidence[],
  thresholds: PdfInspectionThresholds
): { pages: PdfPageInspection[]; signals: PdfRoutingSignals } {
  if (pageEvidence.length === 0) throw new Error('PDF inspection requires at least one page')

  let anomalousChars = 0
  let letterChars = 0
  const pages = pageEvidence.map((evidence, index) => {
    const counts = countCharacters(evidence.text)
    anomalousChars += counts.anomalousChars
    letterChars += counts.letterChars
    return {
      page: index + 1,
      textChars: counts.textChars,
      imageAreaRatio: evidence.imageAreaRatio,
      encodingAnomalyCount: counts.anomalousChars,
      thaiChars: counts.thaiChars,
      latinChars: counts.latinChars,
      warnings: evidence.warnings ?? [],
    }
  })
  const totalTextChars = pages.reduce((sum, page) => sum + page.textChars, 0)
  const charsPerPage = totalTextChars / pages.length
  const variance =
    pages.reduce((sum, page) => sum + (page.textChars - charsPerPage) ** 2, 0) / pages.length
  const imageSignalsAvailable = pages.every((page) => page.imageAreaRatio != null)
  const imageAreaRatios = pages.flatMap((page) =>
    page.imageAreaRatio == null ? [] : [page.imageAreaRatio]
  )
  const thaiChars = pages.reduce((sum, page) => sum + page.thaiChars, 0)
  const latinChars = pages.reduce((sum, page) => sum + page.latinChars, 0)
  const thaiCharRatio = letterChars === 0 ? 0 : thaiChars / letterChars
  const latinCharRatio = letterChars === 0 ? 0 : latinChars / letterChars

  return {
    pages,
    signals: {
      totalTextChars,
      charsPerPage,
      textLayerCoverage:
        pages.filter((page) => page.textChars >= thresholds.minimumTextCharsPerPage).length /
        pages.length,
      charsPerPageCv: charsPerPage === 0 ? 0 : Math.sqrt(variance) / charsPerPage,
      meanImageAreaRatio: imageSignalsAvailable
        ? imageAreaRatios.reduce((sum, ratio) => sum + ratio, 0) / pages.length
        : null,
      fullPageImageRatio: imageSignalsAvailable
        ? imageAreaRatios.filter((ratio) => ratio >= thresholds.fullPageImageAreaRatio).length /
          pages.length
        : null,
      encodingAnomalyRatio: anomalousChars / Math.max(1, totalTextChars),
      thaiCharRatio,
      latinCharRatio,
      mixedScript:
        thaiCharRatio >= thresholds.mixedScriptMinimumRatio &&
        latinCharRatio >= thresholds.mixedScriptMinimumRatio,
    },
  }
}
