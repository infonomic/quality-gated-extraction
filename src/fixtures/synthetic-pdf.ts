import {
  createSyntheticScanImage,
  syntheticScanHeight,
  syntheticScanWidth,
} from './synthetic-scan-image.js'

function ascii(value: string): Uint8Array {
  return Buffer.from(value, 'ascii')
}

function buildPdf(objects: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')]
  const offsets = [0]
  let length = chunks[0]?.byteLength ?? 0

  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const prefix = ascii(`${index + 1} 0 obj\n`)
    const suffix = ascii('\nendobj\n')
    chunks.push(prefix, object, suffix)
    length += prefix.byteLength + object.byteLength + suffix.byteLength
  }

  const xrefOffset = length
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('')
  chunks.push(ascii(xref))
  return Buffer.concat(chunks)
}

function streamObject(dictionary: string, contents: Uint8Array): Uint8Array {
  return Buffer.concat([
    ascii(`<< ${dictionary} /Length ${contents.byteLength} >>\nstream\n`),
    contents,
    ascii('\nendstream'),
  ])
}

export function createSyntheticBornDigitalPdf(): Uint8Array {
  const content = ascii(
    'BT /F1 18 Tf 72 720 Td (Synthetic FORRU extraction benchmark) Tj 0 -28 Td (No source content.) Tj ET'
  )
  return buildPdf([
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    ),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    streamObject('', content),
  ])
}

export function createSyntheticScannedPdf(): Uint8Array {
  const image = createSyntheticScanImage()
  const content = ascii('q 612 0 0 792 0 0 cm /Im0 Do Q')
  return buildPdf([
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
    ),
    streamObject(
      `/Type /XObject /Subtype /Image /Width ${syntheticScanWidth} /Height ${syntheticScanHeight} /ColorSpace /DeviceGray /BitsPerComponent 8`,
      image
    ),
    streamObject('', content),
  ])
}
