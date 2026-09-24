import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  createSyntheticBornDigitalPdf,
  createSyntheticScannedPdf,
} from '../fixtures/synthetic-pdf.js'
import { inspectPdf } from './inspect-pdf.js'
import { calculateSignals, countCharacters } from './signals.js'
import { PdfInspectionError } from './types.js'
import type { PdfInspectionThresholds } from './types.js'

const thresholds: PdfInspectionThresholds = {
  minimumTextCharsPerPage: 32,
  fullPageImageAreaRatio: 0.8,
  mixedScriptMinimumRatio: 0.1,
}

describe('PDF routing signal formulae', () => {
  test('applies the declared text and full-page-image boundaries inclusively', () => {
    const result = calculateSignals(
      [
        { text: 'a'.repeat(31), imageAreaRatio: 0.79 },
        { text: 'b'.repeat(32), imageAreaRatio: 0.8 },
      ],
      thresholds
    )

    expect(result.signals.textLayerCoverage).toBe(0.5)
    expect(result.signals.fullPageImageRatio).toBe(0.5)
    expect(result.signals.meanImageAreaRatio).toBeCloseTo(0.795)
  })

  test('detects the mixed-script threshold and encoding anomalies', () => {
    const text = `กabcdefghi\uFFFD\0\uE000`
    const result = calculateSignals([{ text, imageAreaRatio: 0 }], thresholds)
    const counts = countCharacters(text)

    expect(counts).toMatchObject({ thaiChars: 1, latinChars: 9, anomalousChars: 3 })
    expect(result.signals.thaiCharRatio).toBe(0.1)
    expect(result.signals.latinCharRatio).toBe(0.9)
    expect(result.signals.mixedScript).toBe(true)
    expect(result.signals.encodingAnomalyRatio).toBe(3 / 13)
    expect(result.pages[0]?.encodingAnomalyCount).toBe(3)
  })

  test('uses zero CV for empty text and null aggregate image signals when unavailable', () => {
    const result = calculateSignals(
      [
        { text: '', imageAreaRatio: 0 },
        { text: '', imageAreaRatio: null, warnings: ['IMAGE_SIGNALS_UNAVAILABLE'] },
      ],
      thresholds
    )

    expect(result.signals).toMatchObject({
      totalTextChars: 0,
      charsPerPage: 0,
      charsPerPageCv: 0,
      meanImageAreaRatio: null,
      fullPageImageRatio: null,
      encodingAnomalyRatio: 0,
      mixedScript: false,
    })
  })
})

describe('provider-independent PDF inspection', () => {
  test('extracts deterministic text and full-page-image evidence locally', async () => {
    const bornBytes = createSyntheticBornDigitalPdf()
    const scanBytes = createSyntheticScannedPdf()
    const [born, bornRepeat, scanned] = await Promise.all([
      inspectPdf(bornBytes, thresholds),
      inspectPdf(bornBytes, thresholds),
      inspectPdf(scanBytes, thresholds),
    ])

    expect(born).toEqual(bornRepeat)
    expect(born.pageCount).toBe(1)
    expect(born.signals.textLayerCoverage).toBe(1)
    expect(born.pages[0]?.imageAreaRatio).toBe(0)
    expect(born.pages[0]?.encodingAnomalyCount).toBe(0)
    expect(scanned.signals.totalTextChars).toBe(0)
    expect(scanned.pages[0]?.imageAreaRatio).toBe(1)
    expect(scanned.signals.fullPageImageRatio).toBe(1)
    expect(born.contentHash).not.toBe(scanned.contentHash)
  })

  test('returns a typed error for malformed input', async () => {
    const inspection = inspectPdf(Buffer.from('not a PDF'), thresholds)
    await expect(inspection).rejects.toBeInstanceOf(PdfInspectionError)
    await expect(inspection).rejects.toMatchObject({ code: 'PDF_MALFORMED' })
  })

  test('has no extraction-provider dependency', async () => {
    const source = await readFile(resolve('src/pdf-signals/inspect-pdf.ts'), 'utf8')
    expect(source).not.toMatch(/providers|docling|paddle|tika/iu)
  })
})
