# Flight Trips — Design

**Date:** 2026-07-15
**Status:** Approved (user pre-approved implementation without further review)

## Problem

Trips need flight tracking alongside hotel stays. A booking ("flight trip" — a
round-trip or multi-city reservation) shares one confirmation number across
several flights; each flight has its own times, optional flight number, ticket
number, and seats. Days touched by a flight should show an airplane icon that
opens an editable detail dialog, a "Flights" link should list all flight
trips, and the travel agent should record flights AND add matching itinerary
items in the same update.

## Data Model

New trip-level array `trip.flightTrips`, **fully separate from `hotelStays`**:

```json
"flightTrips": [
  {
    "confirmationNumber": "GK5XPL",
    "flights": [
      {
        "flightNumber": "DL1048",
        "departureTime": "2026-07-17T15:00",
        "arrivalTime": "2026-07-17T18:05",
        "ticketNumber": "0062341987654",
        "seats": [
          { "class": "Comfort+", "seatNumber": "14E" },
          { "class": "Comfort+", "seatNumber": "14C" }
        ]
      }
    ]
  }
]
```

Rules:

- `flights` is **required and non-empty** per flight trip.
- `departureTime` / `arrivalTime` are **required** per flight, format
  `YYYY-MM-DDTHH:MM` (local wall-clock; timezones deliberately ignored), and
  `arrivalTime > departureTime` (plain string compare is correct for this
  format).
- `confirmationNumber` **optional** string at the flight-trip level (the
  agent asks for it but saves without, mirroring hotels); omitted from
  storage when empty.
- `flightNumber` and `ticketNumber` optional strings per flight; omitted when
  empty.
- `seats` optional on input; storage always writes an array (possibly `[]`).
  Per seat: `seatNumber` **required** non-empty; `class` optional (missing =
  economy/plain). Empty `class` omitted.
- All strings trimmed; only known fields kept (junk-stripping, same style as
  `normalizeHotelStays`).
- `flightTrips` is a FULL-replacement list in REST PUT and the agent tool.
- No data migration needed (new field; readers use `?? []`).

Validation lives in a new **`server/src/flights.js`**:
`normalizeFlightTrips(input) → { flightTrips } | { error }`, shared by the
REST PUT handler and the agent tool.

## Server

- `server/src/app.js`: PUT handler accepts `flightTrips` (permission:
  `canEdit`, like `hotelStays`), delegating to `normalizeFlightTrips`; 400 on
  error. Trip duplication copies `flightTrips` automatically via the existing
  spread.
- `server/src/links.js` (mirror `linkedHotelStays`):
  - `resolveTripDays` attaches `linkedFlightTrips` to a linked day: the
    target trip's flight trips having at least one flight that departs or
    arrives on that date, each tagged with `linkedTripName`.
  - `normalizeLinkedDay` scrubs `linkedFlightTrips` so linked copies never
    persist.
- DELETE with `?copyLinks=1` (copy-and-delete): flight trips with a flight
  touching any linked day are materialized into the linking trip alongside
  the day content and hotel stays.
- Sharing/visibility guards need no changes — flight trips are trip-level
  data that ride along like hotel stays.

## Client helpers — new `client/src/lib/flights.js`

- `flightDate(dt)` → `dt.slice(0, 10)`; `flightClock(dt)` → `dt.slice(11, 16)`.
- `flightsTouchingDay(flightTrips, date)` → flights whose departure OR
  arrival date equals `date` (overnight flights appear on both days).
- `flightTripsTouchingDay(flightTrips, date)` → the flight trips containing
  such a flight (one day icon per touching flight trip).
- `validateFlightTrip(ft)` → error string | null: at least one flight; each
  flight has valid departure/arrival datetimes with arrival after departure;
  every seat has a seat number.
- `seatClassKind(cls)` → `'plus' | 'first' | 'plain'`:
  `/comfort|plus/i` → plus (blue), `/first/i` → first (red), anything else or
  missing → plain (economy/coach).

## Day icons

- New `PlaneIcon` in `client/src/components/icons.jsx` (house-icon
  conventions: viewBox 24, stroke currentColor, width 2, aria-hidden).
  Colored via `.flight-icon { color: var(--primary) }`.
- Day tiles (TripPage day nav) and the day header (DayView) show one plane
  icon per flight trip touching that date, rendered next to the existing
  hotel check-in/check-out icons. Tooltip/aria: "Flight(s) on this day —
  <conf # or flight numbers>".
- Clicking opens the flight-trip detail dialog for that flight trip.
- **No missing-flight warnings** — unlike hotels, a day without flights is
  normal.

## Dialogs — new `client/src/components/FlightsModal.jsx`

Mirrors `HotelStaysModal.jsx`. Shared pieces (`CopyButton`,
`ConfirmationPill`) are exported from `HotelStaysModal.jsx` and imported —
not duplicated.

- **Flights link**: in the `.trip-dates-line`, immediately right of "Hotel
  stays", label "Flights" (with count like hotels if the hotels link shows
  one); shown when `dates.length > 0 && (canEdit || allFlightTrips.length >
  0)`. Opens the list modal.
