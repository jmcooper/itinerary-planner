# Flight Trips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trip-level flight tracking ("flight trips": one confirmation # sharing many flights with times, ticket #s, and seats), with day airplane icons, list/detail dialogs mirroring hotels, linked-day propagation, and agent support that also writes itinerary items.

**Architecture:** A new `trip.flightTrips` array (never mixed into `hotelStays`) validated by `server/src/flights.js` and shared by REST PUT + the agent tool. Client mirrors the hotel feature: `lib/flights.js` helpers, `FlightsModal.jsx` dialogs reusing the exported pill/copy components from `HotelStaysModal.jsx`, plane icons on day tiles/header, `linkedFlightTrips` via `resolveTripDays`.

**Tech Stack:** Node/Express + node:test/supertest, React/Vite + vitest, Genkit + zod, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-15-flight-trips-design.md`

## Global Constraints

- Flight trip shape: `{ confirmationNumber?, flights: [{ flightNumber?, departureTime, arrivalTime, ticketNumber?, seats: [{ class?, seatNumber }] }] }`.
- `flights` required non-empty; `departureTime`/`arrivalTime` required, format `YYYY-MM-DDTHH:MM` (local wall-clock, timezones ignored), `arrivalTime > departureTime` (string compare).
- `confirmationNumber`, `flightNumber`, `ticketNumber`, seat `class` optional — trimmed, omitted from storage when empty. `seats` always stored as an array (possibly `[]`); `seatNumber` required per seat.
- `flightTrips` is a FULL-replacement list in REST PUT and the agent tool. Never store flights in `hotelStays`.
- A flight "touches" a date when its departure OR arrival date equals it (overnight flights touch both days). No missing-flight warnings anywhere.
- Seat chip colors: `/comfort|plus/i` → blue #1a66b3, `/first/i` → red `var(--danger)`, else plain with `var(--line)` border.
- The dev server runs without `--watch`: restart `node src/index.js` after server edits before browser/live verification.

---

### Task 1: Server validation + REST PUT

**Files:**
- Create: `server/src/flights.js`
- Modify: `server/src/app.js` (PUT handler, after the `hotelStays` branch at ~line 369-373)
- Test: create `server/test/flights.test.js`; append to `server/test/api.test.js`

**Interfaces:**
- Produces: `normalizeFlightTrips(input) → { flightTrips } | { error }` exported from `server/src/flights.js`. Emitted flight trips always have `flights` (non-empty) with `seats: []` at minimum per flight; optional strings omitted when empty.

- [ ] **Step 1: Write the failing unit tests** — create `server/test/flights.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern="flight"` — FAIL (module doesn't exist).

- [ ] **Step 3: Implement** — create `server/src/flights.js`:

```js
// Flight-trip validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A "flight trip" is one booking: a confirmation number
// shared by one or more flights (round trips and multi-city itineraries).
// Times are local wall-clock date+times; timezones are deliberately ignored,
// so plain string comparison orders them correctly.

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

// Validates and normalizes a flight-trips payload. Returns { flightTrips } on
// success or { error } on the first problem. Only known fields are kept
// (trimmed), so junk can't accumulate in the trip JSON.
export function normalizeFlightTrips(input) {
  if (!Array.isArray(input)) return { error: 'flightTrips must be an array' }
  const flightTrips = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each flight trip must be an object' }
    if (raw.confirmationNumber != null && typeof raw.confirmationNumber !== 'string')
      return { error: 'confirmationNumber must be a string' }
    if (!Array.isArray(raw.flights) || raw.flights.length === 0)
      return { error: 'each flight trip needs at least one flight' }
    const flights = []
    for (const rawFlight of raw.flights) {
      if (typeof rawFlight !== 'object' || rawFlight === null)
        return { error: 'each flight must be an object' }
      if (
        !DATETIME_RE.test(rawFlight.departureTime ?? '') ||
        !DATETIME_RE.test(rawFlight.arrivalTime ?? '')
      )
        return { error: 'departureTime and arrivalTime must be YYYY-MM-DDTHH:MM' }
      if (rawFlight.arrivalTime <= rawFlight.departureTime)
        return { error: 'arrivalTime must be after departureTime' }
      const flight = {
        departureTime: rawFlight.departureTime,
        arrivalTime: rawFlight.arrivalTime,
        seats: [],
      }
      for (const field of ['flightNumber', 'ticketNumber']) {
        if (rawFlight[field] != null && typeof rawFlight[field] !== 'string')
          return { error: `${field} must be a string` }
        const value = (rawFlight[field] ?? '').trim()
        if (value) flight[field] = value
      }
      if (rawFlight.seats != null) {
        if (!Array.isArray(rawFlight.seats)) return { error: 'seats must be an array' }
        for (const rawSeat of rawFlight.seats) {
          if (typeof rawSeat !== 'object' || rawSeat === null)
            return { error: 'each seat must be an object' }
          const seatNumber =
            typeof rawSeat.seatNumber === 'string' ? rawSeat.seatNumber.trim() : ''
          if (!seatNumber) return { error: 'each seat needs a seatNumber' }
          if (rawSeat.class != null && typeof rawSeat.class !== 'string')
            return { error: 'seat class must be a string' }
          const seat = { seatNumber }
          const cls = (rawSeat.class ?? '').trim()
          if (cls) seat.class = cls
          flight.seats.push(seat)
        }
      }
      flights.push(flight)
    }
    const flightTrip = {}
    const conf = (raw.confirmationNumber ?? '').trim()
    if (conf) flightTrip.confirmationNumber = conf
    flightTrip.flights = flights
    flightTrips.push(flightTrip)
  }
  return { flightTrips }
}
```

Note the unit test's expected object puts `confirmationNumber` before `flights` — `assert.deepEqual` ignores key order, so this passes.

- [ ] **Step 4: Wire the PUT handler.** In `server/src/app.js`, import `normalizeFlightTrips` from `./flights.js` and add after the `hotelStays` branch (~line 373):

```js
      if ('flightTrips' in body) {
        const { flightTrips, error } = normalizeFlightTrips(body.flightTrips)
        if (error) return res.status(400).json({ error })
        trip.flightTrips = flightTrips
      }
