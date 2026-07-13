# AI Chat Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a streaming AI chat agent (Genkit, configurable model) that creates and edits trip itineraries via an `updateItinerary` tool, with a new time-block day format and a one-shot data migration.

**Architecture:** The Express server gains an injectable `agent` (real implementation in `server/src/ai.js` using Genkit; tests inject a scripted fake). Chat streams over SSE from `POST /api/trips/:id/chat`. The agent mutates trips through a Genkit tool whose handler loads/saves via the existing storage layer. The React client gains a `/trips/new` description-first creation flow and a `ChatPanel` beside the itinerary.

**Tech Stack:** Node/Express, Genkit (`genkit`, `@genkit-ai/anthropic`, `@genkit-ai/google-genai`), dotenv, zod (via `genkit`'s re-export), React 18, react-markdown, node:test + supertest, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-ai-chat-agent-design.md`.
- Times on disk are `"HH:MM"` 24-hour strings or `null`; `timeLabel` holds unparseable originals.
- Images stay as id references (`imageIds`) into `<trip>.images.json`.
- Chat requires edit permission; AI endpoints return 503 when disabled.
- `AI_MODEL` env var selects the model (`anthropic/...` or `googleai/...`); plugin registered only when its key env var is set.
- Old day format is not supported at runtime (migration is one-shot).
- Server tests: `npm test` in `server/` (node --test). Client tests: `npm test` in `client/` (vitest).

---

### Task 1: Server time-block utilities

**Files:**
- Create: `server/src/timeblocks.js`
- Test: `server/test/timeblocks.test.js`

**Interfaces:**
- Produces:
  - `parseLegacyTime(str) -> { timeStart: string|null, timeEnd: string|null, timeLabel: string|null }` (no day context; am/pm only when explicit)
  - `convertLegacyItems(items) -> newItems[]` — contextual am/pm inference across a day; maps `{time, plan, code, details, images}` → `{timeStart, timeEnd, timeLabel, title, description, imageIds}`
  - `migrateTripDays(trip) -> boolean` — mutates `trip.days` in place, returns whether anything changed; idempotent
  - `buildMapsUrl(waypoints: string[]) -> string` — `''` when fewer than 2 waypoints
  - `stripHeadingCodes(markdown) -> string`

- [ ] **Step 1: Write failing tests** (`server/test/timeblocks.test.js`)

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLegacyTime,
  convertLegacyItems,
  migrateTripDays,
  buildMapsUrl,
  stripHeadingCodes,
} from '../src/timeblocks.js'

test('parseLegacyTime parses explicit am/pm single times', () => {
  assert.deepEqual(parseLegacyTime('8:00 am'), { timeStart: '08:00', timeEnd: null, timeLabel: null })
  assert.deepEqual(parseLegacyTime('12:30 pm'), { timeStart: '12:30', timeEnd: null, timeLabel: null })
  assert.deepEqual(parseLegacyTime('12:15 am'), { timeStart: '00:15', timeEnd: null, timeLabel: null })
})

test('parseLegacyTime parses ranges with en-dash or hyphen', () => {
  assert.deepEqual(parseLegacyTime('8:05–8:40 am'), { timeStart: '08:05', timeEnd: '08:40', timeLabel: null })
  assert.deepEqual(parseLegacyTime('9:45-11:15 am'), { timeStart: '09:45', timeEnd: '11:15', timeLabel: null })
})

test('parseLegacyTime keeps ambiguous times without markers (assumed as written, am for 1-11)', () => {
  assert.deepEqual(parseLegacyTime('8:05–8:40'), { timeStart: '08:05', timeEnd: '08:40', timeLabel: null })
})

test('parseLegacyTime falls back to a label for unparseable input', () => {
  assert.deepEqual(parseLegacyTime('Evening'), { timeStart: null, timeEnd: null, timeLabel: 'Evening' })
})

test('convertLegacyItems infers pm from chronology across a day', () => {
  const items = [
    { time: '8:00 am', plan: 'Leave hotel', code: 'S1', details: '## S1 — Leave hotel\n\nGo.' },
    { time: '11:55–12:30', plan: 'Lunch', code: 'S2', details: '' },
    { time: '1:15–2:00', plan: 'Museum', code: 'S3', details: '', images: ['img_a'] },
  ]
  const out = convertLegacyItems(items)
  assert.deepEqual(out[0], {
    timeStart: '08:00', timeEnd: null, timeLabel: null,
    title: 'Leave hotel', description: '## Leave hotel\n\nGo.', imageIds: [],
  })
  assert.equal(out[1].timeStart, '11:55')
  assert.equal(out[1].timeEnd, '12:30')
  assert.equal(out[2].timeStart, '13:15') // inferred pm: 1:15 after 12:30
  assert.equal(out[2].timeEnd, '14:00')
  assert.deepEqual(out[2].imageIds, ['img_a'])
})

test('migrateTripDays converts old-format days and is idempotent', () => {
  const trip = {
    days: {
      '2026-07-01': {
        mapsUrl: 'https://maps.example',
        items: [{ time: '8:00 am', plan: 'Go', code: 'S1', details: 'x' }],
      },
    },
  }
  assert.equal(migrateTripDays(trip), true)
  const day = trip.days['2026-07-01']
  assert.equal(day.mapsUrl, 'https://maps.example')
  assert.equal(day.items[0].title, 'Go')
  assert.ok(!('plan' in day.items[0]))
  assert.equal(migrateTripDays(trip), false) // second run: no changes
})

test('buildMapsUrl builds a directions link from ordered waypoints', () => {
  const url = buildMapsUrl(['West Yellowstone', 'Fountain Paint Pot', 'Old Faithful'])
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'))
  assert.ok(url.includes('origin=West%20Yellowstone'))
  assert.ok(url.includes('destination=Old%20Faithful'))
  assert.ok(url.includes('waypoints=Fountain%20Paint%20Pot'))
  assert.equal(buildMapsUrl(['Just one']), '')
})

