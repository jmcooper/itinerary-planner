# AI Chat Agent Integration — Design

Date: 2026-07-13
Source requirements: [docs/ai-integration.md](../../ai-integration.md)

## Overview

Replace the copy/paste CSV workflow with an integrated AI chat agent that creates and
edits trip itineraries. The backend uses **Genkit** with a developer-configurable model
provider (model name and API key supplied via `.env`). Chat responses **stream** to the
client over SSE. The agent modifies itineraries via a **tool call** (`updateItinerary`)
rather than emitting structured JSON in every response. The on-disk day format changes
to a richer time-block shape, with a one-time migration script for existing data.

Decisions confirmed with the owner:

- Backend AI layer: Genkit; model + API key configurable via `.env`.
- Streaming responses (SSE), with ghosted itinerary placeholder during the first generation.
- Trip name and dates are **extracted by the agent** from the trip description.
- Manual (no-AI) creation path remains available as a fallback.
- Map links are built deterministically from agent-provided waypoints (not agent-written URLs).
- Times stored as `"HH:MM"` strings; images stay as image-id references.
- Per-trip chat history persisted on disk; chat requires edit permission.

## Configuration

`server/.env` (loaded with `dotenv`; `.env` is gitignored, `.env.example` committed)
holds **provider API keys only**:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the `@genkit-ai/anthropic` plugin when set |
| `GEMINI_API_KEY` | Enables the `@genkit-ai/google-genai` plugin when set |

Plugins are registered only when their key is present. The **model is chosen in the
app**: `GET /api/ai/status` reports `{ enabled, models: [{id, label}] }`, where the
model list is discovered live from each configured provider (filtered to chat-capable,
tool-supporting models; a curated fallback list is used if discovery fails). Every AI
dialog (new-trip form, chat panel) offers a model dropdown; the chosen model id is sent
with each chat request and validated server-side. The last-used model is remembered in
`localStorage`. If no provider key is configured, AI features are **disabled**: chat
returns 503 and the client hides AI UI.

## Data Model

### Trip day (new shape)

```jsonc
"days": {
  "2026-07-01": {
    "title": "West side geysers",          // agent- or user-provided day title
    "mapsUrl": "https://www.google.com/maps/dir/?api=1&...",
    "items": [
      {
        "timeStart": "08:15",              // "HH:MM" 24h, or null
        "timeEnd": "08:45",                // "HH:MM" 24h, or null
        "timeLabel": null,                 // raw display string when times couldn't be parsed (migration fallback)
        "title": "Fountain Paint Pot",
        "description": "Markdown…",        // supports markdown
        "imageIds": ["img_ab12cd34ef56"]   // references into <trip>.images.json (existing system)
      }
    ]
  }
}
```

- The old `{time, plan, code, details, images}` item shape is fully replaced.
- `trip.summary` (string) is added: the agent's brief description of the itinerary,
  shown under the trip header.
- Display: `timeLabel ?? formatRange(timeStart, timeEnd)` (12-hour formatting client-side).

### Chat history

`<data-dir>/<trip-id>.chat.json`:

```jsonc
{ "messages": [ /* Genkit message array: {role: "user"|"model"|"tool", content: [...]} */ ] }
```

Genkit's message format is the single source of truth; the UI renders user text right in
bubbles, model text left as markdown, and `toolRequest` parts as compact
"itinerary updated" cards. Chat files are deleted with the trip.

## Server

### `server/src/ai.js`

- Initializes Genkit with conditionally-registered plugins and exposes
  `createAgent({ storage })` used by `app.js`. Model chosen from `AI_MODEL`.
- `updateItinerary` tool (zod `inputSchema`):
  - `tripName?: string` — set/replace the trip name (first generation extracts it).
  - `summary: string` — brief itinerary description.
  - `startDate`, `endDate` — `YYYY-MM-DD`; updates the trip range.
  - `days: [{ date, title, waypoints: string[], items: [{ timeStart, timeEnd, title, description }] }]`
    — full replacement for each listed day; unlisted days are untouched.
  - Handler: validates shape/dates, builds `mapsUrl` per day from ordered `waypoints`
    (`https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a|b|c`),
    carries forward `imageIds` from existing items when titles match, saves the trip,
    returns `{ ok, savedDays }`. Tool errors are thrown so Genkit reports them back to
    the model for self-correction.
  - The current trip is passed to the tool via Genkit's `context` mechanism (or a
    per-request `dynamicTool` if context propagation proves unreliable).