```

- [ ] **Step 5: API tests** — append to `server/test/api.test.js` (near the hotelStays tests, ~line 335):

```js
test('PUT /api/trips/:id round-trips flightTrips with normalization', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Flight Trip' })
  const id = created.body.id
  const res = await alice.put(`/api/trips/${id}`).send({
    flightTrips: [
      {
        confirmationNumber: ' GK5XPL ',
        flights: [
          {
            flightNumber: 'DL1048',
            departureTime: '2026-07-17T15:00',
            arrivalTime: '2026-07-17T18:05',
            seats: [{ class: 'Comfort+', seatNumber: '14E' }],
            junk: 'dropped',
          },
        ],
      },
    ],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.flightTrips, [
    {
      confirmationNumber: 'GK5XPL',
      flights: [
        {
          departureTime: '2026-07-17T15:00',
          arrivalTime: '2026-07-17T18:05',
          seats: [{ seatNumber: '14E', class: 'Comfort+' }],
          flightNumber: 'DL1048',
        },
      ],
    },
  ])
})

test('PUT /api/trips/:id rejects invalid flightTrips', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Bad Flights' })
  const id = created.body.id
  const bad = [
    { flightTrips: 'nope' },
    { flightTrips: [{ flights: [] }] },
    { flightTrips: [{ flights: [{ departureTime: '2026-07-17T15:00', arrivalTime: '2026-07-17T14:00' }] }] },
    { flightTrips: [{ flights: [{ departureTime: '2026-07-17T15:00', arrivalTime: '2026-07-17T18:05', seats: [{ class: 'First' }] }] }] },
  ]
  for (const body of bad) {
    const res = await alice.put(`/api/trips/${id}`).send(body)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
})

test('duplicating a trip copies flightTrips', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Flights To Copy' })
  await alice.put(`/api/trips/${created.body.id}`).send({
    flightTrips: [{ flights: [{ departureTime: '2026-09-01T08:00', arrivalTime: '2026-09-01T10:00' }] }],
  })
  const copy = await alice.post(`/api/trips/${created.body.id}/duplicate`)
  assert.equal(copy.body.flightTrips.length, 1)
})
```

- [ ] **Step 6: Run the full server suite**

Run: `cd server; npm test` — ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/flights.js server/src/app.js server/test/flights.test.js server/test/api.test.js
git commit -m "Store and validate trip-level flight trips"
```

---

### Task 2: Linked-day propagation + copy-and-delete

**Files:**
- Modify: `server/src/links.js` (`normalizeLinkedDay` ~line 15-22, `resolveTripDays` ~line 71-85), `server/src/app.js` DELETE handler (~line 428-439, after the hotel-stay copy loop)
- Test: append to `server/test/api.test.js`

**Interfaces:**
- Consumes: `trip.flightTrips` shape from Task 1.
- Produces: resolved linked days carry `linkedFlightTrips` (each tagged `linkedTripName`); stored days never keep them; copy-and-delete materializes touching flight trips into linking trips.

- [ ] **Step 1: Write the failing tests** — append to `server/test/api.test.js` (near the existing linked-day tests; follow their setup style for creating two trips and linking a day):

```js
test('a linked day resolves with linkedFlightTrips from the target trip', async () => {
  const target = (await alice.post('/api/trips').send({ name: 'Flight Target' })).body
  await alice.put(`/api/trips/${target.id}`).send({
    days: { '2026-07-17': { title: 'Fly', mapsUrl: '', items: [] } },
    flightTrips: [
      {
        confirmationNumber: 'GK5XPL',
        flights: [
          { departureTime: '2026-07-17T15:00', arrivalTime: '2026-07-17T18:05', seats: [] },
        ],
      },
    ],
  })
  const linker = (await alice.post('/api/trips').send({ name: 'Flight Linker' })).body
  await alice.put(`/api/trips/${linker.id}`).send({
    days: { '2026-07-17': { linkedTripId: target.id } },
  })
  const resolved = await alice.get(`/api/trips/${linker.id}`)
  const day = resolved.body.days['2026-07-17']
  assert.equal(day.linkedFlightTrips.length, 1)
  assert.equal(day.linkedFlightTrips[0].confirmationNumber, 'GK5XPL')
  assert.equal(day.linkedFlightTrips[0].linkedTripName, 'Flight Target')

  // Round-tripping the resolved day back through PUT must not persist the
  // linked flight trips (single source of truth).
  await alice.put(`/api/trips/${linker.id}`).send({ days: resolved.body.days })
  const again = await alice.get(`/api/trips/${linker.id}`)
  assert.equal(again.body.days['2026-07-17'].linkedFlightTrips.length, 1) // still resolves
  assert.equal(again.body.flightTrips ?? undefined, undefined) // never copied to the trip
})

test('copy-and-delete materializes flight trips touching linked days', async () => {
  const target = (await alice.post('/api/trips').send({ name: 'Flight Del Target' })).body
  await alice.put(`/api/trips/${target.id}`).send({
    days: { '2026-07-18': { title: 'Fly home', mapsUrl: '', items: [] } },
    flightTrips: [
      { flights: [{ departureTime: '2026-07-18T19:30', arrivalTime: '2026-07-18T22:45', seats: [] }] },
      { flights: [{ departureTime: '2026-09-01T08:00', arrivalTime: '2026-09-01T10:00', seats: [] }] },
    ],
  })
  const linker = (await alice.post('/api/trips').send({ name: 'Flight Del Linker' })).body
  await alice.put(`/api/trips/${linker.id}`).send({
    days: { '2026-07-18': { linkedTripId: target.id } },
  })
  const del = await alice.delete(`/api/trips/${target.id}?copyLinks=1`)
  assert.equal(del.status, 204)
  const after = await alice.get(`/api/trips/${linker.id}`)
  // Only the flight trip touching the linked date is materialized.
  assert.equal(after.body.flightTrips.length, 1)
  assert.equal(after.body.flightTrips[0].flights[0].departureTime, '2026-07-18T19:30')
})
```

