# Multi-Confirmation Hotel Stays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each hotel stay holds multiple confirmations, each with optional room details (roomType/guests/notes), editable via the UI and the travel agent.

**Architecture:** The stay-level `confirmationNumber` string becomes a `confirmations: [{ confirmationNumber, rooms: [...] }]` array. `normalizeHotelStays` (shared by REST PUT and the agent tool) accepts both shapes and always emits the new one — lazy migration, no data script. The client gets a `stayConfirmations(stay)` helper so display/edit code tolerates old stored data.

**Tech Stack:** Node/Express + node:test/supertest (server), React/Vite + vitest (client), Genkit + zod (agent), Playwright (browser verification).

**Spec:** `docs/superpowers/specs/2026-07-15-multi-confirmation-hotel-stays-design.md`

## Global Constraints

- `confirmationNumber` is required (non-empty) per confirmation entry; a stay may have **zero** confirmations.
- `rooms` optional/may be empty; `roomType`, `guests`, `notes` optional strings; empty optional fields are omitted from storage.
- `hotelAddress` stays optional everywhere (unchanged).
- No on-disk migration; legacy `confirmationNumber` accepted on input indefinitely, folded to the new shape on save.
- `hotelStays` remains a FULL-replacement list in both REST PUT and the agent tool.
- The dev server runs without `--watch`: restart `node src/index.js` after server edits before browser/live verification.

---

### Task 1: Server normalization — confirmations with rooms

**Files:**
- Modify: `server/src/hotels.js` (whole file, 37 lines)
- Create: `server/test/hotels.test.js`
- Modify: `server/test/api.test.js:274-320` (shape assertions), `server/test/ai.test.js:171-178` (shape assertion)

**Interfaces:**
- Produces: `normalizeHotelStays(input) → { stays } | { error }` (unchanged signature). Every emitted stay now has `confirmations: [{ confirmationNumber: string, rooms: [{ roomType?, guests?, notes? }] }]` and never a `confirmationNumber` key. Legacy `confirmationNumber` input folds to one confirmation with `rooms: []`; both present → `confirmations` wins.

- [ ] **Step 1: Write the failing tests** — create `server/test/hotels.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHotelStays } from '../src/hotels.js'

const base = { hotelName: 'Inn', hotelAddress: '', checkInDay: '2026-07-18', checkOutDay: '2026-07-19' }

test('legacy confirmationNumber folds into confirmations', () => {
  const { stays } = normalizeHotelStays([{ ...base, confirmationNumber: ' ABC123 ' }])
  assert.deepEqual(stays[0].confirmations, [{ confirmationNumber: 'ABC123', rooms: [] }])
  assert.equal('confirmationNumber' in stays[0], false)
})

test('no confirmation number yields an empty confirmations list', () => {
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

test('confirmations wins over a legacy confirmationNumber on the same stay', () => {
  const { stays } = normalizeHotelStays([
    { ...base, confirmationNumber: 'OLD', confirmations: [{ confirmationNumber: 'NEW' }] },
  ])
  assert.deepEqual(stays[0].confirmations, [{ confirmationNumber: 'NEW', rooms: [] }])
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

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern=confirmations` — expect the new tests FAIL (`confirmations` is undefined on output stays).

- [ ] **Step 3: Implement** — replace the body of `server/src/hotels.js` with:

```js
// Hotel-stay validation shared by the REST PUT handler and the AI agent's
// updateItinerary tool. A stay covers checkInDay (inclusive) through
// checkOutDay (exclusive) — the check-out day itself needs its own stay.
//
// Each stay carries confirmations: [{ confirmationNumber, rooms }]. The
// legacy single confirmationNumber string is still accepted on input and
// folded into the new shape, so stored trips migrate lazily on save.

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
    // New shape wins; the legacy confirmationNumber string is folded in only
    // when no confirmations array was given.
    if (raw.confirmations != null) {
      const { confirmations, error } = normalizeConfirmations(raw.confirmations)
      if (error) return { error }
      stay.confirmations = confirmations
    } else {
      if (raw.confirmationNumber != null && typeof raw.confirmationNumber !== 'string')
        return { error: 'confirmationNumber must be a string' }
      const conf = (raw.confirmationNumber ?? '').trim()
      stay.confirmations = conf ? [{ confirmationNumber: conf, rooms: [] }] : []
    }
    stays.push(stay)
  }
  return { stays }
}
```

- [ ] **Step 4: Update existing shape assertions.** In `server/test/api.test.js` (test `PUT /api/trips/:id round-trips hotelStays with normalization`, lines 291-300) replace the expected array with:

```js
  assert.deepEqual(res.body.hotelStays, [
    {
      hotelName: 'Holiday Inn',
      hotelAddress: '315 Yellowstone Ave',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }],
    },
    {
      hotelName: 'No Conf Inn',
      hotelAddress: '',
      checkInDay: '2026-07-21',
      checkOutDay: '2026-07-22',
      confirmations: [],
    },
  ])
```

Append to the `bad` list in `PUT /api/trips/:id rejects invalid hotelStays` (line 315):