test('stripHeadingCodes removes S-codes from headings', () => {
  assert.equal(stripHeadingCodes('## S1 — Leave hotel'), '## Leave hotel')
  assert.equal(stripHeadingCodes('## Plain heading'), '## Plain heading')
})
```

- [ ] **Step 2: Run tests, verify failure** — `cd server && npm test` → fails: cannot find `../src/timeblocks.js`.

- [ ] **Step 3: Implement** `server/src/timeblocks.js`

```js
// Utilities for the time-block day format: legacy conversion, migration, and
// deterministic Google Maps directions links.

const HEADING_CODE_RE = /^(#{1,6})\s*[A-Za-z][A-Za-z0-9]*\s*[—–-]\s+(.*)$/

export function stripHeadingCodes(markdown) {
  return (markdown ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(HEADING_CODE_RE)
      return m ? `${m[1]} ${m[2]}` : line
    })
    .join('\n')
}

const TOKEN_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i

// -> minutes since midnight, or null. meridiem: 'am' | 'pm' | null
function parseToken(raw) {
  const m = (raw ?? '').trim().match(TOKEN_RE)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  if (hour < 0 || hour > 23 || minute > 59) return null
  const meridiem = m[3] ? (m[3].toLowerCase().startsWith('p') ? 'pm' : 'am') : null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  return { minutes: hour * 60 + minute, meridiem }
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Parses "8:00 am", "8:05–8:40", "9:45-11:15 am". A trailing meridiem applies
// to both ends of a range. Returns HH:MM strings (24h) or a timeLabel fallback.
export function parseLegacyTime(str) {
  const label = { timeStart: null, timeEnd: null, timeLabel: (str ?? '').trim() || null }
  const parts = (str ?? '').split(/[–—-]/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1) {
    const t = parseToken(parts[0])
    return t ? { timeStart: toHHMM(t.minutes), timeEnd: null, timeLabel: null } : label
  }
  if (parts.length === 2) {
    let a = parseToken(parts[0])
    const b = parseToken(parts[1])
    if (!a || !b) return label
    // "8:05–8:40 am": marker only on the end — apply to the start too
    if (!a.meridiem && b.meridiem === 'pm' && a.minutes < 12 * 60 && a.minutes <= b.minutes - 12 * 60 + 12 * 60) {
      if (a.minutes + 12 * 60 <= b.minutes) a = { ...a, minutes: a.minutes + 12 * 60 }
    }
    // Ranges that go "backwards" (e.g. 11:55–12:30 already fine; 9:00–1:30 pm)
    let end = b.minutes
    if (end < a.minutes && !b.meridiem) end += 12 * 60
    if (end < a.minutes) return label
    return { timeStart: toHHMM(a.minutes), timeEnd: toHHMM(end), timeLabel: null }
  }
  return label
}

// Converts a day's legacy items with chronological am/pm inference: times
// without an explicit marker are bumped by 12h when they'd otherwise run
// backwards relative to the latest time seen so far.
export function convertLegacyItems(items) {
  let cursor = 0 // minutes since midnight of the latest time seen
  return (items ?? []).map((item) => {
    const parsed = parseLegacyTime(item.time)
    let { timeStart, timeEnd } = parsed
    const hasMarker = /am|pm|a\.m\.|p\.m\./i.test(item.time ?? '')
    const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
    if (timeStart && !hasMarker) {
      let s = toMin(timeStart)
      let e = timeEnd ? toMin(timeEnd) : null
      if (s < cursor && s + 12 * 60 >= cursor && s < 12 * 60) {
        s += 12 * 60
        if (e !== null && e < s) e += 12 * 60
        timeStart = toHHMM(s)
        if (e !== null) timeEnd = toHHMM(e)
      }
    }
    if (timeEnd) cursor = Math.max(cursor, toMin(timeEnd))
    else if (timeStart) cursor = Math.max(cursor, toMin(timeStart))
    return {
      timeStart,
      timeEnd,
      timeLabel: parsed.timeLabel,
      title: item.plan ?? '',
      description: stripHeadingCodes(item.details ?? ''),
      imageIds: item.images ?? [],
    }
  })
}

function isLegacyItem(item) {
  return item != null && typeof item === 'object' && 'plan' in item && !('title' in item)
}

// Mutates trip.days from the legacy shape to time blocks. Returns true if changed.
export function migrateTripDays(trip) {
  let changed = false
  for (const day of Object.values(trip.days ?? {})) {
    if (Array.isArray(day.items) && day.items.some(isLegacyItem)) {
      day.items = convertLegacyItems(day.items)
      if (!('title' in day)) day.title = ''
      changed = true
    }
  }
  return changed
}

export function buildMapsUrl(waypoints) {
  const stops = (waypoints ?? []).map((w) => String(w).trim()).filter(Boolean)
  if (stops.length < 2) return ''
  const origin = encodeURIComponent(stops[0])
  const destination = encodeURIComponent(stops[stops.length - 1])
  const mid = stops.slice(1, -1).map(encodeURIComponent).join('%7C')
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`
  if (mid) url += `&waypoints=${mid}`
  return url
}
```

- [ ] **Step 4: Run tests, verify pass** — `cd server && npm test` → all timeblocks tests PASS. Adjust the pm-inference edge in `parseLegacyTime` if the "8:05–8:40 am"-style tests surface issues (the chronology logic in `convertLegacyItems` is authoritative for markerless times).

- [ ] **Step 5: Commit** — `git add server/src/timeblocks.js server/test/timeblocks.test.js && git commit -m "Add time-block utilities: legacy time parsing, day migration, maps links"`

---

### Task 2: Migration script

**Files:**
- Create: `server/scripts/migrate-days.mjs`

**Interfaces:**
- Consumes: `migrateTripDays` from Task 1.
- Produces: CLI `node scripts/migrate-days.mjs [dataDir]` (defaults to `../data` like `index.js`).

- [ ] **Step 1: Implement** `server/scripts/migrate-days.mjs`

```js
// One-shot migration of trip day items from {time, plan, code, details, images}
// to {timeStart, timeEnd, timeLabel, title, description, imageIds}.
// Usage: node scripts/migrate-days.mjs [dataDir]
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateTripDays } from '../src/timeblocks.js'

const dataDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')

const backupDir = path.join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const files = (await readdir(dataDir)).filter(
  (f) => f.endsWith('.json') && !f.endsWith('.images.json') && !f.endsWith('.chat.json') && f !== 'users.json'
)

let migrated = 0
for (const file of files) {
  const full = path.join(dataDir, file)
  let trip
  try {
    trip = JSON.parse(await readFile(full, 'utf8'))
  } catch {
    console.warn(`skipping unreadable ${file}`)
    continue
  }
  if (!trip || typeof trip !== 'object' || !trip.days) continue
  if (!migrateTripDays(trip)) continue
  await mkdir(backupDir, { recursive: true })
  await copyFile(full, path.join(backupDir, file))
  await writeFile(full, JSON.stringify(trip, null, 2), 'utf8')
  migrated++
  console.log(`migrated ${file}`)
}
console.log(migrated ? `Done: ${migrated} trip(s) migrated. Backups in ${backupDir}` : 'Nothing to migrate.')
```

- [ ] **Step 2: Smoke-test against a scratch dir** — create a temp dir with one legacy trip JSON, run `node scripts/migrate-days.mjs <tmp>`, verify output shape and backup file; run again → "Nothing to migrate."

- [ ] **Step 3: Commit** — `git add server/scripts/migrate-days.mjs && git commit -m "Add one-shot day-format migration script"`

---

### Task 3: Chat storage + AI agent module

**Files:**
- Modify: `server/src/storage.js` (add chat read/write/delete; delete chat with trip)
- Create: `server/src/ai.js`
- Test: `server/test/timeblocks.test.js` additions not needed; agent logic covered via app tests (Task 4) and `applyItineraryUpdate` unit tests in `server/test/ai.test.js`

**Interfaces:**
- Produces (storage): `readChat(tripId) -> {messages: []}`, `writeChat(tripId, chat)`; `deleteTrip` also removes `<id>.chat.json`.
- Produces (ai.js):
  - `createAiAgent(env = process.env) -> agent`
  - agent shape: `{ enabled: boolean, model: string|null, respond({ trip, messages, storage, username, emit }) -> Promise<messages[]> }`
    - `emit(event, data)` — called with `('text', {text})` per streamed chunk and `('trip', {})` after each successful tool write.
    - returns the full updated Genkit message array to persist.
  - `applyItineraryUpdate(input, { storage, tripId }) -> Promise<{ok: true, savedDays: string[]}>` — exported for unit tests; throws descriptive errors on invalid input.

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install genkit @genkit-ai/anthropic @genkit-ai/google-genai dotenv
```

- [ ] **Step 2: Add chat storage to `server/src/storage.js`** (unit-covered via app tests)

```js
  function chatFileFor(id) {
    return path.join(dataDir, `${id}.chat.json`)
  }

  async function readChat(tripId) {
    try {
      return JSON.parse(await readFile(chatFileFor(tripId), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return { messages: [] }
      throw err
    }
  }

  async function writeChat(tripId, chat) {
    await ensureDir()
    const target = chatFileFor(tripId)
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(chat), 'utf8')
    await rename(tmp, target)
  }
```

Also: in `deleteTrip`, add `await rm(chatFileFor(id), { force: true })`; in `listTrips`, exclude `.chat.json` files from the listing filter (same as `.images.json`).

- [ ] **Step 3: Write failing unit tests for `applyItineraryUpdate`** (`server/test/ai.test.js`) — create a temp storage with a trip; call with `{tripName, summary, startDate, endDate, days:[{date, title, waypoints, items}]}`; assert: trip renamed field-by-field NOT id, days written in new shape, mapsUrl built from waypoints, imageIds carried forward when an existing item has the same title, error thrown for a day date outside startDate–endDate, error for bad date format. Run → fails (module missing).

- [ ] **Step 4: Implement `server/src/ai.js`**

```js
import 'dotenv/config'
import { genkit, z } from 'genkit'
import { buildMapsUrl } from './timeblocks.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const itineraryUpdateSchema = z.object({
  tripName: z.string().min(1).optional().describe('Set or update the trip name'),
  summary: z.string().describe('A brief 1-3 sentence description of the itinerary'),
  startDate: z.string().describe('Trip start date, YYYY-MM-DD'),
  endDate: z.string().describe('Trip end date, YYYY-MM-DD'),
  days: z
    .array(
      z.object({
        date: z.string().describe('YYYY-MM-DD; must fall within startDate..endDate'),
        title: z.string().describe('Short title for the day'),
        waypoints: z
          .array(z.string())
          .describe('Ordered place names for the day including start and end points; used to build a maps link'),
        items: z.array(
          z.object({
            timeStart: z.string().nullable().describe('24h HH:MM or null'),
            timeEnd: z.string().nullable().describe('24h HH:MM or null'),
            title: z.string(),
            description: z.string().describe('Markdown details for this time block'),
          })
        ),
      })
    )
    .describe('Full replacement for each listed day; days not listed are left unchanged'),
})

export async function applyItineraryUpdate(input, { storage, tripId }) {
  const trip = await storage.readTrip(tripId)
  if (!trip) throw new Error(`trip ${tripId} not found`)
  if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate) || input.endDate < input.startDate)
    throw new Error('startDate/endDate must be valid YYYY-MM-DD with endDate >= startDate')
  for (const day of input.days) {
    if (!DATE_RE.test(day.date)) throw new Error(`invalid day date: ${day.date}`)
    if (day.date < input.startDate || day.date > input.endDate)
      throw new Error(`day ${day.date} is outside the trip range ${input.startDate}..${input.endDate}`)
    for (const item of day.items) {
      for (const key of ['timeStart', 'timeEnd']) {
        if (item[key] != null && !TIME_RE.test(item[key]))
          throw new Error(`invalid ${key} "${item[key]}" — use 24h HH:MM or null`)
      }
    }
  }
  if (input.tripName) trip.name = input.tripName.trim()
  trip.summary = input.summary
  trip.startDate = input.startDate
  trip.endDate = input.endDate
  trip.days = trip.days ?? {}
  const savedDays = []
  for (const day of input.days) {
    const existing = trip.days[day.date]?.items ?? []
    const imagesByTitle = new Map(existing.map((it) => [it.title, it.imageIds ?? []]))
    trip.days[day.date] = {
      title: day.title,
      mapsUrl: buildMapsUrl(day.waypoints),
      items: day.items.map((item) => ({
        timeStart: item.timeStart ?? null,
        timeEnd: item.timeEnd ?? null,
        timeLabel: null,
        title: item.title,
        description: item.description,
        imageIds: imagesByTitle.get(item.title) ?? [],
      })),
    }
    savedDays.push(day.date)
  }
  trip.updatedAt = new Date().toISOString()
  await storage.writeTrip(trip)
  return { ok: true, savedDays }
}