(If the DELETE route returns a different success status in this codebase, match the existing copy-and-delete test's assertion.)

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern="linkedFlightTrips|materializes flight"` — FAIL.

- [ ] **Step 3: Implement links.js.** Add near the top of `server/src/links.js`:

```js
const flightTouchesDate = (flight, date) =>
  flight.departureTime?.slice(0, 10) === date || flight.arrivalTime?.slice(0, 10) === date
```

In `normalizeLinkedDay`, extend the scrub destructure:

```js
    const { linkedTripName, linkedCanEdit, linkedBroken, linkedHotelStays, linkedFlightTrips, ...clean } = day
```

In `resolveTripDays`, after the `linkedHotelStays` computation (~line 78), add:

```js
    // Flight trips are trip-level too: the target's flight trips touching
    // this date ride along so the linking trip shows the plane icons.
    const linkedFlightTrips = (target.flightTrips ?? [])
      .filter((ft) => (ft.flights ?? []).some((f) => flightTouchesDate(f, date)))
      .map((ft) => ({ ...ft, linkedTripName: target.name }))
```

and extend the day spread:

```js
      ...(linkedHotelStays.length ? { linkedHotelStays } : {}),
      ...(linkedFlightTrips.length ? { linkedFlightTrips } : {}),
```

- [ ] **Step 4: Implement copy-and-delete.** In `server/src/app.js`, right after the hotel-stay copy loop inside the linker/day loop (~line 439), add:

```js
            // Flight coverage for this day came from this trip too — keep it.
            for (const ft of trip.flightTrips ?? []) {
              const touches = (ft.flights ?? []).some(
                (f) =>
                  f.departureTime?.slice(0, 10) === date || f.arrivalTime?.slice(0, 10) === date
              )
              if (!touches) continue
              linker.flightTrips = linker.flightTrips ?? []
              const exists = linker.flightTrips.some(
                (t) => JSON.stringify(t.flights) === JSON.stringify(ft.flights)
              )
              if (!exists) linker.flightTrips.push(structuredClone(ft))
            }
```

- [ ] **Step 5: Run the full server suite**

Run: `cd server; npm test` — ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/links.js server/src/app.js server/test/api.test.js
git commit -m "Propagate flight trips through linked days and copy-and-delete"
```

---

### Task 3: Agent — schema, apply, prompt

**Files:**
- Modify: `server/src/ai.js` — schema (after the `hotelStays` field, ~line 107), no-op guard (~line 150), apply (~line 165 + ~line 233 + result ~line 236), `describeUpdate` (~line 284), `systemPrompt` trip facts (~line 385) and rules (after the `Hotel stays:` block, ~line 411), tool `outputSchema` (~line 545)
- Test: append to `server/test/ai.test.js`

**Interfaces:**
- Consumes: `normalizeFlightTrips` from Task 1.
- Produces: tool input accepts `flightTrips` (full replacement); result carries `savedFlightTrips`; prompt embeds current flight trips and the flight rules.

- [ ] **Step 1: Write the failing tests** — append to `server/test/ai.test.js`:

```js
test('applyItineraryUpdate saves flight trips and reports savedFlightTrips', async () => {
  const input = {
    flightTrips: [
      {
        confirmationNumber: 'GK5XPL',
        flights: [
          {
            flightNumber: 'DL1048',
            departureTime: '2026-07-17T15:00',
            arrivalTime: '2026-07-17T18:05',
            seats: [{ class: 'Comfort+', seatNumber: '14E' }],
          },
        ],
      },
    ],
  }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, true)
  assert.equal(result.savedFlightTrips, 1)
  const trip = await storage.readTrip('yellowstone')
  assert.equal(trip.flightTrips[0].flights[0].flightNumber, 'DL1048')
})

test('applyItineraryUpdate clears flight trips with [] and rejects bad input', async () => {
  const cleared = await applyItineraryUpdate({ flightTrips: [] }, { storage, tripId: 'yellowstone' })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.savedFlightTrips, 0)
  const bad = await applyItineraryUpdate(
    { flightTrips: [{ flights: [{ departureTime: '3pm', arrivalTime: '6pm' }] }] },
    { storage, tripId: 'yellowstone' }
  )
  assert.equal(bad.ok, false)
  assert.match(bad.error, /YYYY-MM-DDTHH:MM/)
})

test('systemPrompt embeds flight trips and the flight rules', () => {
  const trip = {
    name: 'X',
    summary: '',
    days: {},
    flightTrips: [
      { confirmationNumber: 'GK5XPL', flights: [{ departureTime: '2026-07-17T15:00', arrivalTime: '2026-07-17T18:05', seats: [] }] },
    ],
  }
  const prompt = systemPrompt(trip)
  assert.match(prompt, /GK5XPL/)
  assert.match(prompt, /one entry per booking/)
  assert.match(prompt, /also add or update an itinerary item on each flight's departure day/)
  assert.match(prompt, /Never invent flight numbers, ticket numbers, or seats/)
  // Without flights the section reads (none)
  assert.match(systemPrompt({ name: 'X', summary: '', days: {} }), /Flight trips[^\n]*\(none\)/)
})

test('compactHistoryForModel describes flight-trip updates', () => {
  const messages = [
    {
      role: 'model',
      content: [
        { toolRequest: { name: 'updateItinerary', ref: '1', input: { flightTrips: [{}, {}] } } },
      ],
    },
    { role: 'tool', content: [{ toolResponse: { name: 'updateItinerary', ref: '1', output: { ok: true } } }] },
    { role: 'model', content: [{ toolRequest: { name: 'updateItinerary', ref: '2', input: {} } }] },
    { role: 'tool', content: [{ toolResponse: { name: 'updateItinerary', ref: '2', output: { ok: true } } }] },
  ]
  const compacted = compactHistoryForModel(messages)
  assert.match(compacted[0].content[0].text, /replaced flight trips \(2\)/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern="flight"` — the apply tests FAIL (no-op guard treats a flightTrips-only update as "no changes"); the prompt/compaction tests FAIL.

- [ ] **Step 3: Implement.** In `server/src/ai.js`:

Import `normalizeFlightTrips` from `./flights.js`.

**Schema** — after the `confirmationNumber` tombstone inside the `hotelStays` item… no: add a NEW top-level field after the whole `hotelStays` array field:

```js
  flightTrips: z
    .array(
      z.object({
        confirmationNumber: z
          .string()
          .optional()
          .describe('Booking confirmation number shared by every flight in this entry, if known'),
        flights: z
          .array(
            z.object({
              flightNumber: z.string().optional().describe('e.g. "DL1048"'),
              departureTime: z
                .string()
                .describe('Local departure date+time, YYYY-MM-DDTHH:MM (ignore timezones)'),
              arrivalTime: z
                .string()
                .describe('Local arrival date+time, YYYY-MM-DDTHH:MM, after departureTime'),
              ticketNumber: z.string().optional().describe('Airline ticket number'),
              seats: z
                .array(
                  z.object({
                    seatNumber: z.string().min(1).describe('e.g. "14E"'),
                    class: z.string().optional().describe('e.g. "Comfort+", "First", "Economy"'),
                  })
                )
                .optional()
                .describe('Seats on this flight; omit when the user gave none'),
            })
          )
          .min(1),
      })
    )
    .optional()
    .describe(
      "Full replacement of the trip's ENTIRE flight-trip list — one entry per booking/confirmation, whose flights array holds every flight on that booking (a round trip is ONE entry with two flights)"
    ),
```

**No-op guard**: add `&& input.flightTrips === undefined` alongside the `hotelStays` check, and extend the guard's error text to `...tripName, summary, hotelStays, and/or flightTrips.` (update the existing no-op test's expected message if it asserts the exact string).