```js
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmations: [{}] }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmations: [{ confirmationNumber: 'A', rooms: [{ guests: 5 }] }] }] },
```

In `server/test/ai.test.js` (test `applyItineraryUpdate saves hotelStays alone...`, line 177) replace `assert.deepEqual(trip.hotelStays, stayInput().hotelStays)` with:

```js
  assert.deepEqual(trip.hotelStays, [
    {
      hotelName: 'Holiday Inn West Yellowstone',
      hotelAddress: '315 Yellowstone Ave, West Yellowstone, MT',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }],
    },
  ])
```

- [ ] **Step 5: Run the full server suite**

Run: `cd server; npm test` — expect ALL PASS (116 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add server/src/hotels.js server/test/hotels.test.js server/test/api.test.js server/test/ai.test.js
git commit -m "Store hotel-stay confirmations with rooms; fold legacy confirmationNumber"
```

---

### Task 2: Client helpers — read both shapes, validate blocks

**Files:**
- Modify: `client/src/lib/hotels.js` (add `stayConfirmations`, extend `validateStay`)
- Test: `client/src/lib/hotels.test.js`

**Interfaces:**
- Produces: `stayConfirmations(stay) → [{ confirmationNumber, rooms: [] }]` — normalized list from either the legacy `{ confirmationNumber }` shape or the new `{ confirmations }` shape; `rooms` always an array. `validateStay(stay)` additionally returns `'Every confirmation needs a confirmation #.'` when any entry in `stay.confirmations` has a blank number.

- [ ] **Step 1: Write the failing tests** — append to `client/src/lib/hotels.test.js`:

```js
import { stayConfirmations } from './hotels.js' // merge into the existing import

describe('stayConfirmations', () => {
  it('reads the legacy confirmationNumber shape', () => {
    expect(stayConfirmations({ confirmationNumber: 'ABC123' })).toEqual([
      { confirmationNumber: 'ABC123', rooms: [] },
    ])
    expect(stayConfirmations({ confirmationNumber: '' })).toEqual([])
    expect(stayConfirmations({})).toEqual([])
  })

  it('reads the new confirmations shape and defaults rooms', () => {
    expect(
      stayConfirmations({
        confirmations: [
          { confirmationNumber: 'A', rooms: [{ roomType: 'Cabin' }] },
          { confirmationNumber: 'B' },
        ],
      })
    ).toEqual([
      { confirmationNumber: 'A', rooms: [{ roomType: 'Cabin' }] },
      { confirmationNumber: 'B', rooms: [] },
    ])
  })

  it('prefers confirmations when both shapes are present', () => {
    expect(
      stayConfirmations({ confirmationNumber: 'OLD', confirmations: [{ confirmationNumber: 'NEW' }] })
    ).toEqual([{ confirmationNumber: 'NEW', rooms: [] }])
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
```

(Match the file's existing vitest style — it already imports `validateStay`; extend that import list.)

- [ ] **Step 2: Run to verify failure**

Run: `cd client; npm test` — expect FAIL (`stayConfirmations` is not exported).

- [ ] **Step 3: Implement** — in `client/src/lib/hotels.js`, add after `isMissingStay` and extend `validateStay`:

```js
// Returns the normalized confirmations list from either the legacy
// { confirmationNumber } shape or the new { confirmations } shape, so
// display code tolerates trips stored before the migration.
export function stayConfirmations(stay) {
  if (Array.isArray(stay?.confirmations)) {
    return stay.confirmations.map((c) => ({ ...c, rooms: c.rooms ?? [] }))
  }
  const conf = (stay?.confirmationNumber ?? '').trim()
  return conf ? [{ confirmationNumber: conf, rooms: [] }] : []
}
```

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
git commit -m "Add stayConfirmations helper and confirmation validation"
```

---

### Task 3: Agent — tool schema and prompt rules

**Files:**
- Modify: `server/src/ai.js:70-85` (schema), `server/src/ai.js:373-378` (prompt hotel rules)
- Test: `server/test/ai.test.js`

**Interfaces:**
- Consumes: Task 1's `normalizeHotelStays` (already wired into `applyItineraryUpdate` — no apply-code change needed).
- Produces: tool input stays accept `confirmations` (new) and `confirmationNumber` (legacy, so mid-flight chats keep working).

- [ ] **Step 1: Write the failing tests** — append to `server/test/ai.test.js` near the existing stay tests (after line 187):

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

test('systemPrompt states the confirmation/room rules', () => {
  const prompt = systemPrompt({ name: 'X', summary: '', days: {} })
  assert.match(prompt, /one entry per confirmation number/)
  assert.match(prompt, /ask whether it goes under an existing one/)
  assert.match(prompt, /never invent them/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server; npm test -- --test-name-pattern="confirmation"` — the apply test PASSES already (normalize does the work); the prompt test FAILS. Confirm exactly that split.

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
        confirmationNumber: z
          .string()
          .optional()
          .describe('Legacy single confirmation number — prefer confirmations'),
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
- Consumes: `stayConfirmations`, `validateStay` from `client/src/lib/hotels.js` (Task 2).
- Produces: `StayForm` submits stays shaped `{ hotelName, hotelAddress, checkInDay, checkOutDay, confirmations }` — the legacy `confirmationNumber` key no longer appears in saved payloads.

- [ ] **Step 1: Rework display components.** In `HotelStaysModal.jsx`, add `stayConfirmations` to the `../lib/hotels.js` import. Replace the `ConfirmationNumber` component with:

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
  const confirmations = stayConfirmations(stay)
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
  // Editing a legacy-shaped stay pre-populates via stayConfirmations.
  const [confirmations, setConfirmations] = useState(() =>
    stayConfirmations(initial ?? {}).map((c) => ({
      confirmationNumber: c.confirmationNumber,
      rooms: c.rooms.map((room) => ({ ...EMPTY_ROOM, ...room })),
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

Note `initial` may carry a legacy `confirmationNumber` — it's ignored by the spread into `EMPTY_FORM`-shaped state (only the four listed fields are submitted), and `stayConfirmations` folds it into the editor.

- [ ] **Step 3: Fix the linked-stay dedup key.** In `client/src/pages/TripPage.jsx:201`, replace the key line with (add `stayConfirmations` to the existing `../lib/hotels.js` import):

```js
      const confs = stayConfirmations(stay).map((c) => c.confirmationNumber).join(',')
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

1. Seed a trip via API with 2 days (`2026-07-18`, `2026-07-19`) and a **legacy-shaped** stay: `PUT { hotelStays: [{ hotelName: 'Canyon Lodge', hotelAddress: '41 Clover Ln', checkInDay: '2026-07-18', checkOutDay: '2026-07-19', confirmationNumber: 'LEGACY1' }] }` — server now stores it as `confirmations: [{ confirmationNumber: 'LEGACY1', rooms: [] }]`; assert that via GET.
2. Open the trip page → "Hotel stays" link → the card shows one pill containing `LEGACY1`.
3. Click Edit → the Confirmations editor shows one block pre-filled `LEGACY1` with no rooms.
4. In the block, click "+ Add room", fill Room type `Western Cabin`, Guests `Jim & Kathy`; click "+ Add confirmation", fill the new block's number `SECOND2`, add a room `Standard Room` / `Jared`; Save.
5. GET the trip via API: `hotelStays[0].confirmations` deep-equals two entries with those rooms.
6. The list card shows two pills (`LEGACY1`, `SECOND2`) with room lines `Western Cabin — Jim & Kathy` and `Standard Room — Jared`.
7. Click the day tile's check-in icon → detail modal shows both pills + rooms.
8. Edit again, blank out `SECOND2`'s number, Save → error text matches `confirmation #` and nothing saved.
9. Edit again, remove the `SECOND2` block entirely, Save → GET shows one confirmation remaining.

- [ ] **Step 2: Run it**

```powershell
cd client; npm run build
# then from the scratchpad, with a throwaway DATA_DIR:
node conf-check.mjs
```
Expected output: all numbered checks print `ok`, exit 0.

- [ ] **Step 3: Regression sweeps**

Run the existing scratchpad suites against the same server: `node verify.mjs` (54), `node hotel-check.mjs` (29), `node link-check.mjs` (35), `node share-link-check.mjs` (16) — all must pass (hotel-check exercises the old single-conf flow, which now rides the legacy folding).

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
- Consumes: the real dev server on port 3197 (restart it first — no `--watch`), `chat-smoke.mjs` request pattern (`POST /api/trips/:id/chat` with `{ message, model }`, SSE response).

- [ ] **Step 1: Write the script.** Model `anthropic/claude-sonnet-4-5` (the model from the original failure report). Three turns against a fresh trip with days `2026-07-18`/`2026-07-19`:

1. "We're staying at Canyon Lodge & Cabins in Yellowstone the night of July 18th, checking out the 19th. Two reservations: confirmation 20869678 is a Western Cabin for Jim & Kathy, and confirmation 20871144 is a Standard Lodge Room for Jared." → assert `hotelStays[0].confirmations` has both entries with the stated rooms.
2. "Add another room to the Canyon Lodge stay under confirmation 20869678: a second Western Cabin for the kids." → assert that confirmation now has 2 rooms and the other confirmation is untouched.
3. "Add one more room to that stay for Grandma." (no confirmation # given) → assert **no change** to stored confirmations and the agent's reply text asks about a confirmation (match `/confirmation/i` in the final model message).

- [ ] **Step 2: Restart the dev server, run the smoke**

```powershell
# restart the real server (port 3197) so it picks up Tasks 1+3, then:
node rooms-smoke.mjs
```
Expected: `ROOMS SMOKE PASS`, exit 0.

- [ ] **Step 3: Full-suite final check + commit any fixes**

Run: `cd server; npm test` and `cd client; npm test` — all green. Commit any smoke-driven fixes:

```bash
git add -A
git commit -m "Fix issues found in live agent smoke for room additions"
```
Skip the commit if nothing needed fixing.