function systemPrompt(trip) {
  const dayLines = Object.entries(trip.days ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      const items = (day.items ?? [])
        .map((it) => `    - ${it.timeStart ?? it.timeLabel ?? ''}${it.timeEnd ? `–${it.timeEnd}` : ''} ${it.title}`)
        .join('\n')
      return `  ${date}: ${day.title || '(untitled)'}\n${items}`
    })
    .join('\n')
  return `You are a travel-itinerary planning assistant embedded in an itinerary builder app.

Today's date is ${new Date().toISOString().slice(0, 10)}.

Current trip state:
- Name: ${trip.name}
- Dates: ${trip.startDate ?? 'not set'} to ${trip.endDate ?? 'not set'}
- Summary: ${trip.summary || '(none)'}
- Days:
${dayLines || '  (no days planned yet)'}

Rules:
- Whenever you create or change the itinerary, call the updateItinerary tool. Never describe an itinerary as saved unless the tool call succeeded.
- Extract the trip name and start/end dates from the user's description when creating a new itinerary.
- For each day, provide ordered waypoints (real place names, including where the day starts and ends) so the app can build a Google Maps link.
- Item descriptions are markdown; keep them informative but compact (why it's worth doing, practical tips).
- Plan realistic timings, driving distances, and pacing. Respect the traveler's stated constraints.
- In your conversational reply, summarize what you planned or changed briefly — the full itinerary is displayed by the app, so do not repeat it verbatim.
- If the request is ambiguous or missing dates, ask before inventing details.`
}