**Apply**: next to the `normalizedStays` block:

```js
  let normalizedFlightTrips = null
  if (input.flightTrips !== undefined) {
    const { flightTrips, error } = normalizeFlightTrips(input.flightTrips)
    if (error) return { ok: false, savedDays: [], removedDays: [], error }
    normalizedFlightTrips = flightTrips
  }
```

and next to `if (normalizedStays) trip.hotelStays = normalizedStays`:

```js
  if (normalizedFlightTrips) trip.flightTrips = normalizedFlightTrips
```

and next to the `savedStays` result line:

```js
  if (normalizedFlightTrips) result.savedFlightTrips = normalizedFlightTrips.length
```

**describeUpdate**:

```js
  if (input.flightTrips) actions.push(`replaced flight trips (${input.flightTrips.length})`)
```

**systemPrompt** trip facts — after the hotel line:

```
- Flight trips (authoritative JSON): ${(trip.flightTrips ?? []).length ? JSON.stringify(trip.flightTrips) : '(none)'}
```

**Prompt rules** — new block after the `Hotel stays:` block:

```
Flights:
- Record flight bookings in flightTrips — a FULL replacement of the whole list; when adding or editing one booking, include every existing flight trip that should remain. One entry per booking: a round trip or multi-city itinerary is ONE entry whose flights array holds each flight.
- departureTime and arrivalTime are local wall-clock date+times (YYYY-MM-DDTHH:MM). Never invent them — ask when the traveler doesn't give them. Ignore timezone differences.
- When adding or changing flights, in the SAME updateItinerary call also add or update an itinerary item on each flight's departure day: timeStart/timeEnd are the departure/arrival clock times, travel: true, a title naming the flight (e.g. "Flight DL1048 to Salt Lake City"), and the confirmation # in the description. Create the day if it doesn't exist yet.
- Ask for the confirmation number, but save the flights without one if the traveler doesn't have it. Never invent flight numbers, ticket numbers, or seats — record them only when the traveler states them.
```

**Tool outputSchema**: add `savedFlightTrips: z.number().optional(),` beside `savedStays`.

- [ ] **Step 4: Run the full server suite**

Run: `cd server; npm test` — ALL PASS (fix the no-op message test if it asserted the old string).

- [ ] **Step 5: Commit**

```bash
git add server/src/ai.js server/test/ai.test.js
git commit -m "Teach the travel agent flight trips with itinerary write-along"
```

---

### Task 4: Client helpers + plane icon

**Files:**
- Create: `client/src/lib/flights.js`, `client/src/lib/flights.test.js`
- Modify: `client/src/components/icons.jsx` (add `PlaneIcon`)

**Interfaces:**
- Produces: `flightDate(dt)`, `flightClock(dt)`, `flightTouchesDay(flight, date)`, `flightsTouchingDay(flightTrips, date)`, `flightTripsTouchingDay(flightTrips, date)`, `validateFlightTrip(ft) → string|null`, `seatClassKind(cls) → 'plus'|'first'|'plain'`; `PlaneIcon({ size })` component.

- [ ] **Step 1: Write the failing tests** — create `client/src/lib/flights.test.js` (match the vitest style of `hotels.test.js`):

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client; npm test` — FAIL (module doesn't exist).

- [ ] **Step 3: Implement** — create `client/src/lib/flights.js`:

```js
// Flight-trip helpers. Times are local wall-clock strings (YYYY-MM-DDTHH:MM);
// timezones are deliberately ignored, so plain string slicing and comparison
// are correct for this format.

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

export const flightDate = (dt) => (dt ?? '').slice(0, 10)
export const flightClock = (dt) => (dt ?? '').slice(11, 16)

// A flight touches a date when it departs OR arrives that day, so an
// overnight flight shows on both tiles.
export function flightTouchesDay(flight, date) {
  return flightDate(flight.departureTime) === date || flightDate(flight.arrivalTime) === date
}

export function flightsTouchingDay(flightTrips, date) {
  return (flightTrips ?? []).flatMap((ft) =>
    (ft.flights ?? []).filter((f) => flightTouchesDay(f, date))
  )
}

export function flightTripsTouchingDay(flightTrips, date) {
  return (flightTrips ?? []).filter((ft) =>
    (ft.flights ?? []).some((f) => flightTouchesDay(f, date))
  )
}

