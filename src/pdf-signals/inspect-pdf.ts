import { createHash } from 'node:crypto'

import {
  getDocument,
  OPS,
  PasswordResponses,
  VerbosityLevel,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

import { calculateSignals } from './signals.js'
import { PdfInspectionError } from './types.js'
import type { PdfInspection, PdfInspectionThresholds } from './types.js'

type Matrix = [number, number, number, number, number, number]

const identityMatrix: Matrix = [1, 0, 0, 1, 0, 0]

function isMatrix(value: unknown): value is Matrix {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  )
}

function numberArray(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value
  if (!ArrayBuffer.isView(value)) return null
  return Array.from(value as unknown as ArrayLike<number>)
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function unitSquareArea(matrix: Matrix, view: number[]): number {
  const points = [
    [matrix[4], matrix[5]],
    [matrix[0] + matrix[4], matrix[1] + matrix[5]],
    [matrix[2] + matrix[4], matrix[3] + matrix[5]],
    [matrix[0] + matrix[2] + matrix[4], matrix[1] + matrix[3] + matrix[5]],
  ]
  const x1 = Math.max(view[0] ?? 0, Math.min(...points.map(([x]) => x ?? 0)))
  const y1 = Math.max(view[1] ?? 0, Math.min(...points.map(([, y]) => y ?? 0)))
  const x2 = Math.min(view[2] ?? 0, Math.max(...points.map(([x]) => x ?? 0)))
  const y2 = Math.min(view[3] ?? 0, Math.max(...points.map(([, y]) => y ?? 0)))
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

function imageAreaRatio(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown[]>,
  view: number[]
): { ratio: number; warnings: string[] } {
  const pageArea =
    Math.max(0, (view[2] ?? 0) - (view[0] ?? 0)) * Math.max(0, (view[3] ?? 0) - (view[1] ?? 0))
  if (pageArea === 0) return { ratio: 0, warnings: ['INVALID_PAGE_GEOMETRY'] }

  const stack: Matrix[] = []
  let current: Matrix = [...identityMatrix]
  let paintedArea = 0
  const warnings = new Set<string>()
  const paint = (transform: Matrix = identityMatrix): void => {
    paintedArea += unitSquareArea(multiply(current, transform), view)
  }

  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index]
    const args = argsArray[index] ?? []
    if (operation === OPS.save) {
      stack.push([...current])
    } else if (operation === OPS.restore) {
      current = stack.pop() ?? [...identityMatrix]
    } else if (operation === OPS.transform) {
      if (isMatrix(args)) current = multiply(current, args)
      else warnings.add('INVALID_IMAGE_TRANSFORM')
    } else if (operation === OPS.paintFormXObjectBegin) {
      stack.push([...current])
      if (isMatrix(args[0])) current = multiply(current, args[0])
    } else if (operation === OPS.paintFormXObjectEnd) {
      current = stack.pop() ?? [...identityMatrix]
    } else if (
      operation === OPS.paintImageXObject ||
      operation === OPS.paintInlineImageXObject ||
      operation === OPS.paintImageMaskXObject ||
      operation === OPS.paintSolidColorImageMask
    ) {
      paint()
    } else if (operation === OPS.paintImageXObjectRepeat) {
      const scaleX = args[1]
      const scaleY = args[2]
      const positions = numberArray(args[3])
      if (typeof scaleX === 'number' && typeof scaleY === 'number' && positions) {
        for (let position = 0; position < positions.length; position += 2) {
          const x = positions[position]
          const y = positions[position + 1]
          if (typeof x === 'number' && typeof y === 'number') {
            paint([scaleX, 0, 0, scaleY, x, y])
          }
        }
      } else warnings.add('INVALID_IMAGE_REPEAT')
    } else if (
      operation === OPS.paintInlineImageXObjectGroup ||
      operation === OPS.paintImageMaskXObjectGroup
    ) {
      const entries = operation === OPS.paintInlineImageXObjectGroup ? args[1] : args[0]
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const transform = (entry as { transform?: unknown }).transform
          if (isMatrix(transform)) paint(transform)
          else warnings.add('INVALID_IMAGE_GROUP')
        }
      } else warnings.add('INVALID_IMAGE_GROUP')
    } else if (operation === OPS.paintImageMaskXObjectRepeat) {
      const scaleX = args[1]
      const skewX = args[2]
      const skewY = args[3]
      const scaleY = args[4]
      const positions = numberArray(args[5])
      if ([scaleX, skewX, skewY, scaleY].every((value) => typeof value === 'number') && positions) {
        for (let position = 0; position < positions.length; position += 2) {
          const x = positions[position]
          const y = positions[position + 1]
          if (typeof x === 'number' && typeof y === 'number') {
            paint([scaleX as number, skewX as number, skewY as number, scaleY as number, x, y])
          }
        }
      } else warnings.add('INVALID_IMAGE_MASK_REPEAT')
    }
  }

  return { ratio: Math.min(1, paintedArea / pageArea), warnings: [...warnings] }
}

function metadataText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalised = value.normalize('NFC').replace(/\s+/gu, ' ').trim()
  return normalised || undefined
}

function inspectionFailure(error: unknown): PdfInspectionError {
  const structuredError = error as { name?: unknown; code?: unknown }
  if (
    structuredError?.name === 'PasswordException' ||
    structuredError?.code === PasswordResponses.NEED_PASSWORD ||
    structuredError?.code === PasswordResponses.INCORRECT_PASSWORD
  ) {
    return new PdfInspectionError('PDF_ENCRYPTED', 'PDF requires a password', { cause: error })
  }
  return new PdfInspectionError(
    'PDF_MALFORMED',
    error instanceof Error ? error.message : 'PDF parsing failed',
    { cause: error }
  )
}

export async function inspectPdf(
  bytes: Uint8Array,
  thresholds: PdfInspectionThresholds
): Promise<PdfInspection> {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  })

  try {
    const document = await loadingTask.promise
    if (document.numPages < 1) throw new PdfInspectionError('PDF_EMPTY', 'PDF has no pages')
    const evidence: Array<{ text: string; imageAreaRatio: number | null; warnings: string[] }> = []

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const warnings: string[] = []
      const textContent = await page.getTextContent({ disableNormalization: false })
      const text = textContent.items
        .flatMap((item) => ('str' in item && typeof item.str === 'string' ? [item.str] : []))
        .join(' ')
      let areaRatio: number | null = null
      try {
        const operators = await page.getOperatorList()
        const imageSignals = imageAreaRatio(operators.fnArray, operators.argsArray, page.view)
        areaRatio = imageSignals.ratio
        warnings.push(...imageSignals.warnings)
      } catch {
        warnings.push('IMAGE_SIGNALS_UNAVAILABLE')
      }
      evidence.push({ text, imageAreaRatio: areaRatio, warnings })
      page.cleanup()
    }

    const calculated = calculateSignals(evidence, thresholds)
    const metadata = await document.getMetadata().catch(() => null)
    const info = metadata?.info as Record<string, unknown> | undefined
    const producer = metadataText(info?.Producer)
    const creator = metadataText(info?.Creator)
    const warnings = [...new Set(calculated.pages.flatMap((page) => page.warnings))]
    await loadingTask.destroy()

    return {
      schemaVersion: 1,
      contentHash,
      pageCount: calculated.pages.length,
      pages: calculated.pages,
      signals: calculated.signals,
      metadata: {
        ...(producer ? { producer } : {}),
        ...(creator ? { creator } : {}),
      },
      warnings,
    }
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined)
    if (error instanceof PdfInspectionError) throw error
    throw inspectionFailure(error)
  }
}