export function createAiAgent(env = process.env) {
  const model = env.AI_MODEL ?? null
  const plugins = []
  if (env.ANTHROPIC_API_KEY) {
    // require lazily so the server runs without the packages configured
    plugins.push('anthropic')
  }
  if (env.GEMINI_API_KEY) plugins.push('googleai')
  const provider = model?.split('/')[0]
  const enabled = Boolean(model && plugins.includes(provider))
  if (!enabled) return { enabled: false, model: null, respond: null }

  // Static imports at module top in the real file:
  //   import { anthropic } from '@genkit-ai/anthropic'
  //   import { googleAI } from '@genkit-ai/google-genai'
  const pluginInstances = []
  if (env.ANTHROPIC_API_KEY) pluginInstances.push(anthropicPlugin())
  if (env.GEMINI_API_KEY) pluginInstances.push(googleAIPlugin())
  const ai = genkit({ plugins: pluginInstances })

  const updateItinerary = ai.defineTool(
    {
      name: 'updateItinerary',
      description:
        'Create or update the trip itinerary. Replaces each listed day entirely; unlisted days are untouched. Also sets trip name, summary, and date range.',
      inputSchema: itineraryUpdateSchema,
      outputSchema: z.object({ ok: z.boolean(), savedDays: z.array(z.string()) }),
    },
    async (input, { context }) => {
      const result = await applyItineraryUpdate(input, context)
      context.emit('trip', {})
      return result
    }
  )

  return {
    enabled: true,
    model,
    async respond({ trip, messages, storage, emit }) {
      const { stream, response } = ai.generateStream({
        model,
        system: systemPrompt(trip),
        messages,
        tools: [updateItinerary],
        maxTurns: 8,
        context: { storage, tripId: trip.id, emit },
      })
      for await (const chunk of stream) {
        if (chunk.text) emit('text', { text: chunk.text })
      }
      const final = await response
      return final.messages
    },
  }
}
```

Note for the implementer: use real static imports for the plugins (`import { anthropic } from '@genkit-ai/anthropic'`, `import { googleAI } from '@genkit-ai/google-genai'`) — the pseudo-lazy comments above only mark where they're used. Verify against the installed genkit version that (a) `context` passed to `generate` reaches the tool handler as shown, and (b) `final.messages` contains the full message history including tool turns. If context propagation differs, fall back to `ai.dynamicTool` defined inside `respond` with a closure over `{storage, tripId, emit}`.

- [ ] **Step 5: Run tests** — `cd server && npm test` → `ai.test.js` passes (it imports only `applyItineraryUpdate`, which must not require plugins — keep it a pure export).

- [ ] **Step 6: Commit** — `git add -A server && git commit -m "Add Genkit AI agent module and per-trip chat storage"`

---

### Task 4: Chat + AI endpoints in app.js

**Files:**
- Modify: `server/src/app.js`, `server/src/index.js`
- Create: `server/.env.example`
- Test: `server/test/chat.test.js`

**Interfaces:**
- `createApp(dataDir, { agent } = {})` — `agent` defaults to `{ enabled: false }`.
- Routes:
  - `GET /api/ai/status` → `{ enabled, model }`
  - `POST /api/trips/ai` (requireAuth) `{description}` → 201 trip (placeholder name from description, null dates, `summary: ''`, `aiCreated: true`)
  - `GET /api/trips/:id/chat` (canEdit) → `{ messages }`
  - `POST /api/trips/:id/chat` (canEdit) `{message}` → SSE (`text/event-stream`) with events `text`, `trip`, `done`, `error`; 503 if disabled; 409 if a chat for this trip is already running.
- `index.js` constructs the real agent: `createApp(dataDir, { agent: createAiAgent() })`.

- [ ] **Step 1: Write failing tests** (`server/test/chat.test.js`)

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

// Scripted fake agent: emits text, performs one itinerary write, returns history.
function fakeAgent() {
  return {
    enabled: true,
    model: 'fake/model',
    async respond({ trip, messages, storage, emit }) {
      emit('text', { text: 'Planning your trip' })
      const fresh = await storage.readTrip(trip.id)
      fresh.name = 'Yellowstone 2026'
      fresh.startDate = '2026-07-01'
      fresh.endDate = '2026-07-02'
      fresh.summary = 'Two days in Yellowstone'
      fresh.days = {
        '2026-07-01': {
          title: 'West side',
          mapsUrl: '',
          items: [{ timeStart: '08:00', timeEnd: null, timeLabel: null, title: 'Go', description: 'd', imageIds: [] }],
        },
      }
      await storage.writeTrip(fresh)
      emit('trip', {})
      return [...messages, { role: 'model', content: [{ text: 'Planning your trip' }] }]
    },
  }
}

let app, dataDir, alice
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-chat-'))
  app = createApp(dataDir, { agent: fakeAgent() })
  alice = request.agent(app)
  await alice.post('/api/auth/register').send({ username: 'alice', password: 'correct horse' })
})
after(async () => rm(dataDir, { recursive: true, force: true }))

test('GET /api/ai/status reports the injected agent', async () => {
  const res = await request(app).get('/api/ai/status')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { enabled: true, model: 'fake/model' })
})

test('POST /api/trips/ai creates a placeholder trip from a description', async () => {
  const res = await alice.post('/api/trips/ai').send({ description: 'Trip to Yellowstone with my wife in July' })
  assert.equal(res.status, 201)
  assert.equal(res.body.ownerId, 'alice')
  assert.equal(res.body.aiCreated, true)
  assert.ok(res.body.name.length > 0)
  assert.equal(res.body.startDate, null)
})

test('POST /api/trips/ai requires auth and a description', async () => {
  assert.equal((await request(app).post('/api/trips/ai').send({ description: 'x' })).status, 401)
  assert.equal((await alice.post('/api/trips/ai').send({})).status, 400)
})

test('chat endpoints stream SSE and persist history', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Yellowstone' })
  const id = created.body.id
  const res = await alice.post(`/api/trips/${id}/chat`).send({ message: 'Plan my trip' })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.match(res.text, /event: text/)
  assert.match(res.text, /event: trip/)
  assert.match(res.text, /event: done/)

  const hist = await alice.get(`/api/trips/${id}/chat`)
  assert.equal(hist.status, 200)
  assert.equal(hist.body.messages.length, 2)
  assert.equal(hist.body.messages[0].role, 'user')

  const trip = await alice.get(`/api/trips/${id}`)
  assert.equal(trip.body.name, 'Yellowstone 2026')
})

test('chat requires edit permission', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Private trip' })
  const id = created.body.id
  assert.equal((await request(app).get(`/api/trips/${id}/chat`)).status, 404) // private → invisible
  const bob = request.agent(app)
  await bob.post('/api/auth/register').send({ username: 'bob', password: 'correct horse' })
  assert.equal((await bob.post(`/api/trips/${id}/chat`).send({ message: 'hi' })).status, 404)
})

test('chat returns 503 when AI is disabled', async () => {
  const disabledApp = createApp(dataDir) // default agent: disabled
  const casey = request.agent(disabledApp)
  await casey.post('/api/auth/login').send({ username: 'alice', password: 'correct horse' })
  const created = await casey.post('/api/trips').send({ name: 'Manual trip' })
  const res = await casey.post(`/api/trips/${created.body.id}/chat`).send({ message: 'hi' })
  assert.equal(res.status, 503)
  const status = await request(disabledApp).get('/api/ai/status')
  assert.deepEqual(status.body, { enabled: false, model: null })
})
```