// Returns an error message for the add/edit form, or null when valid.
export function validateFlightTrip(ft) {
  if (!(ft.flights ?? []).length) return 'Add at least one flight.'
  for (const flight of ft.flights) {
    if (!DATETIME_RE.test(flight.departureTime ?? ''))
      return 'Every flight needs a departure date & time.'
    if (!DATETIME_RE.test(flight.arrivalTime ?? ''))
      return 'Every flight needs an arrival date & time.'
    if (flight.arrivalTime <= flight.departureTime) return 'Arrival must be after departure.'
    for (const seat of flight.seats ?? []) {
      if (!seat.seatNumber?.trim()) return 'Every seat needs a seat number.'
    }
  }
  return null
}

// Delta-style chip color: blue for Comfort+/premium-plus cabins, red for
// first class, plain for economy/coach/unknown.
export function seatClassKind(cls) {
  if (/comfort|plus/i.test(cls ?? '')) return 'plus'
  if (/first/i.test(cls ?? '')) return 'first'
  return 'plain'
}
```

- [ ] **Step 4: PlaneIcon.** In `client/src/components/icons.jsx`, add following the file's conventions (`aria-hidden`, size prop). A filled silhouette reads better than strokes at 17px, so this one uses `fill="currentColor"` with no stroke:

```jsx
export function PlaneIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M21.5 15.5v-2l-8.5-5V3a1.5 1.5 0 0 0-3 0v5.5l-8.5 5v2l8.5-2.5v5.2l-2.3 1.7v1.6l3.8-1 3.8 1v-1.6L13 18.7v-5.2l8.5 2z" />
    </svg>
  )
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd client; npm test` — ALL PASS. `npm run build` — clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/flights.js client/src/lib/flights.test.js client/src/components/icons.jsx
git commit -m "Add flight-trip client helpers and plane icon"
```

---

### Task 5: UI — dialogs, day icons, Flights link, CSS

**Files:**
- Modify: `client/src/components/HotelStaysModal.jsx` (export `CopyButton` and `ConfirmationPill`; give `CopyButton` an optional `size` prop passed to `CopyIcon`)
- Create: `client/src/components/FlightsModal.jsx`
- Modify: `client/src/pages/TripPage.jsx`, `client/src/components/DayView.jsx`, `client/src/styles.css`

**Interfaces:**
- Consumes: Task 4 helpers; `CopyButton`/`ConfirmationPill` (newly exported); `Modal.jsx`; `formatDay` from `../lib/dates.js`.
- Produces: `FlightsModal({ flightTrips, linkedFlightTrips, canEdit, onSave, onClose, initialAdd })`, `FlightTripDetail({ flightTrip, canEdit, onSave, onClose })` — `onSave` receives the full replacement array (list modal) / the edited single flight trip (detail modal), matching the hotel components' contracts.

- [ ] **Step 1: Export shared pieces.** In `HotelStaysModal.jsx`: `export function CopyButton({ text, label, size })` (pass `size` to `<CopyIcon size={size} />`, default undefined = icon default) and `export function ConfirmationPill({ value })`. No call-site changes needed.

- [ ] **Step 2: Create `client/src/components/FlightsModal.jsx`:**