- **`FlightsModal`** (list): one card per flight trip sorted by earliest
  departure; own trips editable (pencil/trash + "Add Flight Trip" button),
  linked ones read-only with the "From '<trip>' via a linked day" note.
  Save sends the full replacement array; errors surface like hotels.
- **`FlightTripDetail`** (from day icons): same pencil-edit-in-place pattern
  as `HotelStayDetail` — `canEdit`+`onSave` props, edit swaps in the form,
  save re-derives fresh data; linked flight trips read-only.
- **`FlightTripForm`**: confirmation # input (optional), then flight blocks —
  flight # text input, departure/arrival `datetime-local` inputs, ticket #
  text input, and a seats editor (rows of class + seat number inputs, "+ Add
  seat", per-row remove). "+ Add flight" adds a block; per-block remove.
  Validation via `validateFlightTrip`; fully-blank seat rows dropped on
  submit; one Save writes the whole flight trip (full-replacement at the
  trip level, like hotels).

### Display (list cards and detail)

- Confirmation # as the existing copy pill; the whole flight trip's flights
  render inside the same tinted `.hotel-stay-conf-group`-style container so
  conf # + flights read as one reservation (reuse the class or a
  `.flight-trip-group` twin).
- Per flight, inside the group:
  - **Flight #** bold (or "Flight" when absent), then the time range:
    "Fri, Jul 17 · 3:00 PM → 6:05 PM", with the arrival's "Sat, Jul 18 ·"
    prefix added when the dates differ.
  - **Ticket #** on its own small-text line ("Ticket # 0062341987654") with a
    text-sized inline copy button right after the number (not the large
    pill).
  - **Seat chips**, Delta-style: compact bold rectangles with the seat
    number, e.g. `14E`. `.seat-chip-plus` white-on-blue (#1a66b3),
    `.seat-chip-first` white-on-red (var(--danger)), `.seat-chip-plain`
    default background with a `var(--line)` border. Chip title/aria includes
    the class name when present.

## Travel agent (`server/src/ai.js`)

- **Tool schema**: optional `flightTrips` array mirroring
  `normalizeFlightTrips` (`.describe()` notes full replacement and the
  datetime format).
- **`applyItineraryUpdate`**: `flightTrips !== undefined` counts as a change
  (empty array = clear all); validate via `normalizeFlightTrips`, returning
  `ok: false` with the error (never throw); apply; report
  `savedFlightTrips` count (added to the tool `outputSchema` as optional).
- **`describeUpdate`** (compaction): `replaced flight trips (N)`.
- **Prompt rules** (new "Flights:" block after the hotel rules):
  - Record flight bookings in `flightTrips` — a FULL replacement of the whole
    list; one entry per booking/confirmation, with round-trip and multi-city
    flights as multiple flights under that one entry.
  - Departure and arrival are local wall-clock date+times
    (`YYYY-MM-DDTHH:MM`); never invent them — ask if missing. Ignore
    timezone differences.
  - When adding or changing flights, IN THE SAME tool call also add or update
    itinerary items on each flight's departure day: `timeStart`/`timeEnd`
    from the departure/arrival clock times, `travel: true`, a title naming
    the flight (e.g. "Flight DL1048 to Salt Lake City"), and the confirmation
    # in the description.
  - Ask for the confirmation # but save without it if the traveler doesn't
    have one. Never invent flight numbers, ticket numbers, or seats — save
    them only when stated.

## Testing

- **Server unit**: `normalizeFlightTrips` (round-trip, trimming, required
  times/format/order, optional conf #/flight #/ticket #, seat rules, junk
  stripping, error cases); PUT round-trip + 400s + shared-editor; agent
  apply saves/clears flight trips + `savedFlightTrips` + ok:false on bad
  input; prompt states the flight rules; compaction describes flight
  updates; links: `resolveTripDays` attaches `linkedFlightTrips`,
  `normalizeLinkedDay` scrubs them, copy-and-delete materializes touching
  flight trips.
- **Client unit**: `flights.js` helpers — touching-day matching incl.
  overnight, `validateFlightTrip` cases, `seatClassKind` mapping.
- **Browser (Playwright, fake-agent server)**: new `flight-check.mjs` —
  add a flight trip with two flights (one overnight) via the Flights link;
  plane icons on all touched days; detail dialog from an icon shows conf #
  pill, flight lines, ticket # + small copy button, seat chips with the
  right classes (assert CSS class per chip); pencil edit adds a seat and
  saves; validation error on missing departure time; linked-day flight
  shows read-only.
- **Live agent smoke** (real key): "Add our flights: DL1048 departing July
  17 3:00 PM arriving 6:05 PM, returning DL2210 July 19 7:30 PM to 10:45 PM,
  confirmation GK5XPL, seats 14E and 14C in Comfort+ both ways" → one flight
  trip with two flights saved AND itinerary items on Jul 17 and Jul 19 with
  matching times and `travel: true`; follow-up turn adds a ticket number to
  one flight without disturbing the rest; a turn with no arrival time →
  agent asks instead of saving.

## Out of Scope

- Airline/airport lookup, live flight status, timezone math.
- Warnings for days without flights.
- Storing flights in `hotelStays` or any shared array.