- [ ] **Step 2: Run tests, verify failure** — routes don't exist yet.

- [ ] **Step 3: Implement routes in `server/src/app.js`**

```js
export function createApp(dataDir, { agent = { enabled: false, model: null } } = {}) {
  // ...existing setup...

  app.get('/api/ai/status', (req, res) => {
    res.json({ enabled: Boolean(agent.enabled), model: agent.model ?? null })
  })

  function provisionalName(description) {
    const words = description.trim().split(/\s+/).slice(0, 6).join(' ')
    return words.length > 48 ? `${words.slice(0, 48)}…` : words
  }

  app.post(
    '/api/trips/ai',
    auth.requireAuth,
    wrap(async (req, res) => {
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : ''
      if (!description) return res.status(400).json({ error: 'description is required' })
      const now = new Date().toISOString()
      const name = provisionalName(description)
      const trip = {
        id: storage.slugify(name),
        name,
        ownerId: req.username,
        visibility: 'private',
        sharedWith: [],
        startDate: null,
        endDate: null,
        summary: '',
        aiCreated: true,
        days: {},
        createdAt: now,
        updatedAt: now,
      }
      await storage.writeTrip(trip)
      res.status(201).json(withPermissions(trip, req.username))
    })
  )

  app.get(
    '/api/trips/:id/chat',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      res.json(await storage.readChat(trip.id))
    })
  )

  const activeChats = new Set() // trip ids with an in-flight generation

  app.post(
    '/api/trips/:id/chat',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      if (!agent.enabled) return res.status(503).json({ error: 'AI is not configured on this server' })
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      if (!message) return res.status(400).json({ error: 'message is required' })
      if (activeChats.has(trip.id))
        return res.status(409).json({ error: 'a response is already in progress for this trip' })
      activeChats.add(trip.id)

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      const emit = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)
      }

      try {
        const chat = await storage.readChat(trip.id)
        const messages = [...chat.messages, { role: 'user', content: [{ text: message }] }]
        const updated = await agent.respond({ trip, messages, storage, emit })
        await storage.writeChat(trip.id, { messages: updated })
        emit('done', {})
      } catch (err) {
        console.error(err)
        emit('error', { error: err.message ?? 'generation failed' })
      } finally {
        activeChats.delete(trip.id)
        res.end()
      }
    })
  )
  // ...
}
```

Also update `server/src/index.js`:

```js
import { createAiAgent } from './ai.js'
createApp(dataDir, { agent: createAiAgent() }).listen(port, ...)
```

And create `server/.env.example`:

