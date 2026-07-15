import { describe, it, expect } from 'vitest'
import {
  flightDate,
  flightClock,
  flightTripsTouchingDay,
  flightsTouchingDay,
  validateFlightTrip,
  seatClassKind,
} from './flights.js'

const trip = (flights) => ({ confirmationNumber: 'GK5XPL', flights })
const overnight = { departureTime: '2026-07-17T23:30', arrivalTime: '2026-07-18T05:45', seats: [] }
const sameday = { departureTime: '2026-07-19T09:00', arrivalTime: '2026-07-19T11:00', seats: [] }

describe('flight day matching', () => {
  it('slices date and clock', () => {
    expect(flightDate('2026-07-17T15:00')).toBe('2026-07-17')
    expect(flightClock('2026-07-17T15:00')).toBe('15:00')
  })
  it('overnight flights touch both days', () => {
    const trips = [trip([overnight]), trip([sameday])]
    expect(flightsTouchingDay(trips, '2026-07-17')).toEqual([overnight])
    expect(flightsTouchingDay(trips, '2026-07-18')).toEqual([overnight])
    expect(flightTripsTouchingDay(trips, '2026-07-19')).toEqual([trip([sameday])])
    expect(flightTripsTouchingDay(trips, '2026-07-20')).toEqual([])
  })
})

describe('validateFlightTrip', () => {
  it('requires at least one flight and valid ordered times', () => {
    expect(validateFlightTrip({ flights: [] })).toMatch(/at least one/)
    expect(validateFlightTrip({ flights: [{ departureTime: '', arrivalTime: '2026-07-17T18:05' }] })).toMatch(/departure/)
    expect(
      validateFlightTrip({ flights: [{ departureTime: '2026-07-17T18:05', arrivalTime: '2026-07-17T15:00' }] })
    ).toMatch(/after departure/)
    expect(validateFlightTrip(trip([sameday]))).toBeNull()
  })
  it('requires a seat number on every seat', () => {
    expect(
      validateFlightTrip(trip([{ ...sameday, seats: [{ class: 'First', seatNumber: ' ' }] }]))
    ).toMatch(/seat number/i)
  })
})

describe('seatClassKind', () => {
  it('maps classes to chip kinds', () => {
    expect(seatClassKind('Comfort+')).toBe('plus')
    expect(seatClassKind('Premium Plus')).toBe('plus')
    expect(seatClassKind('First')).toBe('first')
    expect(seatClassKind('first class')).toBe('first')
    expect(seatClassKind('Economy')).toBe('plain')
    expect(seatClassKind(undefined)).toBe('plain')
  })
})
