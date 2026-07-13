import { describe, it, expect } from 'vitest'
import { listTripDates } from './dates.js'

describe('listTripDates', () => {
  it('returns the sorted dates of the trip day entries', () => {
    const trip = {
      days: {
        '2026-07-03': { items: [] },
        '2026-07-01': { items: [] },
        '2026-07-04': { items: [] },
      },
    }
    expect(listTripDates(trip)).toEqual(['2026-07-01', '2026-07-03', '2026-07-04'])
  })

  it('handles missing or empty days', () => {
    expect(listTripDates({})).toEqual([])
    expect(listTripDates({ days: {} })).toEqual([])
  })
})