```
# Genkit model string: provider/model
# e.g. anthropic/claude-sonnet-4-6  or  googleai/gemini-2.5-flash
AI_MODEL=

# Provider API keys — set the one matching AI_MODEL's provider
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

Add `.env` to the repo `.gitignore` if not already covered.

- [ ] **Step 4: Run tests, verify pass** — `cd server && npm test` (all files).

- [ ] **Step 5: Commit** — `git add -A server .gitignore && git commit -m "Add AI status, AI trip creation, and streaming chat endpoints"`

---

### Task 5: Client API + time utilities

**Files:**
- Modify: `client/src/api.js`
- Create: `client/src/lib/time.js`
- Test: `client/src/lib/time.test.js`

**Interfaces:**
- `api.aiStatus()`, `api.createAiTrip(description)`, `api.getChat(tripId)`
- `api.streamChat(tripId, message, { onEvent })` — POSTs and parses the SSE body; calls `onEvent(event, data)`; resolves when the stream ends; throws on non-2xx.
- `time.js`:
  - `formatTimeBlock(item) -> string` — `timeLabel` if set, else `"8:15 – 8:45 am"` style 12-hour range (or single time), `''` when no times.
  - `parseTimeInput(str) -> "HH:MM"|null` — lenient user input ("8:15 am", "14:00") for edit forms.
  - `convertImportItems(items) -> newItems[]` — same contextual conversion as the server's `convertLegacyItems`, for the CSV-paste path.

- [ ] **Step 1: Write failing tests** (`client/src/lib/time.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { formatTimeBlock, parseTimeInput, convertImportItems } from './time.js'

describe('formatTimeBlock', () => {
  it('formats ranges in 12-hour style', () => {
    expect(formatTimeBlock({ timeStart: '08:15', timeEnd: '08:45' })).toBe('8:15 – 8:45 am')
    expect(formatTimeBlock({ timeStart: '11:30', timeEnd: '13:00' })).toBe('11:30 am – 1:00 pm')
  })
  it('formats single times and labels', () => {
    expect(formatTimeBlock({ timeStart: '20:00', timeEnd: null })).toBe('8:00 pm')
    expect(formatTimeBlock({ timeStart: null, timeEnd: null, timeLabel: 'Evening' })).toBe('Evening')
    expect(formatTimeBlock({ timeStart: null, timeEnd: null, timeLabel: null })).toBe('')
  })
})

describe('parseTimeInput', () => {
  it('accepts 12h and 24h input', () => {
    expect(parseTimeInput('8:15 am')).toBe('08:15')
    expect(parseTimeInput('1:05 pm')).toBe('13:05')
    expect(parseTimeInput('14:00')).toBe('14:00')
    expect(parseTimeInput('')).toBe(null)
    expect(parseTimeInput('bogus')).toBe(null)
  })
})

describe('convertImportItems', () => {
  it('converts CSV-import items with chronological pm inference', () => {
    const out = convertImportItems([
      { time: '8:00 am', plan: 'Leave hotel', details: '## S1 — Leave hotel\n\nGo.' },
      { time: '1:15–2:00', plan: 'Museum', details: '' },
    ])
    expect(out[0]).toMatchObject({ timeStart: '08:00', title: 'Leave hotel', imageIds: [] })
    expect(out[0].description).toContain('## Leave hotel')
    expect(out[1].timeStart).toBe('13:15')
  })
})
```

- [ ] **Step 2: Run, verify failure** — `cd client && npm test` → module not found.

- [ ] **Step 3: Implement `client/src/lib/time.js`** — port `parseLegacyTime`/`convertLegacyItems` logic from `server/src/timeblocks.js` (same algorithm; the client version also strips heading codes using `stripCodeFromHeadings` from `./parse.js`), plus:

```js
function fmt12(hhmm) {
  let h = Number(hhmm.slice(0, 2))
  const m = hhmm.slice(3)
  const mer = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return { text: m === '00' ? `${h}:00` : `${h}:${m}`, mer }
}

export function formatTimeBlock(item) {
  if (item.timeLabel) return item.timeLabel
  if (!item.timeStart) return ''
  const a = fmt12(item.timeStart)
  if (!item.timeEnd) return `${a.text} ${a.mer}`
  const b = fmt12(item.timeEnd)
  if (a.mer === b.mer) return `${a.text} – ${b.text} ${b.mer}`
  return `${a.text} ${a.mer} – ${b.text} ${b.mer}`
}