```jsx
import { useState } from 'react'
import Modal from './Modal.jsx'
import { CopyButton, ConfirmationPill } from './HotelStaysModal.jsx'
import { PencilIcon, TrashIcon } from './icons.jsx'
import { formatDay } from '../lib/dates.js'
import { flightDate, flightClock, validateFlightTrip, seatClassKind } from '../lib/flights.js'

function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

function dayLabel(date) {
  const { weekday, label } = formatDay(date)
  return `${weekday}, ${label}`
}

// "Fri, Jul 17 · 3:00 PM → 6:05 PM", with the arrival day prefixed when the
// flight lands on a different date (overnight).
function formatFlightTimes(flight) {
  const dep = `${dayLabel(flightDate(flight.departureTime))} · ${to12h(flightClock(flight.departureTime))}`
  const sameDay = flightDate(flight.departureTime) === flightDate(flight.arrivalTime)
  const arr = sameDay
    ? to12h(flightClock(flight.arrivalTime))
    : `${dayLabel(flightDate(flight.arrivalTime))} · ${to12h(flightClock(flight.arrivalTime))}`
  return `${dep} → ${arr}`
}

function SeatChips({ seats }) {
  if (!seats?.length) return null
  return (
    <div className="flight-seats">
      {seats.map((seat, i) => (
        <span
          key={i}
          className={`seat-chip seat-chip-${seatClassKind(seat.class)}`}
          title={seat.class || 'Economy'}
        >
          {seat.seatNumber}
        </span>
      ))}
    </div>
  )
}

function FlightLine({ flight }) {
  return (
    <div className="flight-line">
      <div>
        <span className="flight-number">{flight.flightNumber || 'Flight'}</span>
        <span className="flight-times"> {formatFlightTimes(flight)}</span>
      </div>
      {flight.ticketNumber && (
        <div className="flight-ticket">
          Ticket # {flight.ticketNumber}
          <CopyButton text={flight.ticketNumber} label="Copy ticket number" size={12} />
        </div>
      )}
      <SeatChips seats={flight.seats} />
    </div>
  )
}

// Confirmation pill + all of the booking's flights on one tinted group, so
// the confirmation # and its flights read as a single reservation.
function FlightTripInfo({ flightTrip }) {
  const flights = [...(flightTrip.flights ?? [])].sort((a, b) =>
    a.departureTime.localeCompare(b.departureTime)
  )
  return (
    <div className="flight-trip-group">
      {flightTrip.confirmationNumber ? (
        <ConfirmationPill value={flightTrip.confirmationNumber} />
      ) : (
        <p className="muted hotel-stay-no-conf">No confirmation # on file.</p>
      )}
      {flights.map((flight, i) => (
        <FlightLine key={i} flight={flight} />
      ))}
      {flightTrip.linkedTripName && (
        <p className="muted hotel-stay-source">From “{flightTrip.linkedTripName}” via a linked day</p>
      )}
    </div>
  )
}

const EMPTY_FLIGHT = { flightNumber: '', departureTime: '', arrivalTime: '', ticketNumber: '' }
const EMPTY_SEAT = { class: '', seatNumber: '' }

function FlightTripForm({ initial, onSubmit, onCancel }) {
  const [confirmationNumber, setConfirmationNumber] = useState(initial?.confirmationNumber ?? '')
  const [flights, setFlights] = useState(() => {
    const list = (initial?.flights ?? []).map((f) => ({
      ...EMPTY_FLIGHT,
      ...f,
      seats: (f.seats ?? []).map((s) => ({ ...EMPTY_SEAT, ...s })),
    }))
    return list.length ? list : [{ ...EMPTY_FLIGHT, seats: [] }]
  })
  const [error, setError] = useState('')

  const update = (i, patch) => setFlights(flights.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  const setSeatField = (i, s, field, value) =>
    update(i, { seats: flights[i].seats.map((seat, idx) => (idx === s ? { ...seat, [field]: value } : seat)) })

  function handleSubmit(e) {
    e.preventDefault()
    const flightTrip = {
      confirmationNumber: confirmationNumber.trim(),
      flights: flights.map((f) => ({
        flightNumber: f.flightNumber.trim(),
        departureTime: f.departureTime,
        arrivalTime: f.arrivalTime,
        ticketNumber: f.ticketNumber.trim(),
        // Drop seat rows left entirely blank (stray "+ Add seat" clicks).
        seats: f.seats
          .filter((s) => s.class.trim() || s.seatNumber.trim())
          .map((s) => ({ seatNumber: s.seatNumber.trim(), ...(s.class.trim() ? { class: s.class.trim() } : {}) })),
      })),
    }
    const problem = validateFlightTrip(flightTrip)
    if (problem) return setError(problem)
    onSubmit(flightTrip)
  }

  return (
    <form className="hotel-stay-form" onSubmit={handleSubmit}>
      <label>
        Confirmation # (optional)
        <input type="text" value={confirmationNumber} onChange={(e) => setConfirmationNumber(e.target.value)} />
      </label>
      <div className="conf-editor">
        <span className="conf-editor-title">Flights</span>
        {flights.map((flight, i) => (
          <fieldset key={i} className="conf-block">
            <div className="conf-block-head">
              <label>
                Flight # (e.g. DL1048)
                <input
                  type="text"
                  value={flight.flightNumber}
                  onChange={(e) => update(i, { flightNumber: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn-icon btn-icon-danger"
                title="Remove flight"
                aria-label={`Remove flight ${flight.flightNumber || i + 1}`}
                onClick={() => setFlights(flights.filter((_, idx) => idx !== i))}
              >
                <TrashIcon />
              </button>
            </div>
            <div className="hotel-stay-form-dates">
              <label>
                Departure
                <input
                  type="datetime-local"
                  value={flight.departureTime}
                  onChange={(e) => update(i, { departureTime: e.target.value })}
                  required
                />
              </label>
              <label>
                Arrival
                <input
                  type="datetime-local"
                  value={flight.arrivalTime}
                  min={flight.departureTime || undefined}
                  onChange={(e) => update(i, { arrivalTime: e.target.value })}
                  required
                />
              </label>
            </div>
            <label>
              Ticket # (optional)
              <input
                type="text"
                value={flight.ticketNumber}
                onChange={(e) => update(i, { ticketNumber: e.target.value })}
              />
            </label>
            {flight.seats.map((seat, s) => (
              <div key={s} className="conf-room">
                <input
                  type="text"
                  placeholder="Class (e.g. Comfort+)"
                  aria-label="Seat class"
                  value={seat.class}
                  onChange={(e) => setSeatField(i, s, 'class', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Seat (e.g. 14E)"
                  aria-label="Seat number"
                  value={seat.seatNumber}
                  onChange={(e) => setSeatField(i, s, 'seatNumber', e.target.value)}
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-danger"
                  title="Remove seat"
                  aria-label={`Remove seat ${s + 1}`}
                  onClick={() => update(i, { seats: flight.seats.filter((_, idx) => idx !== s) })}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-link conf-add-btn"
              onClick={() => update(i, { seats: [...flight.seats, { ...EMPTY_SEAT }] })}
            >
              + Add seat
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="btn btn-link conf-add-btn"
          onClick={() => setFlights([...flights, { ...EMPTY_FLIGHT, seats: [] }])}
        >
          + Add flight
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small">
          Save Flights
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// All of a trip's flight trips. onSave receives the full replacement array
// (flight trips live at the trip level).
export function FlightsModal({
  flightTrips,
  linkedFlightTrips = [], // read-only: owned by trips linked from here
  canEdit,
  onSave,
  onClose,
  initialAdd = false,
}) {
  // null = list view; -1 = adding; >= 0 = editing that index
  const [editing, setEditing] = useState(initialAdd ? -1 : null)
  const [error, setError] = useState('')
  const earliest = (ft) =>
    (ft.flights ?? []).reduce((min, f) => (min && min < f.departureTime ? min : f.departureTime), '')
  const sorted = [
    ...flightTrips.map((ft, index) => ({ ft, index })),
    ...linkedFlightTrips.map((ft) => ({ ft, index: null })),
  ]
  sorted.sort((a, b) => earliest(a.ft).localeCompare(earliest(b.ft)))

  async function save(next) {
    setError('')
    try {
      await onSave(next)
      setEditing(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title="Flights" onClose={onClose}>
      {editing !== null ? (
        <FlightTripForm
          initial={editing >= 0 ? flightTrips[editing] : null}
          onSubmit={(ft) => {
            const next = [...flightTrips]
            if (editing >= 0) next[editing] = ft
            else next.push(ft)
            save(next)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          {sorted.length === 0 && (
            <p className="muted hotel-stays-empty">
              No flights yet{canEdit ? ' — add your first booking below.' : '.'}
            </p>
          )}
          <ul className="hotel-stay-list">
            {sorted.map(({ ft, index }, i) => (
              <li key={index ?? `linked-${i}`} className="hotel-stay-card">
                <div className="hotel-stay-info">
                  <FlightTripInfo flightTrip={ft} />
                </div>
                {canEdit && index !== null && (
                  <div className="hotel-stay-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      title="Edit flights"
                      aria-label={`Edit flight trip ${ft.confirmationNumber || index + 1}`}
                      onClick={() => setEditing(index)}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className="btn-icon btn-icon-danger"
                      title="Delete flights"
                      aria-label={`Delete flight trip ${ft.confirmationNumber || index + 1}`}
                      onClick={() => {
                        if (window.confirm('Delete this flight trip?'))
                          save(flightTrips.filter((_, idx) => idx !== index))
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="error">{error}</p>}
          {canEdit && (
            <button type="button" className="btn btn-primary btn-small" onClick={() => setEditing(-1)}>
              Add Flight Trip
            </button>
          )}
        </>
      )}
    </Modal>
  )
}

// Single flight trip opened from a day's plane icon. Own flight trips can be
// edited in place; linked ones are read-only (they belong to the linked trip).
export function FlightTripDetail({ flightTrip, canEdit = false, onSave, onClose }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')

  async function save(ft) {
    setError('')
    try {
      await onSave(ft)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title="Flights" onClose={onClose}>
      {editing ? (
        <>
          <FlightTripForm initial={flightTrip} onSubmit={save} onCancel={() => setEditing(false)} />
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <div className="hotel-stay-info hotel-stay-detail">
          {canEdit && (
            <div className="flight-detail-actions">
              <button
                type="button"
                className="btn-icon"
                title="Edit flights"
                aria-label="Edit flights"
                onClick={() => setEditing(true)}
              >
                <PencilIcon />
              </button>
            </div>
          )}
          <FlightTripInfo flightTrip={flightTrip} />
        </div>
      )}
    </Modal>
  )
}
```

