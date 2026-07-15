import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHotelStays } from '../src/hotels.js'

const base = { hotelName: 'Inn', hotelAddress: '', checkInDay: '2026-07-18', checkOutDay: '2026-07-19' }

test('a stay without confirmations gets an empty list', () => {
  const { stays } = normalizeHotelStays([{ ...base }])
  assert.deepEqual(stays[0].confirmations, [])
})

test('confirmations round-trip with trimmed room fields, empty fields dropped', () => {
  const { stays } = normalizeHotelStays([
    {
      ...base,
      confirmations: [
        {
          confirmationNumber: ' 20869678 ',
          rooms: [{ roomType: ' Western Cabin ', guests: 'Jim & Kathy', notes: '' }, {}],
        },
        { confirmationNumber: '20871144' },
      ],
    },
  ])
  assert.deepEqual(stays[0].confirmations, [
    {
      confirmationNumber: '20869678',
      rooms: [{ roomType: 'Western Cabin', guests: 'Jim & Kathy' }, {}],
    },
    { confirmationNumber: '20871144', rooms: [] },
  ])
})

test('the legacy confirmationNumber key is rejected, not silently dropped', () => {
  const { error } = normalizeHotelStays([{ ...base, confirmationNumber: 'ABC123' }])
  assert.match(error, /replaced by confirmations/)
})

test('rejects bad confirmations payloads', () => {
  const bad = [
    [{ ...base, confirmations: 'nope' }],
    [{ ...base, confirmations: [{}] }],
    [{ ...base, confirmations: [{ confirmationNumber: '  ' }] }],
    [{ ...base, confirmations: [{ confirmationNumber: 'A', rooms: 'nope' }] }],
    [{ ...base, confirmations: [{ confirmationNumber: 'A', rooms: [{ roomType: 7 }] }] }],
  ]
  for (const input of bad) assert.ok(normalizeHotelStays(input).error, JSON.stringify(input))
})
