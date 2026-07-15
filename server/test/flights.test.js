import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFlightTrips } from '../src/flights.js'

const flight = (extra = {}) => ({
  departureTime: '2026-07-17T15:00',
  arrivalTime: '2026-07-17T18:05',
  ...extra,
})

test('normalizes a full flight trip, trimming and dropping empty optionals', () => {
  const { flightTrips } = normalizeFlightTrips([
    {
      confirmationNumber: ' GK5XPL ',
      junk: 'dropped',
      flights: [
        flight({
          flightNumber: ' DL1048 ',
          ticketNumber: ' 0062341987654 ',
          seats: [
            { class: ' Comfort+ ', seatNumber: ' 14E ' },
            { class: '', seatNumber: '14C', junk: true },
          ],
        }),
      ],
    },
  ])
  assert.deepEqual(flightTrips, [
    {
      confirmationNumber: 'GK5XPL',
      flights: [
        {
          departureTime: '2026-07-17T15:00',
          arrivalTime: '2026-07-17T18:05',
          seats: [{ seatNumber: '14E', class: 'Comfort+' }, { seatNumber: '14C' }],
          flightNumber: 'DL1048',
          ticketNumber: '0062341987654',
        },
      ],
    },
  ])
})

test('confirmation number, flight number, ticket number, and seats are optional', () => {
  const { flightTrips } = normalizeFlightTrips([{ flights: [flight()] }])
  assert.deepEqual(flightTrips, [
    {
      flights: [
        { departureTime: '2026-07-17T15:00', arrivalTime: '2026-07-17T18:05', seats: [] },
      ],
    },
  ])
})

test('rejects bad payloads', () => {
  const bad = [
    'nope',
    [{ flights: [] }],
    [{}],
    [{ flights: [flight({ departureTime: '2026-07-17' })] }],
    [{ flights: [flight({ arrivalTime: 'six pm' })] }],
    [{ flights: [flight({ arrivalTime: '2026-07-17T15:00' })] }], // not after departure
    [{ flights: [flight({ seats: [{ class: 'First' }] })] }], // seat without number
    [{ flights: [flight({ seats: 'nope' })] }],
    [{ confirmationNumber: 7, flights: [flight()] }],
  ]
  for (const input of bad) assert.ok(normalizeFlightTrips(input).error, JSON.stringify(input))
})