- [ ] **Step 3: TripPage wiring.** In `client/src/pages/TripPage.jsx`:

Imports: `FlightsModal, FlightTripDetail` from `../components/FlightsModal.jsx`; `PlaneIcon` added to the icons import; `flightTripsTouchingDay` from `../lib/flights.js`.

State next to `hotelModal`:

```js
  // null | {type:'list'} | {type:'add'} | {type:'trip', ft, index}
  // (index points into trip.flightTrips; -1 for read-only linked trips)
  const [flightModal, setFlightModal] = useState(null)
```

Derivations after `allStays` (~line 208):

```js
  const flightTrips = trip.flightTrips ?? []
  // Flight trips carried in by ANY linked day participate trip-wide, deduped.
  const linkedFlightTrips = []
  const seenFlightTrips = new Set()
  for (const d of Object.values(trip.days ?? {})) {
    for (const ft of d.linkedFlightTrips ?? []) {
      const key = `${ft.confirmationNumber ?? ''}|${(ft.flights ?? [])
        .map((f) => `${f.flightNumber ?? ''}@${f.departureTime}`)
        .join(',')}`
      if (seenFlightTrips.has(key)) continue
      seenFlightTrips.add(key)
      linkedFlightTrips.push(ft)
    }
  }
  const allFlightTrips = [...flightTrips, ...linkedFlightTrips]
```

Day tiles — inside the `hotelMarks` span block (~line 259-274): compute `const dayFlightTrips = flightTripsTouchingDay(allFlightTrips, date)` next to `hotelMarks`, change the render condition to `(hotelMarks.length > 0 || dayFlightTrips.length > 0)` and append after the hotel-mark buttons:

```jsx
                    {dayFlightTrips.map((ft, j) => (
                      <button
                        key={`f${j}`}
                        type="button"
                        className="day-nav-hotel-icon flight-icon"
                        title={`Flights${ft.confirmationNumber ? ` — ${ft.confirmationNumber}` : ''}`}
                        aria-label={`Flights on this day${ft.confirmationNumber ? ` — confirmation ${ft.confirmationNumber}` : ''}`}
                        onClick={() => setFlightModal({ type: 'trip', ft, index: flightTrips.indexOf(ft) })}
                      >
                        <PlaneIcon size={17} />
                      </button>
                    ))}
```

DayView props (~line 291): add

```jsx
            flightTrips={flightTripsTouchingDay(allFlightTrips, selectedDate)}
            onOpenFlightTrip={(ft) => setFlightModal({ type: 'trip', ft, index: flightTrips.indexOf(ft) })}
```

Flights link — right after the "Hotel stays" button in `.trip-dates-line` (~line 340), same visibility pattern:

```jsx
            {dates.length > 0 && (canEdit || allFlightTrips.length > 0) && (
              <button type="button" className="btn btn-link" onClick={() => setFlightModal({ type: 'list' })}>
                Flights
              </button>
            )}
```

