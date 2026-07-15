# Multi-Confirmation Hotel Stays — Design

**Date:** 2026-07-15
**Status:** Approved

## Problem

A hotel stay can involve multiple reservations: one booking might cover two rooms
under one confirmation number, and a second room might arrive under its own
confirmation. Today a stay stores a single optional `confirmationNumber` string,
so there is nowhere to record additional confirmations or which rooms belong to
which reservation. Travelers need to add all of this when creating a stay
(via UI or the travel agent) and to append rooms/confirmations to an existing
stay later ("add a 2nd room to my Canyon Lodge stay").

## Data Model

Each trip-level hotel stay replaces `confirmationNumber: string` with a
`confirmations` array:

```json
{
  "hotelName": "Canyon Lodge & Cabins",
  "hotelAddress": "41 Clover Ln, Yellowstone National Park, WY 82190",
  "checkInDay": "2026-07-18",
  "checkOutDay": "2026-07-19",
  "confirmations": [
    {
      "confirmationNumber": "20869678",
      "rooms": [
        { "roomType": "Western Cabin", "guests": "Jim & Kathy", "notes": "" },
        { "roomType": "Western Cabin", "guests": "the kids" }
      ]
    },
    {
      "confirmationNumber": "20871144",
      "rooms": [{ "roomType": "Standard Lodge Room", "guests": "Jared" }]
    }
  ]
}
```

Rules:

- A stay may have **zero** confirmations (consistent with the earlier decision
  to allow saving a stay without a confirmation number).
- `confirmationNumber` is **required** (non-empty string) on every confirmation
  entry — it is the identity of the reservation.
- `rooms` is optional/may be empty — a bare confirmation number is valid.
- Room fields `roomType`, `guests`, `notes` are all **optional** strings;
  empty ones are omitted from storage (same junk-stripping style as
  `normalizeHotelStays` today).
- `hotelName`, `checkInDay`, `checkOutDay` remain required; `hotelAddress`
  remains **optional** everywhere (server, UI, agent) — unchanged from today.

### Backward compatibility — no on-disk migration

- `normalizeHotelStays` (`server/src/hotels.js`) accepts **both** shapes: the
  legacy `confirmationNumber` string (converted to
  `confirmations: [{ confirmationNumber, rooms: [] }]`) and the new
  `confirmations` array. It always **emits** the new shape. Supplying both on
  one stay is fine; legacy string is folded in only when `confirmations` is
  absent.
- Stored trips are converted lazily: the first save of a trip rewrites its
  stays in the new shape. Reads never rewrite.
- A client helper `stayConfirmations(stay)` (in `client/src/lib/hotels.js`)
  returns the normalized confirmations list from either shape so all display
  components tolerate old stored data.

## Server

- `server/src/hotels.js` — extend `normalizeHotelStays`: validate
  `confirmations` is an array of objects, each with a non-empty
  `confirmationNumber` string; `rooms` (if present) an array of objects with
  optional string `roomType` / `guests` / `notes`; trim everything, drop empty
  optional fields, return `{ error }` on the first problem. Legacy
  `confirmationNumber` folding as above.
- REST PUT handler (`server/src/app.js`) needs no change beyond what
  `normalizeHotelStays` already provides (it delegates validation).
- Linked-day plumbing (`server/src/links.js` `linkedHotelStays`) carries whole
  stay objects, so confirmations ride along untouched.

## Client UI

### Stay form (`HotelStaysModal.jsx` StayForm)

Below the existing name/address/dates fields, a **Confirmations** section:

- A list of confirmation blocks. Each block: confirmation # input (required),
  plus a nested room list where each room row has room type, guests, and notes
  inputs (all optional).
- "+ Add room" inside each block; "+ Add confirmation" below the list; small
  remove (✕) buttons per room and per confirmation block.
- Editing an existing stay (including one in the legacy shape, via
  `stayConfirmations`) pre-populates the blocks; a legacy single
  `confirmationNumber` appears as one block with no rooms.
- Validation: any confirmation block with an empty number fails with a clear
  error; a stay with zero blocks is valid.
- One Save submits the whole stay; trip-level full-replacement save flow
  unchanged.

### List and detail display

- `StayInfo` (list cards) and `HotelStayDetail` (day-icon modal) render **one
  copy-to-clipboard pill per confirmation** — the existing pill component,
  repeated. Clicking a pill copies that confirmation number.
- Under each pill, its rooms as compact lines: room type, guests ("— Jim &
  Kathy"), and notes (muted). Rooms with only some fields render only what
  exists.
- A stay with zero confirmations shows the existing "No confirmation # on
  file." note in the detail modal; stays with confirmations but no rooms look
  like today (pill only).
- Linked (read-only) stays render the same way.

## Travel agent (`server/src/ai.js`)

- **Tool schema**: replace the stay-level `confirmationNumber` field with an
  optional `confirmations` array mirroring the server validation
  (confirmationNumber required per entry; rooms optional with optional
  roomType/guests/notes). Keep accepting the legacy `confirmationNumber`
  field in the schema for one release so mid-flight chats don't break;
  `normalizeHotelStays` folds it.
- **Full-replacement semantics unchanged**: `hotelStays` in the tool input
  replaces the whole list. "Add a room to my Canyon Lodge stay" means re-send
  every stay, with that stay's confirmations updated.
- **Prompt rules**:
  - When the traveler gives multiple confirmation numbers and room details in
    one message, save them all in a single tool call.
  - Adding a room requires knowing which confirmation it belongs to: if the
    traveler doesn't say, ask whether it's under an existing confirmation
    (name them) or a new one — and get the new number if so.
  - Room type, guests, and notes are optional: never invent them; save only
    what the traveler states. Don't nag for them.
  - Existing rules stand: never invent dates or confirmation numbers; address
    from model knowledge when confident (stated back to the traveler),
    otherwise ask; a stay may be saved with no confirmation number.
- `describeUpdate` (compaction) already emits "replaced hotel stays (N)" —
  unchanged.

## Testing

- **Server unit** (`server/test/`): `normalizeHotelStays` — legacy string
  folds to new shape; new shape round-trips; both-present prefers
  `confirmations`; empty confirmation number rejected; room field trimming and
  junk-stripping; rooms optional. Agent apply saves confirmations; PUT
  round-trip via the API tests.
- **Client unit**: `stayConfirmations` reads legacy and new shapes; form
  validation (empty conf # in a block fails; zero blocks passes).
- **Browser (Playwright, fake-agent server)**: create a stay with two
  confirmations (one with two rooms, one with one), verify list + detail
  rendering and per-pill copy; edit to add a room; edit a legacy-shaped stay
  and confirm pre-population + save in new shape.
- **Live agent smoke** (real key): one turn adding a stay with two
  confirmation numbers and per-room details; a follow-up turn "add a third
  room under confirmation X" appends without disturbing the rest; a turn
  adding a room with no confirmation given → agent asks instead of saving.

## Out of Scope

- Per-room pricing/rate tracking.
- Linking guests to user accounts.
- On-disk data migration scripts.
