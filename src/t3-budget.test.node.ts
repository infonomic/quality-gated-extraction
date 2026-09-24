import { projectT3Pages } from './t3-budget.js'

describe('T3 budget projection', () => {
  test('applies the inferred cold-start surcharge once per service process', () => {
    const onePage = projectT3Pages(1)
    const thousandPages = projectT3Pages(1_000)
    const onePageSurcharge = onePage.scannedWarmPlusOneColdStartHours - onePage.scannedWarmHours
    const thousandPageSurcharge =
      thousandPages.scannedWarmPlusOneColdStartHours - thousandPages.scannedWarmHours

    expect(thousandPageSurcharge).toBeCloseTo(onePageSurcharge, 12)
    expect(onePageSurcharge).toBeGreaterThan(0)
  })

  test('does not charge a cold start for an empty projection', () => {
    expect(projectT3Pages(0)).toEqual({
      pageCount: 0,
      bornDigitalWarmHours: 0,
      scannedWarmHours: 0,
      scannedWarmPlusOneColdStartHours: 0,
    })
  })
})