(Match the hotel link's label style — if it renders a count, add ` ({allFlightTrips.length})` the same way.)

Modals at page root, after the hotel modals:

```jsx
      {(flightModal?.type === 'list' || flightModal?.type === 'add') && (
        <FlightsModal
          flightTrips={flightTrips}
          linkedFlightTrips={linkedFlightTrips}
          canEdit={canEdit}
          initialAdd={flightModal.type === 'add'}
          onSave={(next) => saveTrip({ flightTrips: next })}
          onClose={() => setFlightModal(null)}
        />
      )}
      {flightModal?.type === 'trip' && (
        <FlightTripDetail
          flightTrip={
            flightModal.index >= 0 ? (flightTrips[flightModal.index] ?? flightModal.ft) : flightModal.ft
          }
          canEdit={canEdit && flightModal.index >= 0}
          onSave={(ft) => {
            const next = [...flightTrips]
            next[flightModal.index] = ft
            return saveTrip({ flightTrips: next })
          }}
          onClose={() => setFlightModal(null)}
        />
      )}
```

- [ ] **Step 4: DayView header icons.** In `client/src/components/DayView.jsx`: add props `flightTrips = []`, `onOpenFlightTrip`; import `PlaneIcon`; after the `hotelMarks.map(...)` buttons in `.day-title-row` (~line 78), add:

```jsx
            {flightTrips.map((ft, i) => (
              <button
                key={`f${i}`}
                type="button"
                className="btn-icon day-hotel-icon flight-icon"
                title={`Flights${ft.confirmationNumber ? ` — ${ft.confirmationNumber}` : ''}`}
                aria-label={`Flights on this day${ft.confirmationNumber ? ` — confirmation ${ft.confirmationNumber}` : ''}`}
                onClick={() => onOpenFlightTrip?.(ft)}
              >
                <PlaneIcon size={25} />
              </button>
            ))}
```

- [ ] **Step 5: CSS.** Append to `client/src/styles.css` after the hotel-stay rules:

```css
/* Flights */
.flight-icon {
  color: var(--primary);
}

/* Same tinted-group treatment as hotel confirmations: the confirmation #
   and its flights read as one reservation. */
.flight-trip-group {
  margin: 0.2rem 0 0;
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.flight-trip-group .hotel-stay-conf-row {
  margin: 0;
}

.flight-line {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.flight-number {
  font-weight: 650;
}
.flight-times {
  color: var(--ink-soft);
  font-size: 0.9rem;
}
.flight-ticket {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: var(--ink-soft);
}
.flight-ticket .btn-icon {
  padding: 0.05rem;
}

.flight-seats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.seat-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: Consolas, 'Courier New', monospace;
  font-weight: 700;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  border: 1px solid transparent;
}
.seat-chip-plus {
  background: #1a66b3;
  color: #fff;
}
.seat-chip-first {
  background: var(--danger);
  color: #fff;
}
.seat-chip-plain {
  border-color: var(--line);
  color: var(--ink);
}

.flight-detail-actions {
  display: flex;
  justify-content: flex-end;
}
```

- [ ] **Step 6: Build and unit-test**

Run: `cd client; npm test` then `npm run build` — ALL PASS, clean build.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/HotelStaysModal.jsx client/src/components/FlightsModal.jsx client/src/pages/TripPage.jsx client/src/components/DayView.jsx client/src/styles.css
git commit -m "Add flights UI: day icons, Flights link, list and detail dialogs"
```

---

### Task 6: Browser verification (fake-agent server)

**Files:**
- Create: `<scratchpad>/flight-check.mjs` (session scratchpad, not the repo)

**Interfaces:**
- Consumes: built client, `verify-server.mjs` pattern (port 3199, fresh `DATA_DIR`, Playwright `channel: 'msedge'`), `conf-check.mjs` as the structural model.

- [ ] **Step 1: Write the script.** Checks, in order:

1. Seed (API): trip with days `2026-07-17`..`2026-07-19`; one flight trip: conf `GK5XPL`, flight 1 DL1048 `2026-07-17T15:00 → 2026-07-17T18:05` seats `[Comfort+ 14E, Comfort+ 14C]` ticket `0062341987654`; flight 2 DL2210 overnight `2026-07-18T23:30 → 2026-07-19T05:45` seat `[First 2A]`. GET round-trips it.
2. Day tiles: plane icon (`.day-nav-hotel-icons .flight-icon`) present on Jul 17, Jul 18 AND Jul 19 (overnight touches both), absent from none-flight days.
3. "Flights" link visible right of "Hotel stays"; opens list modal showing the conf pill `GK5XPL`, flight lines `DL1048`/`DL2210`, ticket # text with a copy button.
4. Seat chips: `.seat-chip-plus` count is 2 (14E, 14C), `.seat-chip-first` count is 1 (2A); a chip with class Economy would be `.seat-chip-plain` (add a third seat via edit later to assert).
5. Day header (select Jul 17): plane icon next to hotel icons; click → detail modal shows pill + DL1048.
6. Detail pencil edit: add seat `Economy 21C` to flight 1, save → GET shows 3 seats; reopened detail shows `.seat-chip-plain` for 21C.
7. Validation: edit, blank flight 1's departure time, save → error matches `/departure/i`, nothing saved.
8. Delete via list modal trash → GET shows `flightTrips: []` and day icons gone.

- [ ] **Step 2: Run it** (build client first). All checks `ok`, exit 0.

- [ ] **Step 3: Regression sweeps** — `verify.mjs` (54), `hotel-check.mjs` (29), `link-check.mjs` (35), `share-link-check.mjs` (16), `conf-check.mjs` (11), `edit-detail-check.mjs` (5) — all green.

- [ ] **Step 4: Commit** only if repo fixes were needed (`git add -A; git commit -m "Fix issues found in flight browser verification"`), else nothing.

---

### Task 7: Live agent smoke (real API key)

**Files:**
- Create: `<scratchpad>/flights-smoke.mjs`

**Interfaces:**
- Consumes: real server on port 3197 (start with throwaway `DATA_DIR`; key auto-loads from `server/.env`), `rooms-smoke.mjs` request pattern, model `anthropic/claude-sonnet-4-5`.

- [ ] **Step 1: Write the script.** Fresh trip with days `2026-07-17`..`2026-07-19` (empty). Three turns:

1. "Add our flights: DL1048 departing July 17 at 3:00 PM arriving 6:05 PM, and the return DL2210 on July 19 from 7:30 PM to 10:45 PM. Confirmation GK5XPL. Seats 14E and 14C in Comfort+ on both flights." → assert one flight trip, two flights with the right datetimes, both with 2 Comfort+ seats; AND itinerary items exist on `2026-07-17` and `2026-07-19` with `timeStart`/`timeEnd` `15:00/18:05` and `19:30/22:45`, `travel: true`, description containing `GK5XPL`.
2. "Add ticket number 0062341987654 to the DL1048 flight." → that flight gains the ticketNumber; everything else untouched.
3. "We're also flying to Denver on July 18, departing 9am." (no arrival time) → assert flightTrips unchanged and the reply asks about arrival (match `/arriv/i`).

- [ ] **Step 2: Run it** (restart/start the 3197 server first so Tasks 1-3 are loaded). Expected `FLIGHTS SMOKE PASS`.

- [ ] **Step 3: Full-suite final check** — `cd server; npm test` and `cd client; npm test` green; commit any smoke-driven fixes, else nothing.