- System prompt: travel-planning assistant; includes today's date, the current trip
  state (name, dates, per-day titles + item summaries); instructs the agent to call
  `updateItinerary` for any create/edit, to extract name/dates from the user's
  description, to keep conversational answers concise, and that descriptions are
  markdown.

### Endpoints

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/ai/status` | none | `{ enabled, model }` |
| `POST /api/trips/ai` | signed-in | `{ description }` → creates a trip shell (placeholder name derived from description, no dates, empty days, `summary: ""`), returns the trip. Client sends the description as the first chat message. |
| `GET /api/trips/:id/chat` | canEdit | Returns stored chat messages. |
| `POST /api/trips/:id/chat` | canEdit | `{ message }` → **SSE stream**: `text` events (deltas), `trip` events (fresh trip JSON after each successful tool call), `done` (final message + trip), `error`. Persists updated Genkit message history on completion. 503 when AI disabled. |

Concurrency: one in-flight chat request per trip (409 on overlap) to avoid interleaved
writes to the chat/trip files.

## Client

### Routing / creation flow

- `Create Trip` → `/trips/new`: a single large description textarea with hint text
  (mention date range, entry/exit points, travelers, pace/interests), a submit button,
  and a "set up manually instead" link that reveals the current name + date-range flow.
- Submit → `POST /api/trips/ai` → navigate to `/trips/:id` with the description in
  router state; the chat panel auto-sends it as the first message.

### Trip page layout

- Desktop: itinerary (existing day nav + day panel) on the left, **chat panel** (~380px)
  on the right.
- Mobile (narrow viewports): tab bar switching between **Itinerary** and **Assistant**.
- While the first generation is streaming and the trip has no days: ghosted skeleton
  placeholders for the day list and day panel.
- `trip` SSE events refresh the page's trip state live (name, dates, days, summary).

### Chat panel (`ChatPanel.jsx`)

- Scrollable history: user messages right-aligned in bubbles; agent responses
  left-aligned plain text with markdown rendering; `toolRequest` parts render as a
  compact itinerary-update card (dates + day titles).
- Streaming text appends live; input disabled while a response is in flight.
- Hidden when AI is disabled or the viewer lacks edit permission.
- SSE via `fetch` + ReadableStream (POST body required, so no `EventSource`).

### Day view updates

- `DayView`/`ItineraryRow` render the new item shape: time column
  (`timeLabel ?? "8:15 – 8:45 am"` style), title, expandable markdown description,
  images via `imageIds` (existing `ItemImages`).
- Manual editing still supported: title, times, description per item; day title editable.
- The CSV-paste import form remains for empty days (manual path); `buildDayItems`
  output is converted to the new shape at save time (CSV `time` string parsed the same
  way as migration; `code` headings stripped into `description`).

## Migration

`server/scripts/migrate-days.mjs [dataDir]` (run once before deployment):

- For each `<id>.json`: convert old items `{time, plan, code, details, images}` →
  `{timeStart, timeEnd, timeLabel, title, description, imageIds}`.
  - Time parsing: `"8:00 am"` → `08:00`; `"8:05–8:40"` / `"8:05-8:40"` → start+end;
    am/pm inferred from context when unambiguous (times within a day are assumed
    chronological); unparseable → nulls + `timeLabel` set to the original string.
  - `details` → `description` with `## S1 —` codes stripped from headings.
  - `images` (image-id array on old items, if present) → `imageIds`.
- Already-migrated trips (items with `title` and no `plan`) are skipped (idempotent).
- Originals backed up to `<dataDir>/backup-<timestamp>/` before writing.

## Error Handling

- Stream/model errors → `error` SSE event → rendered as an error notice in chat with
  the user's message preserved in the input for retry; partial tool writes are already
  atomic per-file (existing tmp+rename writes).
- Tool input validation failures throw inside the tool → Genkit feeds the error to the
  model, which can retry (bounded by `maxTurns`).
- AI disabled → creation page shows only the manual path; chat panel hidden.

## Testing

- **Server unit**: time parsing, migration transform, maps-URL builder, system-prompt
  trip serialization.
- **Server API** (supertest): auth gating on chat routes (401/403/404), 503 when AI
  disabled, chat history read/write, AI-create endpoint. Genkit is injected into
  `createApp` so tests use a scripted fake agent (streams canned text + tool calls).
- **Client unit**: time formatting, CSV-import conversion to the new shape.
- Manual browser verification per the project's browser-verification setup (build
  client, throwaway DATA_DIR, Playwright).

## Out of Scope

- Multi-user API-key management or per-user billing (single server key).
- Chat for viewers without edit permission.
- Support for reading the old day format at runtime (migration is one-shot).
