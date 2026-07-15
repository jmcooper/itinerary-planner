# Multi-Confirmation Hotel Stays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each hotel stay holds multiple confirmations, each with optional room details (roomType/guests/notes), editable via the UI and the travel agent.

**Architecture:** The stay-level `confirmationNumber` string becomes a `confirmations: [{ confirmationNumber, rooms: [...] }]` array. A one-time converter in the existing startup migration (`migrateDataDir`, which backs up originals) rewrites stored trips; after that, all runtime code — `normalizeHotelStays`, the client, the agent — handles **only** the new shape. A legacy `confirmationNumber` key on input is rejected with a clear error, never silently dropped.

**Tech Stack:** Node/Express + node:test/supertest (server), React/Vite + vitest (client), Genkit + zod (agent), Playwright (browser verification).

**Spec:** `docs/superpowers/specs/2026-07-15-multi-confirmation-hotel-stays-design.md`

## Global Constraints

- `confirmationNumber` is required (non-empty) per confirmation entry; a stay may have **zero** confirmations.
- `rooms` optional on input/may be empty; storage always writes `rooms` (possibly `[]`). `roomType`, `guests`, `notes` optional strings; empty optional fields are omitted from storage.
- `hotelAddress` stays optional everywhere (unchanged).
- One-time startup migration converts stored data; runtime code supports ONLY the new shape. Legacy `confirmationNumber` on API/tool input → validation error, not silent stripping.
- `hotelStays` remains a FULL-replacement list in both REST PUT and the agent tool.
- The dev server runs without `--watch`: restart `node src/index.js` after server edits before browser/live verification (the restart also runs the migration).

---

### Task 1: Startup migration + new-shape-only normalization

**Files:**
- Modify: `server/src/migrate.js` (add `migrateHotelStays`, wire into `migrateDataDir`)
- Modify: `server/src/hotels.js` (whole file, 37 lines)
- Create: `server/test/hotels.test.js`
- Modify: `server/test/migrate.test.js` (new migration tests), `server/test/api.test.js:274-320` (send/expect new shape), `server/test/ai.test.js:159-187` (stayInput → new shape)

**Interfaces:**
- Produces: `migrateHotelStays(trip) → boolean` (true if the trip changed) exported from `server/src/migrate.js`. `normalizeHotelStays(input) → { stays } | { error }` (unchanged signature); every emitted stay has `confirmations: [{ confirmationNumber: string, rooms: [{ roomType?, guests?, notes? }] }]`; a stay input carrying a `confirmationNumber` key returns `{ error: 'confirmationNumber has been replaced by confirmations' }`.

- [ ] **Step 1: Write the failing migration tests** — append to `server/test/migrate.test.js`:

```js
test('migrateDataDir converts legacy hotel-stay confirmation numbers', async () => {
  const trip = {
    id: 'hotel-trip',
    name: 'Hotels',
    days: {},
    hotelStays: [
      {
        hotelName: 'Holiday Inn',
        hotelAddress: '315 Yellowstone Ave',
        checkInDay: '2026-07-17',
        checkOutDay: '2026-07-18',
        confirmationNumber: ' ABC123 ',
      },
      { hotelName: 'No Conf Inn', hotelAddress: '', checkInDay: '2026-07-18', checkOutDay: '2026-07-19' },
    ],
  }
  await writeFile(path.join(dataDir, 'hotel-trip.json'), JSON.stringify(trip))

  const result = await migrateDataDir(dataDir)
  assert.equal(result.migrated, 1)

  const migrated = JSON.parse(await readFile(path.join(dataDir, 'hotel-trip.json'), 'utf8'))
  assert.deepEqual(migrated.hotelStays[0].confirmations, [
    { confirmationNumber: 'ABC123', rooms: [] },
  ])
  assert.ok(!('confirmationNumber' in migrated.hotelStays[0]))
  assert.deepEqual(migrated.hotelStays[1].confirmations, [])

  // Second run is a no-op (idempotent)
  assert.equal((await migrateDataDir(dataDir)).migrated, 0)
})

test('migrateDataDir leaves new-shape hotel stays untouched', async () => {
  const trip = {
    id: 'new-shape',
    name: 'New',
    days: {},
    hotelStays: [
      {
        hotelName: 'Canyon Lodge',
        hotelAddress: '',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-19',
        confirmations: [{ confirmationNumber: 'X1', rooms: [{ roomType: 'Cabin' }] }],
      },
    ],
  }
  await writeFile(path.join(dataDir, 'new-shape.json'), JSON.stringify(trip))
  assert.equal((await migrateDataDir(dataDir)).migrated, 0)
})
```

