# Itinerary Builder — Design

Source spec: [docs/instructions.md](../../instructions.md). This doc records the concrete
architecture and the decisions the spec left open.

## Overview

A travel-itinerary builder. The home page lists Trip Itineraries and lets the user create
one. A trip page lets the user pick a date range, then fill in each day's itinerary by
pasting a CSV (Time,Plan,Detail-code) plus a markdown details document whose `## S# — Title`
sections (separated by `---`) match the CSV detail codes. Days render as an expandable
time/plan table with per-item rendered-markdown details, editable after creation.

## Stack

- **Frontend**: React 18 + Vite, React Router, `react-markdown` for details rendering,
  hand-written CSS (no framework). Builds to static files deployable to nginx as a
  client-side-only app.
- **Backend**: Node Express server. No database — one JSON file per trip in `server/data/`.
- **Dev workflow**: Vite dev server proxies `/api` to Express (port 3001).
- **Deploy**: nginx serves `client/dist` and proxies `/api` to the Node process.

## Data model

One file per trip: `server/data/<id>.json`

```json
{
  "id": "europe-2026-a1b2",
  "name": "Europe 2026",
  "startDate": "2026-07-04",
  "endDate": "2026-07-10",
  "days": {
    "2026-07-04": {
      "items": [
        { "time": "8:00 am", "plan": "Leave hotel", "code": "S1", "details": "markdown..." }
      ]
    }
  },
  "createdAt": "...", "updatedAt": "..."
}
```

CSV/markdown parsing happens client-side; the server only stores the parsed structure.
Matching: CSV row's third column (`S1`) ↔ details section heading `## S1 — Title`.
When rendering/storing details, the `S# — ` prefix is kept in storage but the heading shown
to the user is the plan title without the code.

## API

- `GET /api/trips` — list `{id, name, startDate, endDate}`
- `POST /api/trips` — create `{name}` → trip
- `GET /api/trips/:id` — full trip
- `PUT /api/trips/:id` — merge-update (dates, days)
- `DELETE /api/trips/:id` — remove trip

## Components

- `HomePage` — trip list + create form
- `TripPage` — loads trip; date-range picker (native date inputs) when no dates; day list
  sidebar; `DayView` on the right
- `DayView` — if day has no items: `DayImportForm` (two textareas + submit); else
  `DayTable` of expandable `ItineraryRow`s
- `ItineraryRow` — time | plan columns; click toggles rendered markdown details;
  Edit button switches to inline form (plan title, time, details textarea)
- `lib/parse.js` — pure functions: `parseCsv`, `parseDetails`, `buildDayItems` (unit-tested)

## Decisions taken (spec was open)

- Native `<input type="date">` pair for the range picker — no dependency, works everywhere.
- Changing an existing date range re-derives the day list; existing day data for dates
  still in range is preserved.
- Trip deletion included (small, obviously useful).
- Item edit covers time, plan title, and details markdown.

## Error handling

- CSV rows that don't parse are skipped with a visible warning count; details sections
  without a matching code are appended as unmatched (details preserved, not lost).
- Server returns 404 for unknown trips, 400 for invalid payloads; file writes are atomic
  (write temp + rename).

## Testing

- Unit tests (Vitest) for `parseCsv` / `parseDetails` / `buildDayItems`.
- API tests (node:test + supertest) for the trips CRUD against a temp data dir.
