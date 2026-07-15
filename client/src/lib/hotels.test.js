import { describe, it, expect } from 'vitest'
import {
  stayCoversDay,
  staysForDay,
  checkInsOn,
  checkOutsOn,
  isMissingStay,
  validateStay,
  nextDay,
  mapsSearchUrl,
} from './hotels.js'

const stay = (checkInDay, checkOutDay, hotelName = 'Test Hotel') => ({
  hotelName,
  hotelAddress: '',
  checkInDay,
  checkOutDay,
})

describe('stayCoversDay', () => {
  const s = stay('2026-07-18', '2026-07-21')
  it('covers the check-in day', () => expect(stayCoversDay(s, '2026-07-18')).toBe(true))
  it('covers mid-range days', () => expect(stayCoversDay(s, '2026-07-19')).toBe(true))
  it('does NOT cover the check-out day', () => expect(stayCoversDay(s, '2026-07-21')).toBe(false))
  it('does not cover before check-in', () => expect(stayCoversDay(s, '2026-07-17')).toBe(false))
  it('does not cover after check-out', () => expect(stayCoversDay(s, '2026-07-22')).toBe(false))
  it('degenerate zero-night stay covers nothing', () => {
    expect(stayCoversDay(stay('2026-07-18', '2026-07-18'), '2026-07-18')).toBe(false)
  })
})

describe('day queries', () => {
  const a = stay('2026-07-01', '2026-07-03', 'A')
  const b = stay('2026-07-02', '2026-07-05', 'B')
  it('staysForDay returns all overlapping stays', () => {
    expect(staysForDay([a, b], '2026-07-02').map((s) => s.hotelName)).toEqual(['A', 'B'])
  })
  it('checkInsOn matches exact check-in date', () => {
    expect(checkInsOn([a, b], '2026-07-02').map((s) => s.hotelName)).toEqual(['B'])
  })
  it('checkOutsOn matches exact check-out date', () => {
    expect(checkOutsOn([a, b], '2026-07-03').map((s) => s.hotelName)).toEqual(['A'])
  })
  it('isMissingStay is true with no coverage', () => {
    expect(isMissingStay([a, b], '2026-07-05')).toBe(true)
    expect(isMissingStay([], '2026-07-01')).toBe(true)
    expect(isMissingStay(undefined, '2026-07-01')).toBe(true)
    expect(isMissingStay([a], '2026-07-01')).toBe(false)
  })
})

describe('validateStay', () => {
  it('requires a hotel name', () => {
    expect(validateStay({ hotelName: ' ', checkInDay: '2026-07-01', checkOutDay: '2026-07-02' })).toMatch(/name/)
  })
  it('requires valid dates', () => {
    expect(validateStay({ hotelName: 'X', checkInDay: '', checkOutDay: '2026-07-02' })).toMatch(/check-in/)
    expect(validateStay({ hotelName: 'X', checkInDay: '2026-07-01', checkOutDay: 'later' })).toMatch(/check-out/)
  })
  it('requires check-out after check-in', () => {
    expect(validateStay({ hotelName: 'X', checkInDay: '2026-07-02', checkOutDay: '2026-07-02' })).toMatch(/after/)
    expect(validateStay({ hotelName: 'X', checkInDay: '2026-07-02', checkOutDay: '2026-07-01' })).toMatch(/after/)
  })
  it('accepts a valid stay', () => {
    expect(validateStay({ hotelName: 'X', checkInDay: '2026-07-01', checkOutDay: '2026-07-02' })).toBe(null)
  })
})

describe('nextDay', () => {
  it('adds one day', () => expect(nextDay('2026-07-18')).toBe('2026-07-19'))
  it('rolls over month ends', () => expect(nextDay('2026-07-31')).toBe('2026-08-01'))
  it('rolls over year ends', () => expect(nextDay('2026-12-31')).toBe('2027-01-01'))
  it('handles leap years', () => expect(nextDay('2028-02-28')).toBe('2028-02-29'))
  it('returns empty for invalid input', () => expect(nextDay('')).toBe(''))
})

describe('mapsSearchUrl', () => {
  it('builds an encoded maps search link', () => {
    expect(mapsSearchUrl('315 Yellowstone Ave, West Yellowstone, MT')).toBe(
      'https://www.google.com/maps/search/?api=1&query=315%20Yellowstone%20Ave%2C%20West%20Yellowstone%2C%20MT'
    )
  })
})

describe('validateStay confirmations', () => {
  const base = { hotelName: 'Inn', checkInDay: '2026-07-18', checkOutDay: '2026-07-19' }
  it('rejects a blank confirmation #', () => {
    expect(validateStay({ ...base, confirmations: [{ confirmationNumber: ' ' }] })).toMatch(
      /confirmation #/
    )
  })
  it('accepts zero confirmations and filled ones', () => {
    expect(validateStay({ ...base, confirmations: [] })).toBeNull()
    expect(validateStay({ ...base, confirmations: [{ confirmationNumber: 'A', rooms: [] }] })).toBeNull()
  })
})
