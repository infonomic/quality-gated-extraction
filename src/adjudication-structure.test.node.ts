import { buildStructuralView } from './adjudication-structure.js'

describe('adjudication structural view', () => {
  test('renders page-scoped Docling labels and table cells in body order', () => {
    const structure = {
      body: {
        children: [{ $ref: '#/texts/0' }, { $ref: '#/tables/0' }, { $ref: '#/texts/1' }],
      },
      groups: [],
      pictures: [],
      texts: [
        {
          self_ref: '#/texts/0',
          label: 'section_header',
          text: 'Methods',
          prov: [{ page_no: 3 }],
        },
        {
          self_ref: '#/texts/1',
          label: 'text',
          text: 'Other page',
          prov: [{ page_no: 4 }],
        },
      ],
      tables: [
        {
          self_ref: '#/tables/0',
          prov: [{ page_no: 3 }],
          data: {
            num_rows: 1,
            num_cols: 2,
            grid: [[{ text: 'Treatment' }, { text: 'Value' }]],
          },
        },
      ],
    }
    expect(buildStructuralView(structure, 3)).toEqual({
      text: '[section_header] Methods\n\n[table 1x2]\nTreatment | Value',
      note: 'Typed Docling blocks in provider reading order; table rows retain cell boundaries.',
    })
  })

  test('renders Paddle blocks by provider order and keeps an absent structure explicit', () => {
    expect(
      buildStructuralView(
        [
          {
            parsing_res_list: [
              { block_order: 2, block_label: 'text', block_content: 'Body' },
              { block_order: 1, block_label: 'doc_title', block_content: 'Title' },
            ],
          },
        ],
        1
      ).text
    ).toBe('[doc_title] Title\n\n[text] Body')
    expect(buildStructuralView(undefined, 1)).toEqual({
      text: null,
      note: 'Provider returned no structure representation; only the flat text view is available.',
    })
  })
})