export function parseTimeInput(str) {
  const m = (str ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ?? '00'
  const mer = m[3]?.toLowerCase() ?? null
  if (h > 23 || Number(min) > 59) return null
  if (mer === 'pm' && h < 12) h += 12
  if (mer === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${min}`
}
```

- [ ] **Step 4: Add api.js methods**

```js
  aiStatus: () => fetchJson('/api/ai/status'),
  createAiTrip: (description) =>
    fetchJson('/api/trips/ai', { method: 'POST', body: JSON.stringify({ description }) }),
  getChat: (tripId) => fetchJson(`/api/trips/${tripId}/chat`),
  streamChat: async (tripId, message, { onEvent }) => {
    const res = await fetch(`/api/trips/${tripId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error ?? `Request failed (${res.status})`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const event = frame.match(/^event: (.*)$/m)?.[1]
        const data = frame.match(/^data: (.*)$/m)?.[1]
        if (event) onEvent(event, data ? JSON.parse(data) : {})
      }
    }
  },
```

- [ ] **Step 5: Run client tests, verify pass** — `cd client && npm test`.

- [ ] **Step 6: Commit** — `git add client/src/api.js client/src/lib/time.js client/src/lib/time.test.js && git commit -m "Add client AI api methods and time-block utilities"`

---

### Task 6: Day view renders/edits the new shape

**Files:**
- Modify: `client/src/components/ItineraryRow.jsx`, `client/src/components/DayView.jsx`, `client/src/components/ItemImages.jsx` (only if it references `item.images`), `client/src/lib/parse.js` (none expected), `client/src/pages/TripPage.jsx` (day-has-items dot only if needed)
- Test: run existing `client` tests; update `client/src/lib/parse.test.js` only if signatures changed (they don't — `buildDayItems` output is converted at save time).

**Interfaces:**
- Consumes: `formatTimeBlock`, `parseTimeInput`, `convertImportItems` from Task 5.
- Item shape everywhere: `{timeStart, timeEnd, timeLabel, title, description, imageIds}`.
- Day shape: `{title, mapsUrl, items}`.

- [ ] **Step 1: Update `ItineraryRow.jsx`** — display `formatTimeBlock(item)` in the time column and `item.title` for the plan column; details render `item.description` through ReactMarkdown (no more `stripCodeFromHeadings` — descriptions are stored clean); `ItemImages` uses `item.imageIds` and `onChangeIds={(imageIds) => onSave({ ...item, imageIds })}`. `ItemEditForm` gets three inputs — Start ("8:15 am"), End, Title — plus the markdown textarea; on submit converts with `parseTimeInput` (invalid non-empty input → inline error), saves `{...item, timeStart, timeEnd, timeLabel: null, title, description}`.

- [ ] **Step 2: Update `DayView.jsx`** — day heading shows `day.title` after the date (editable inline when `canEdit`, saved via `onSaveDay({ title })`); `DayImportForm` submit converts via `convertImportItems(items)` before `onSave`; keep `MapsLink` as-is (`day.mapsUrl` unchanged).

- [ ] **Step 3: Run client tests + `npm run build`** — `cd client && npm test && npm run build` → pass, build clean.

- [ ] **Step 4: Commit** — `git commit -am "Render and edit time-block day format"`

---

### Task 7: New-trip page (AI description + manual fallback)

**Files:**
- Create: `client/src/pages/NewTripPage.jsx`
- Modify: `client/src/App.jsx` (route `/trips/new`), `client/src/pages/HomePage.jsx` (replace inline create form with a Create Trip button/link)

**Interfaces:**
- Consumes: `api.aiStatus`, `api.createAiTrip`, `api.createTrip`.
- Produces: navigates to `/trips/:id` with `state: { initialPrompt: description }` (AI path) or plain (manual path).

- [ ] **Step 1: Implement `NewTripPage.jsx`**

```jsx
import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'

const HINT = `Describe your trip: destination(s), date range, where you'll start and end each leg, who is traveling, pace and interests.

Example: "Create an itinerary for a trip to Yellowstone from 7/1/2026 through 7/4/2026. We enter from West Yellowstone on the morning of 7/1 and leave toward Rexburg, Idaho on the evening of 7/4. My wife and I are in our mid-50s — long walks are fine, avoid strenuous hikes."`

export default function NewTripPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [aiEnabled, setAiEnabled] = useState(null)
  const [description, setDescription] = useState('')
  const [manual, setManual] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.aiStatus().then((s) => setAiEnabled(s.enabled)).catch(() => setAiEnabled(false))
  }, [])

  if (user === null) return <p className="empty-note"><Link to="/signin">Sign in</Link> to create a trip.</p>
  if (aiEnabled === false && !manual) setManual(true)

  async function handleAiCreate(e) {
    e.preventDefault()
    if (!description.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const trip = await api.createAiTrip(description.trim())
      navigate(`/trips/${trip.id}`, { state: { initialPrompt: description.trim() } })
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  async function handleManualCreate(e) {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const trip = await api.createTrip(name.trim())
      navigate(`/trips/${trip.id}`)
    } catch (err) {
      setError(err.message)
      setCreating(false)
    }
  }

  return (
    <div className="new-trip card">
      {!manual ? (
        <form onSubmit={handleAiCreate}>
          <h1>Describe your trip</h1>
          <p className="muted">The assistant will name the trip, set the dates, and draft a day-by-day itinerary.</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={HINT}
            rows={10}
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!description.trim() || creating}>
              {creating ? 'Creating…' : 'Create Itinerary'}
            </button>
            <button type="button" className="btn btn-link" onClick={() => setManual(true)}>
              set up manually instead
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleManualCreate}>
          <h1>Create a trip</h1>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Trip name, e.g. Europe 2026"
            maxLength={120}
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || creating}>
              {creating ? 'Creating…' : 'Create Trip'}
            </button>
            {aiEnabled && (
              <button type="button" className="btn btn-link" onClick={() => setManual(false)}>
                describe it to the assistant instead
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire route + home page** — add `<Route path="/trips/new" element={<NewTripPage />} />`; in `HomePage.jsx` replace the name-input create form with `<Link to="/trips/new" className="btn btn-primary">Create Trip</Link>` (signed-in users only).

- [ ] **Step 3: Build + commit** — `cd client && npm run build`; `git add -A client && git commit -m "Add description-first trip creation with manual fallback"`

---

### Task 8: ChatPanel + TripPage integration

**Files:**
- Create: `client/src/components/ChatPanel.jsx`
- Modify: `client/src/pages/TripPage.jsx`
- Modify: `client/src/styles.css` (chat panel, bubbles, tabs, skeleton)

**Interfaces:**
- `<ChatPanel tripId canEdit initialPrompt onTripChanged onFirstResponsePending />`
  - Loads history via `api.getChat`; renders genkit messages: `role === 'user'` → right bubble (text parts joined); `role === 'model'` → left markdown text + an "Itinerary updated" card per `toolRequest` part (shows `input.days` dates/titles); `role === 'tool'` skipped.
  - Auto-sends `initialPrompt` once when history is empty (ref guard).
  - `api.streamChat` events: `text` appends to a streaming buffer; `trip` → `onTripChanged()`; `error` → error notice + restore input; `done` → reload history.

- [ ] **Step 1: Implement `ChatPanel.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api } from '../api.js'

function MessageParts({ message }) {
  return message.content.map((part, i) => {
    if (part.text) {
      return (
        <div key={i} className="markdown chat-md">
          <ReactMarkdown>{part.text}</ReactMarkdown>
        </div>
      )
    }
    if (part.toolRequest?.name === 'updateItinerary') {
      const days = part.toolRequest.input?.days ?? []
      return (
        <div key={i} className="chat-tool-card">
          <span className="chat-tool-title">✦ Itinerary updated</span>
          <ul>
            {days.map((d) => (
              <li key={d.date}>
                <strong>{d.date}</strong> — {d.title}
              </li>
            ))}
          </ul>
        </div>
      )
    }
    return null
  })
}

export default function ChatPanel({ tripId, canEdit, initialPrompt, onTripChanged }) {
  const [messages, setMessages] = useState(null)
  const [draft, setDraft] = useState('')
  const [streamText, setStreamText] = useState(null) // null = idle
  const [pendingUser, setPendingUser] = useState(null)
  const [error, setError] = useState('')
  const sentInitial = useRef(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    api.getChat(tripId).then((c) => setMessages(c.messages)).catch((err) => setError(err.message))
  }, [tripId])

  useEffect(() => {
    if (messages && messages.length === 0 && initialPrompt && !sentInitial.current) {
      sentInitial.current = true
      send(initialPrompt)
    }
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, streamText, pendingUser])

  async function send(text) {
    setError('')
    setPendingUser(text)
    setStreamText('')
    try {
      await api.streamChat(tripId, text, {
        onEvent: (event, data) => {
          if (event === 'text') setStreamText((prev) => (prev ?? '') + data.text)
          else if (event === 'trip') onTripChanged()
          else if (event === 'error') setError(data.error)
        },
      })
      const chat = await api.getChat(tripId)
      setMessages(chat.messages)
    } catch (err) {
      setError(err.message)
      setDraft(text) // let the user retry
    } finally {
      setPendingUser(null)
      setStreamText(null)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || streamText !== null) return
    setDraft('')
    send(text)
  }

  if (!canEdit) return null

  return (
    <section className="chat-panel" aria-label="Trip assistant">
      <h2 className="chat-title">Assistant</h2>
      <div className="chat-history" ref={scrollRef}>
        {messages === null ? (
          <p className="muted">Loading conversation…</p>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="chat-user">{m.content.map((p) => p.text).join('')}</div>
            ) : m.role === 'model' ? (
              <div key={i} className="chat-agent"><MessageParts message={m} /></div>
            ) : null
          )
        )}
        {pendingUser && <div className="chat-user">{pendingUser}</div>}
        {streamText !== null && (
          <div className="chat-agent">
            {streamText ? (
              <div className="markdown chat-md"><ReactMarkdown>{streamText}</ReactMarkdown></div>
            ) : (
              <span className="chat-thinking">Thinking…</span>
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
          placeholder="Ask for changes, e.g. “End day 2 at 3pm so we can rest”"
          rows={2}
          disabled={streamText !== null}
        />
        <button type="submit" className="btn btn-primary btn-small" disabled={!draft.trim() || streamText !== null}>
          Send
        </button>
      </form>
    </section>
  )
}
```

- [ ] **Step 2: Integrate into `TripPage.jsx`** — read `useLocation().state?.initialPrompt`; fetch `api.aiStatus()` once; render layout:
  - `showChat = aiEnabled && trip.canEdit`
  - Desktop: `.trip-columns` flex wrapper around the existing `.trip-body` and `<ChatPanel/>`.
  - Mobile: `view` state (`'itinerary' | 'chat'`) with a two-button tab bar (CSS shows tabs only under 900px; the inactive pane gets a `.mobile-hidden` class).
  - Ghost placeholder: when `showChat && dates.length === 0 && initialPrompt` render `.skeleton-days` (3 pulsing bars) instead of the DateRangeForm/empty note.
  - `onTripChanged={() => api.getTrip(id).then(setTrip)}` — also update `selectedDate` when it's null and dates appear.
  - `trip.summary` renders under the dates line when present.

- [ ] **Step 3: Styles** (`client/src/styles.css`) — append chat styles: `.trip-columns {display:flex; gap:24px; align-items:flex-start}`, `.chat-panel {width: 380px; flex-shrink:0; display:flex; flex-direction:column; height: calc(100vh - 180px); position: sticky; top: 16px}`, `.chat-history {flex:1; overflow-y:auto}`, `.chat-user {align-self:flex-end; background: var(--accent, #2563eb); color:#fff; border-radius:14px 14px 4px 14px; padding:8px 12px; max-width:85%; margin:6px 0 6px auto; white-space:pre-wrap}`, `.chat-agent {margin:6px 0}`, `.chat-tool-card {border:1px solid var(--border,#ddd); border-radius:8px; padding:8px 12px; margin:8px 0; font-size:0.9em}`, `.chat-input {display:flex; gap:8px; margin-top:8px}`, `.chat-input textarea {flex:1}`, skeleton pulse keyframes, and a `@media (max-width: 900px)` block: `.trip-columns {display:block}`, `.chat-panel {width:auto; height:auto; position:static}`, `.trip-tabs {display:flex}` (hidden by default above 900px), `.mobile-hidden {display:none}`.

- [ ] **Step 4: Verify** — `cd client && npm test && npm run build`.

- [ ] **Step 5: Commit** — `git add -A client && git commit -m "Add streaming chat panel and AI-aware trip page layout"`

---

### Task 9: Data migration of dev data + README + end-to-end verification

**Files:**
- Modify: `README.md` (AI configuration section, migration instructions)
- Run: migration script against the real `server/data` dir (if present)

- [ ] **Step 1: README** — document `.env` setup (`AI_MODEL`, provider keys), the `node scripts/migrate-days.mjs` one-shot migration, and that AI features hide themselves when unconfigured.

- [ ] **Step 2: Run migration on local data** — `cd server && node scripts/migrate-days.mjs` (if `server/data` exists); verify a migrated trip renders.

- [ ] **Step 3: Full test pass** — `cd server && npm test`; `cd client && npm test && npm run build`.

- [ ] **Step 4: Browser verification** (memory: build client, serve via `node src/index.js` with throwaway `DATA_DIR`, Playwright msedge):
  - AI **disabled**: home → Create Trip → lands on manual form (no AI option), create, set dates, paste CSV day → renders time blocks correctly, edit an item.
  - AI **enabled** (fake or real key): create via description → chat streams → ghost placeholder replaced by itinerary → edit request updates a day. If no real key is available, verify the UI against a stub server route manually and note it.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Document AI setup and migrate legacy day data"`
