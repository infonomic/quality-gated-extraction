export interface PdfInspectionThresholds {
  minimumTextCharsPerPage: number
  fullPageImageAreaRatio: number
  mixedScriptMinimumRatio: number
}

export interface PdfPageInspection {
  page: number
  textChars: number
  imageAreaRatio: number | null
  encodingAnomalyCount: number
  thaiChars: number
  latinChars: number
  warnings: string[]
}

export interface PdfRoutingSignals {
  totalTextChars: number
  charsPerPage: number
  textLayerCoverage: number
  charsPerPageCv: number
  meanImageAreaRatio: number | null
  fullPageImageRatio: number | null
  encodingAnomalyRatio: number
  thaiCharRatio: number
  latinCharRatio: number
  mixedScript: boolean
}

export interface PdfInspection {
  schemaVersion: 1
  contentHash: string
  pageCount: number
  pages: PdfPageInspection[]
  signals: PdfRoutingSignals
  metadata: {
    producer?: string
    creator?: string
  }
  warnings: string[]
}

export type PdfInspectionErrorCode = 'PDF_ENCRYPTED' | 'PDF_MALFORMED' | 'PDF_EMPTY'

export class PdfInspectionError extends Error {
  constructor(
    readonly code: PdfInspectionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'PdfInspectionError'
  }
}