- [ ] **Step 2: Write the failing normalization tests** — create `server/test/hotels.test.js`:

```js
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cd server; npm test` — expect the new tests FAIL (`migrateHotelStays` doesn't exist; `confirmations` is undefined on output stays).

- [ ] **Step 4: Implement the migration.** In `server/src/migrate.js`, add after `normalizeTripShape`:

```js
// Converts legacy hotel stays ({ confirmationNumber: string }) to the
// multi-confirmation shape ({ confirmations: [{ confirmationNumber, rooms }] }).
// Returns true if the trip changed.
export function migrateHotelStays(trip) {
  let changed = false
  for (const stay of trip.hotelStays ?? []) {
    if (typeof stay !== 'object' || stay === null) continue
    if (Array.isArray(stay.confirmations) && !('confirmationNumber' in stay)) continue
    const conf = typeof stay.confirmationNumber === 'string' ? stay.confirmationNumber.trim() : ''
    stay.confirmations = conf ? [{ confirmationNumber: conf, rooms: [] }] : []
    delete stay.confirmationNumber
    changed = true
  }
  return changed
}
```

Wire it into `migrateDataDir` (line 68-70):

```js
    const itemsChanged = migrateTripDays(trip)
    const shapeChanged = normalizeTripShape(trip)
    const staysChanged = migrateHotelStays(trip)
    if (!itemsChanged && !shapeChanged && !staysChanged) continue
```

Note `migrateHotelStays` also sets `confirmations: []` on stays that have *neither* key — that is intentional (one uniform shape on disk) and is what the idempotence test exercises.

- [ ] **Step 5: Implement normalization.** Replace the body of `server/src/hotels.js` with:

```js
// Hotel-stay validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A stay covers checkInDay (inclusive) through
// checkOutDay (exclusive) — the check-out day itself needs its own stay.
//
// Each stay carries confirmations: [{ confirmationNumber, rooms }]. The
// legacy single confirmationNumber string was converted by the startup
// migration (server/src/migrate.js); on input it is an explicit error so
// stale clients can't silently lose data.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const ROOM_FIELDS = ['roomType', 'guests', 'notes']

// Validates one confirmations array. Returns { confirmations } or { error }.
function normalizeConfirmations(input) {
  if (!Array.isArray(input)) return { error: 'confirmations must be an array' }
  const confirmations = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each confirmation must be an object' }
    const confirmationNumber =
      typeof raw.confirmationNumber === 'string' ? raw.confirmationNumber.trim() : ''
    if (!confirmationNumber) return { error: 'each confirmation needs a confirmationNumber' }
    const rooms = []
    if (raw.rooms != null) {
      if (!Array.isArray(raw.rooms)) return { error: 'rooms must be an array' }
      for (const rawRoom of raw.rooms) {
        if (typeof rawRoom !== 'object' || rawRoom === null)
          return { error: 'each room must be an object' }
        const room = {}
        for (const field of ROOM_FIELDS) {
          if (rawRoom[field] != null && typeof rawRoom[field] !== 'string')
            return { error: `room ${field} must be a string` }
          const value = (rawRoom[field] ?? '').trim()
          if (value) room[field] = value
        }
        rooms.push(room)
      }
    }
    confirmations.push({ confirmationNumber, rooms })
  }
  return { confirmations }
}

// Validates and normalizes a hotel-stays payload. Returns { stays } on
// success or { error } on the first problem. Only known fields are kept
// (trimmed), so junk can't accumulate in the trip JSON.
export function normalizeHotelStays(input) {
  if (!Array.isArray(input)) return { error: 'hotelStays must be an array' }
  const stays = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null)
      return { error: 'each hotel stay must be an object' }
    if ('confirmationNumber' in raw)
      return { error: 'confirmationNumber has been replaced by confirmations' }
    const hotelName = typeof raw.hotelName === 'string' ? raw.hotelName.trim() : ''
    if (!hotelName) return { error: 'each hotel stay needs a hotelName' }
    if (raw.hotelAddress != null && typeof raw.hotelAddress !== 'string')
      return { error: 'hotelAddress must be a string' }
    if (!DAY_RE.test(raw.checkInDay ?? '') || !DAY_RE.test(raw.checkOutDay ?? ''))
      return { error: 'checkInDay and checkOutDay must be YYYY-MM-DD dates' }
    if (raw.checkOutDay <= raw.checkInDay)
      return { error: 'checkOutDay must be after checkInDay' }
    const stay = {
      hotelName,
      hotelAddress: (raw.hotelAddress ?? '').trim(),
      checkInDay: raw.checkInDay,
      checkOutDay: raw.checkOutDay,
    }
    if (raw.confirmations != null) {
      const { confirmations, error } = normalizeConfirmations(raw.confirmations)
      if (error) return { error }
      stay.confirmations = confirmations
    } else {
      stay.confirmations = []
    }
    stays.push(stay)
  }
  return { stays }
}
```

- [ ] **Step 6: Update existing tests to the new shape.**

In `server/test/api.test.js`, rewrite `PUT /api/trips/:id round-trips hotelStays with normalization` (lines 274-303) to send and expect the new shape:

```js
test('PUT /api/trips/:id round-trips hotelStays with normalization', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Hotel Trip' })
  const id = created.body.id
  const res = await alice.put(`/api/trips/${id}`).send({
    hotelStays: [
      {
        hotelName: '  Holiday Inn  ',
        hotelAddress: ' 315 Yellowstone Ave ',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-21',
        confirmations: [
          { confirmationNumber: ' ABC123 ', rooms: [{ roomType: ' 2 Queens ', guests: 'Jim & Kathy', notes: '' }] },
        ],
        junkField: 'dropped',
      },
      { hotelName: 'No Conf Inn', checkInDay: '2026-07-21', checkOutDay: '2026-07-22' },
    ],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.hotelStays, [
    {
      hotelName: 'Holiday Inn',
      hotelAddress: '315 Yellowstone Ave',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmations: [
        { confirmationNumber: 'ABC123', rooms: [{ roomType: '2 Queens', guests: 'Jim & Kathy' }] },
      ],
    },
    {
      hotelName: 'No Conf Inn',
      hotelAddress: '',
      checkInDay: '2026-07-21',
      checkOutDay: '2026-07-22',
      confirmations: [],
    },
  ])
  const fetched = await alice.get(`/api/trips/${id}`)
  assert.equal(fetched.body.hotelStays.length, 2)
})
```

In `PUT /api/trips/:id rejects invalid hotelStays` (line 308-315), replace the legacy-typed case `confirmationNumber: 7` with legacy-key and new-shape bad cases:

```js
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmationNumber: 'ABC' }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmations: [{}] }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmations: [{ confirmationNumber: 'A', rooms: [{ guests: 5 }] }] }] },
```

In `server/test/ai.test.js`, rewrite `stayInput` (lines 159-169) to the new shape and fix the round-trip assertion (line 177):

```js
const stayInput = () => ({
  hotelStays: [
    {
      hotelName: 'Holiday Inn West Yellowstone',
      hotelAddress: '315 Yellowstone Ave, West Yellowstone, MT',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }],
    },
  ],
})
```

```js
  assert.deepEqual(trip.hotelStays, stayInput().hotelStays)
```

(The deepEqual keeps working because `stayInput()` is already fully normalized.) Also update the `systemPrompt embeds hotel stays` test (line 527-535): change the trip's stay to
`confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }]` in place of `confirmationNumber: 'ABC123'` — the `ABC123` regex assertion then still passes.

- [ ] **Step 7: Run the full server suite**

Run: `cd server; npm test` — expect ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/migrate.js server/src/hotels.js server/test/hotels.test.js server/test/migrate.test.js server/test/api.test.js server/test/ai.test.js
git commit -m "Migrate hotel stays to multi-confirmation shape at startup"
```

---

### Task 2: Client validation for confirmation blocks

**Files:**
- Modify: `client/src/lib/hotels.js` (extend `validateStay`)
- Test: `client/src/lib/hotels.test.js`

**Interfaces:**
- Produces: `validateStay(stay)` additionally returns `'Every confirmation needs a confirmation #.'` when any entry in `stay.confirmations` has a blank `confirmationNumber`. No other helper changes; display code reads `stay.confirmations ?? []` directly.

- [ ] **Step 1: Write the failing tests** — append to `client/src/lib/hotels.test.js` (match the file's existing vitest style; it already imports `validateStay`):

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd client; npm test` — expect the blank-# test to FAIL (validateStay returns null today).

- [ ] **Step 3: Implement** — in `client/src/lib/hotels.js`, extend `validateStay`:

```js
export function validateStay(stay) {
  if (!stay.hotelName?.trim()) return 'Enter the hotel name.'
  if (!DATE_RE.test(stay.checkInDay ?? '')) return 'Choose a check-in date.'
  if (!DATE_RE.test(stay.checkOutDay ?? '')) return 'Choose a check-out date.'
  if (stay.checkOutDay <= stay.checkInDay) return 'Check-out must be after check-in.'
  for (const conf of stay.confirmations ?? []) {
    if (!conf.confirmationNumber?.trim()) return 'Every confirmation needs a confirmation #.'
  }
  return null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd client; npm test` — expect ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/hotels.js client/src/lib/hotels.test.js
git commit -m "Validate confirmation blocks in stay validation"
```

---

### Task 3: Agent — tool schema and prompt rules

**Files:**
- Modify: `server/src/ai.js:70-85` (schema), `server/src/ai.js:373-378` (prompt hotel rules)
- Test: `server/test/ai.test.js`

**Interfaces:**
- Consumes: Task 1's `normalizeHotelStays` (already wired into `applyItineraryUpdate` — no apply-code change needed).
- Produces: tool input stays accept `confirmations`; a legacy `confirmationNumber` passes the zod schema (deprecation tombstone) and is rejected by `normalizeHotelStays` with a clear retry message — never silently stripped.

- [ ] **Step 1: Write the failing tests** — append to `server/test/ai.test.js` after the existing stay tests (after line 187):

```js
test('applyItineraryUpdate saves confirmations with rooms', async () => {
  const input = {
    hotelStays: [
      {
        hotelName: 'Canyon Lodge & Cabins',
        hotelAddress: '41 Clover Ln, Yellowstone National Park, WY',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-19',
        confirmations: [
          {
            confirmationNumber: '20869678',
            rooms: [{ roomType: 'Western Cabin', guests: 'Jim & Kathy' }],
          },
          { confirmationNumber: '20871144' },
        ],
      },
    ],
  }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, true)
  const trip = await storage.readTrip('yellowstone')
  assert.deepEqual(trip.hotelStays[0].confirmations, [
    {
      confirmationNumber: '20869678',
      rooms: [{ roomType: 'Western Cabin', guests: 'Jim & Kathy' }],
    },
    { confirmationNumber: '20871144', rooms: [] },
  ])
})

