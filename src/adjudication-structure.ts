interface StructuralView {
  text: string | null
  note: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function values(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item != null) : []
}

function belongsToPage(item: Record<string, unknown>, page: number): boolean {
  return values(item.prov).some((provenance) => provenance.page_no === page)
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function renderDoclingItem(item: Record<string, unknown>, kind: string): string {
  if (kind === 'tables') {
    const data = record(item.data)
    const rows = Array.isArray(data?.grid) ? data.grid : []
    const renderedRows = rows
      .map((row) =>
        Array.isArray(row)
          ? row
              .map((cell) => textValue(record(cell)?.text))
              .join(' | ')
              .trim()
          : ''
      )
      .filter(Boolean)
    const dimensions = `${String(data?.num_rows ?? '?')}x${String(data?.num_cols ?? '?')}`
    return [`[table ${dimensions}]`, ...renderedRows].join('\n')
  }
  if (kind === 'pictures') return '[picture]'
  const label = textValue(item.label) || kind.replace(/s$/u, '')
  const text = textValue(item.text)
  return text ? `[${label}] ${text}` : `[${label}]`
}

function doclingView(structure: Record<string, unknown>, page: number): StructuralView {
  const collections = ['texts', 'tables', 'pictures', 'groups'] as const
  const byReference = new Map<string, { item: Record<string, unknown>; kind: string }>()
  for (const kind of collections) {
    for (const item of values(structure[kind])) {
      const reference = textValue(item.self_ref)
      if (reference) byReference.set(reference, { item, kind })
    }
  }

  const lines: string[] = []
  const seen = new Set<string>()
  const visit = (reference: string): void => {
    if (!reference || seen.has(reference)) return
    seen.add(reference)
    const resolved = byReference.get(reference)
    if (!resolved) return
    if (resolved.kind === 'groups') {
      for (const child of values(resolved.item.children)) visit(textValue(child.$ref))
      return
    }
    if (belongsToPage(resolved.item, page)) {
      lines.push(renderDoclingItem(resolved.item, resolved.kind))
    }
    for (const child of values(resolved.item.children)) visit(textValue(child.$ref))
  }

  const body = record(structure.body)
  for (const child of values(body?.children)) visit(textValue(child.$ref))

  if (lines.length === 0) {
    for (const kind of ['texts', 'tables', 'pictures'] as const) {
      for (const item of values(structure[kind])) {
        if (belongsToPage(item, page)) lines.push(renderDoclingItem(item, kind))
      }
    }
  }
  return {
    text: lines.length > 0 ? lines.join('\n\n') : null,
    note:
      lines.length > 0
        ? 'Typed Docling blocks in provider reading order; table rows retain cell boundaries.'
        : 'Docling returned no typed blocks attributable to this page.',
  }
}

function paddleView(structure: unknown[]): StructuralView {
  const blocks = structure
    .flatMap((page) => values(record(page)?.parsing_res_list))
    .sort((left, right) => Number(left.block_order ?? 0) - Number(right.block_order ?? 0))
  const lines = blocks.map((block) => {
    const label = textValue(block.block_label) || 'block'
    const content = textValue(block.block_content)
    return content ? `[${label}] ${content}` : `[${label}]`
  })
  return {
    text: lines.length > 0 ? lines.join('\n\n') : null,
    note:
      lines.length > 0
        ? 'Typed PaddleOCR-VL blocks in provider block order.'
        : 'PaddleOCR-VL returned no typed structural blocks for this page.',
  }
}

export function buildStructuralView(structure: unknown, page: number): StructuralView {
  if (Array.isArray(structure)) return paddleView(structure)
  const object = record(structure)
  if (object && Array.isArray(object.texts)) return doclingView(object, page)
  return {
    text: null,
    note: 'Provider returned no structure representation; only the flat text view is available.',
  }
}