test('applyItineraryUpdate rejects the legacy confirmationNumber key with a hint', async () => {
  const input = {
    hotelStays: [
      {
        hotelName: 'Canyon Lodge & Cabins',
        hotelAddress: '',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-19',
        confirmationNumber: '20869678',
      },
    ],
  }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, false)
  assert.match(result.error, /replaced by confirmations/)
})

test('systemPrompt states the confirmation/room rules', () => {
  const prompt = systemPrompt({ name: 'X', summary: '', days: {} })
  assert.match(prompt, /one entry per confirmation number/)
  assert.match(prompt, /ask whether it goes under an existing one/)
  assert.match(prompt, /never invent them/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern="confirmation"` — the two apply tests PASS already (normalizeHotelStays does the work); the prompt test FAILS. Confirm exactly that split.

- [ ] **Step 3: Update the tool schema.** In `server/src/ai.js`, replace line 81 (`confirmationNumber: z.string().optional()...`) inside the `hotelStays` item object with:

```js
        confirmations: z
          .array(
            z.object({
              confirmationNumber: z.string().min(1).describe('Booking confirmation number'),
              rooms: z
                .array(
                  z.object({
                    roomType: z
                      .string()
                      .optional()
                      .describe('Room type/description, e.g. "2 Queen Beds, Lake View"'),
                    guests: z.string().optional().describe('Who is staying in this room'),
                    notes: z.string().optional().describe('Anything else about this room'),
                  })
                )
                .optional()
                .describe('Rooms booked under this confirmation; omit when the user gave no room details'),
            })
          )
          .optional()
          .describe(
            'All reservations for this stay — one entry per confirmation number, each with its rooms'
          ),
        // Deprecation tombstone: kept in the schema so an old-shape tool call
        // (imitated from replayed chat history) reaches normalizeHotelStays
        // and gets a clear rejection back instead of zod silently stripping
        // the unknown key and losing the number.
        confirmationNumber: z
          .string()
          .optional()
          .describe('DEPRECATED — do not use; put numbers in confirmations'),
```

- [ ] **Step 4: Update the prompt hotel rules.** Replace the `Hotel stays:` block (`server/src/ai.js:373-378`) with:

```
Hotel stays:
- Record a hotel stay whenever the user mentions a hotel booking. hotelStays is a FULL replacement of the whole list — when adding or editing one stay, include every existing stay that should remain.
- A stay covers checkInDay (inclusive) through checkOutDay (exclusive): the check-out day's night needs its own stay. The app warns on days not covered by any stay.
- A stay can have multiple reservations: list them in confirmations, one entry per confirmation number, each with its rooms. When the user gives several confirmation numbers and room details in one message, save them all in a single tool call.
- Adding a room to an existing stay means re-sending that stay with the room appended under its confirmation. Every room lives under a confirmation: if the user doesn't say which confirmation a new room belongs to, ask whether it goes under an existing one (name them) or a new one — and get the new number before saving.
- Room details (roomType, guests, notes) are optional: save them only when the user states them; never invent them and don't press for them.
- Never invent a check-in date, check-out date, or confirmation number. If any of them is missing from the user's request, ask for it before saving the stay. If the user says they don't have a confirmation number yet, save the stay without one.
- When the user doesn't provide the hotel's address, fill it in yourself — never leave it empty. The address only feeds a Google Maps search, so it does not need to be a verified street address: give the street address if you know it, otherwise use "<hotel name>, <city, state/region>", which Maps resolves fine. State what you used in your reply so the user can correct it.
- Set a day's hotelNotNeeded: true only when the user says no hotel is needed that night (e.g. a red-eye flight, staying with friends, the trip's final night at home).
```

- [ ] **Step 5: Run the full server suite**

Run: `cd server; npm test` — expect ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/ai.js server/test/ai.test.js
git commit -m "Teach the travel agent multi-confirmation stays with rooms"
```

---

### Task 4: UI — confirmations editor and per-confirmation display

**Files:**
- Modify: `client/src/components/HotelStaysModal.jsx`, `client/src/pages/TripPage.jsx:201`, `client/src/styles.css`

**Interfaces:**
- Consumes: `validateStay` from `client/src/lib/hotels.js` (Task 2); stays from the API always carry `confirmations` (Task 1's migration + normalization).
- Produces: `StayForm` submits stays shaped `{ hotelName, hotelAddress, checkInDay, checkOutDay, confirmations }` — the legacy `confirmationNumber` key never appears in saved payloads.

- [ ] **Step 1: Rework display components.** In `HotelStaysModal.jsx`, replace the `ConfirmationNumber` component with:

```jsx
// The whole pill is a button: clicking anywhere on it copies the number.
function ConfirmationPill({ value }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="hotel-stay-conf-row">
      <button
        type="button"
        className="hotel-stay-conf-pill"
        title="Copy confirmation number"
        aria-label={`Copy confirmation number ${value}`}
        onClick={() => {
          navigator.clipboard?.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        <span className="hotel-stay-conf-label">Confirmation #</span>
        <span className="hotel-stay-conf">
          {value}
          <span className="hotel-stay-conf-copy" aria-hidden="true">
            {copied ? '✓' : <CopyIcon />}
          </span>
        </span>
      </button>
    </div>
  )
}

function RoomList({ rooms }) {
  if (!rooms?.length) return null
  return (
    <ul className="hotel-stay-rooms">
      {rooms.map((room, i) => (
        <li key={i}>
          <span className="hotel-stay-room-type">{room.roomType || 'Room'}</span>
          {room.guests && <span> — {room.guests}</span>}
          {room.notes && <span className="muted"> · {room.notes}</span>}
        </li>
      ))}
    </ul>
  )
}

// One pill per confirmation, its rooms listed beneath. showEmpty renders a
// muted placeholder when nothing is on file (detail modal only).
function ConfirmationList({ stay, showEmpty = false }) {
  const confirmations = stay.confirmations ?? []
  if (!confirmations.length) {
    return showEmpty ? <p className="muted hotel-stay-no-conf">No confirmation # on file.</p> : null
  }
  return confirmations.map((conf, i) => (
    <div key={i} className="hotel-stay-conf-group">
      <ConfirmationPill value={conf.confirmationNumber} />
      <RoomList rooms={conf.rooms} />
    </div>
  ))
}
```

Update the two call sites: `StayInfo` uses `<ConfirmationList stay={stay} />` (replacing `<ConfirmationNumber value={stay.confirmationNumber} />`) and `HotelStayDetail` uses `<ConfirmationList stay={stay} showEmpty />`.

- [ ] **Step 2: Rework the form.** Replace `EMPTY_FORM` and `StayForm` with:

```jsx
const EMPTY_FORM = { hotelName: '', hotelAddress: '', checkInDay: '', checkOutDay: '' }
const EMPTY_ROOM = { roomType: '', guests: '', notes: '' }

// Editable confirmation blocks, each with its nested room rows. Controlled:
// parent owns the array, this renders inputs and add/remove buttons.
function ConfirmationsEditor({ confirmations, onChange }) {
  const update = (i, patch) =>
    onChange(confirmations.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  const setRoomField = (i, r, field, value) =>
    update(i, {
      rooms: confirmations[i].rooms.map((room, idx) =>
        idx === r ? { ...room, [field]: value } : room
      ),
    })
  return (
    <div className="conf-editor">
      <span className="conf-editor-title">Confirmations</span>
      {confirmations.map((conf, i) => (
        <fieldset key={i} className="conf-block">
          <div className="conf-block-head">
            <label>
              Confirmation #
              <input
                type="text"
                value={conf.confirmationNumber}
                onChange={(e) => update(i, { confirmationNumber: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn-icon btn-icon-danger"
              title="Remove confirmation"
              aria-label={`Remove confirmation ${conf.confirmationNumber || i + 1}`}
              onClick={() => onChange(confirmations.filter((_, idx) => idx !== i))}
            >
              <TrashIcon />
            </button>
          </div>
          {conf.rooms.map((room, r) => (
            <div key={r} className="conf-room">
              <input
                type="text"
                placeholder="Room type"
                aria-label="Room type"
                value={room.roomType}
                onChange={(e) => setRoomField(i, r, 'roomType', e.target.value)}
              />
              <input
                type="text"
                placeholder="Guests"
                aria-label="Guests"
                value={room.guests}
                onChange={(e) => setRoomField(i, r, 'guests', e.target.value)}
              />
              <input
                type="text"
                placeholder="Notes"
                aria-label="Notes"
                value={room.notes}
                onChange={(e) => setRoomField(i, r, 'notes', e.target.value)}
              />
              <button
                type="button"
                className="btn-icon btn-icon-danger"
                title="Remove room"
                aria-label={`Remove room ${r + 1}`}
                onClick={() => update(i, { rooms: conf.rooms.filter((_, idx) => idx !== r) })}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-link conf-add-btn"
            onClick={() => update(i, { rooms: [...conf.rooms, { ...EMPTY_ROOM }] })}
          >
            + Add room
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn btn-link conf-add-btn"
        onClick={() => onChange([...confirmations, { confirmationNumber: '', rooms: [] }])}
      >
        + Add confirmation
      </button>
    </div>
  )
}

function StayForm({ initial, onSubmit, onCancel, hint = null }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const [confirmations, setConfirmations] = useState(() =>
    (initial?.confirmations ?? []).map((c) => ({
      confirmationNumber: c.confirmationNumber,
      rooms: (c.rooms ?? []).map((room) => ({ ...EMPTY_ROOM, ...room })),
    }))
  )
  const [error, setError] = useState('')
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  function handleSubmit(e) {
    e.preventDefault()
    const stay = {
      hotelName: form.hotelName,
      hotelAddress: form.hotelAddress,
      checkInDay: form.checkInDay,
      checkOutDay: form.checkOutDay,
      confirmations: confirmations.map((c) => ({
        confirmationNumber: c.confirmationNumber.trim(),
        // Drop rooms left entirely blank (stray "+ Add room" clicks), then
        // drop blank fields within each kept room.
        rooms: c.rooms
          .filter((room) => room.roomType.trim() || room.guests.trim() || room.notes.trim())
          .map((room) =>
            Object.fromEntries(
              Object.entries(room)
                .map(([k, v]) => [k, v.trim()])
                .filter(([, v]) => v)
            )
          ),
      })),
    }
    const problem = validateStay(stay)
    if (problem) return setError(problem)
    onSubmit(stay)
  }

  return (
    <form className="hotel-stay-form" onSubmit={handleSubmit}>
      <label>
        Hotel name
        <input type="text" value={form.hotelName} onChange={set('hotelName')} required />
      </label>
      <label>
        Address
        <input
          type="text"
          value={form.hotelAddress}
          onChange={set('hotelAddress')}
          placeholder="Street address for maps navigation"
        />
      </label>
      <div className="hotel-stay-form-dates">
        <label>
          Check-in
          <input type="date" value={form.checkInDay} onChange={set('checkInDay')} required />
        </label>
        <label>
          Check-out
          <input
            type="date"
            value={form.checkOutDay}
            min={nextDay(form.checkInDay) || undefined}
            onChange={set('checkOutDay')}
            required
          />
        </label>
      </div>
      <ConfirmationsEditor confirmations={confirmations} onChange={setConfirmations} />
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary btn-small">
          Save Stay
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {hint && <p className="hotel-stay-hint">{hint}</p>}
    </form>
  )
}
```

Note `{ ...EMPTY_FORM, ...initial }` may copy `confirmations` into `form` — harmless, because `handleSubmit` builds the submitted stay from the four listed fields plus the editor state only.

- [ ] **Step 3: Fix the linked-stay dedup key.** In `client/src/pages/TripPage.jsx:201`, replace the key line with:

```js
      const confs = (stay.confirmations ?? []).map((c) => c.confirmationNumber).join(',')
      const key = `${stay.hotelName}|${stay.checkInDay}|${stay.checkOutDay}|${confs}`
```

- [ ] **Step 4: CSS.** Append to `client/src/styles.css` (near the existing `.hotel-stay-*` rules):

```css
.hotel-stay-conf-group { margin: 0.35rem 0; }
.hotel-stay-rooms {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0 0 0 0.75rem;
  font-size: 0.85rem;
  display: grid;
  gap: 0.15rem;
}
.hotel-stay-room-type { font-weight: 600; }
.conf-editor { display: flex; flex-direction: column; gap: 0.5rem; }
.conf-editor-title { font-weight: 600; font-size: 0.9rem; }
.conf-block {
  border: 1px solid #d8d3c8;
  border-radius: 8px;
  padding: 0.6rem;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.conf-block-head { display: flex; align-items: flex-end; gap: 0.5rem; }
.conf-block-head label { flex: 1; }
.conf-room { display: flex; gap: 0.4rem; align-items: center; }
.conf-room input { flex: 1; min-width: 0; }
.conf-add-btn { align-self: flex-start; font-size: 0.85rem; padding: 0; }
```

(Match the border color to the modal card's existing border variable if one exists in `styles.css` — check for a `--border`-style custom property and prefer it over the `#d8d3c8` literal.)

- [ ] **Step 5: Build and unit-test**

Run: `cd client; npm test` then `npm run build` — expect ALL PASS and a clean build.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/HotelStaysModal.jsx client/src/pages/TripPage.jsx client/src/styles.css
git commit -m "Edit and display multiple confirmations with rooms per hotel stay"
```

---

### Task 5: Browser verification (fake-agent server)

**Files:**
- Create: `<scratchpad>/conf-check.mjs` (session scratchpad, not the repo)

**Interfaces:**
- Consumes: the built client (Task 4), verify-server pattern from `<scratchpad>/verify.mjs` / `hotel-check.mjs`: `node verify-server.mjs` on port 3199 with a fresh `DATA_DIR` (`$env:DATA_DIR = "...\data-$(Get-Random)"`), Playwright with `channel: 'msedge'`.

- [ ] **Step 1: Write the script.** Follow the existing `hotel-check.mjs` structure (register/login via API, create trip, drive the UI with Playwright). Assertions, in order:

1. **Migration check:** before starting the server, write a legacy-shaped trip file directly into the fresh `DATA_DIR` (a trip JSON with `hotelStays: [{ hotelName: 'Canyon Lodge', hotelAddress: '41 Clover Ln', checkInDay: '2026-07-18', checkOutDay: '2026-07-19', confirmationNumber: 'LEGACY1' }]`). Start the server, then read the file back from disk: it now has `confirmations: [{ confirmationNumber: 'LEGACY1', rooms: [] }]`, no `confirmationNumber` key, and a `backup-*` dir exists beside it.
2. Register/login and create a fresh trip via API with 2 days (`2026-07-18`, `2026-07-19`) and a new-shape stay carrying one confirmation `FIRST1`; assert GET round-trips it.
3. Open the trip page → "Hotel stays" link → the card shows one pill containing `FIRST1`.
4. Click Edit → the Confirmations editor shows one block pre-filled `FIRST1` with no rooms.
5. In the block, click "+ Add room", fill Room type `Western Cabin`, Guests `Jim & Kathy`; click "+ Add confirmation", fill the new block's number `SECOND2`, add a room `Standard Room` / `Jared`; Save.
6. GET the trip via API: `hotelStays[0].confirmations` deep-equals two entries with those rooms.
7. The list card shows two pills (`FIRST1`, `SECOND2`) with room lines `Western Cabin — Jim & Kathy` and `Standard Room — Jared`.
8. Click the day tile's check-in icon → detail modal shows both pills + rooms.
9. Edit again, blank out `SECOND2`'s number, Save → error text matches `confirmation #` and nothing saved.
10. Edit again, remove the `SECOND2` block entirely, Save → GET shows one confirmation remaining.

- [ ] **Step 2: Run it**

```powershell
cd client; npm run build
# then from the scratchpad, with a throwaway DATA_DIR:
node conf-check.mjs
```
Expected output: all numbered checks print `ok`, exit 0.

- [ ] **Step 3: Regression sweeps**

Run the existing scratchpad suites against the same built client: `node verify.mjs` (54), `node hotel-check.mjs` (29), `node link-check.mjs` (35), `node share-link-check.mjs` (16) — all must pass. **Note:** any of these that seed stays with a legacy `confirmationNumber` via PUT will now get a 400 — update those seeds to the `confirmations` shape as part of this step (the scripts live in the scratchpad, not the repo).

- [ ] **Step 4: Commit** (only if repo files changed in fixes)

```bash
git add -A
git commit -m "Fix issues found in browser verification of confirmation editing"
```
Skip the commit if nothing needed fixing.

---

### Task 6: Live agent smoke (real API key)

**Files:**
- Create: `<scratchpad>/rooms-smoke.mjs`

**Interfaces:**
- Consumes: the real dev server on port 3197 (restart it first — no `--watch`; the restart also migrates the local data dir), `chat-smoke.mjs` request pattern (`POST /api/trips/:id/chat` with `{ message, model }`, SSE response).

- [ ] **Step 1: Write the script.** Model `anthropic/claude-sonnet-4-5` (the model from the original failure report). Three turns against a fresh trip with days `2026-07-18`/`2026-07-19`:

1. "We're staying at Canyon Lodge & Cabins in Yellowstone the night of July 18th, checking out the 19th. Two reservations: confirmation 20869678 is a Western Cabin for Jim & Kathy, and confirmation 20871144 is a Standard Lodge Room for Jared." → assert `hotelStays[0].confirmations` has both entries with the stated rooms.
2. "Add another room to the Canyon Lodge stay under confirmation 20869678: a second Western Cabin for the kids." → assert that confirmation now has 2 rooms and the other confirmation is untouched.
3. "Add one more room to that stay for Grandma." (no confirmation # given) → assert **no change** to stored confirmations and the agent's reply text asks about a confirmation (match `/confirmation/i` in the final model message).

- [ ] **Step 2: Restart the dev server, run the smoke**

```powershell
# restart the real server (port 3197) so it picks up Tasks 1+3 and migrates local data, then:
node rooms-smoke.mjs
```
Expected: `ROOMS SMOKE PASS`, exit 0. Also spot-check that the local `server/data` trips got a `backup-*` dir and converted stays.

- [ ] **Step 3: Full-suite final check + commit any fixes**

Run: `cd server; npm test` and `cd client; npm test` — all green. Commit any smoke-driven fixes:

```bash
git add -A
git commit -m "Fix issues found in live agent smoke for room additions"
```
Skip the commit if nothing needed fixing.
