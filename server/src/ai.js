// AI agent for itinerary planning, built on Genkit so the model providers are
// configurable via .env API keys.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { genkit, z } from 'genkit'
import { anthropic } from '@genkit-ai/anthropic'
import { googleAI } from '@genkit-ai/google-genai'
import { buildMapsUrl } from './timeblocks.js'
import { normalizeHotelStays } from './hotels.js'
import { normalizeFlightTrips } from './flights.js'
import { isLinkedDay } from './links.js'
import { canEdit } from './permissions.js'

// Load .env by explicit path (server/.env, then the repo root) so the keys are
// found no matter which directory the server is launched from. Real
// environment variables always take precedence; missing files are ignored.
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '../.env'), quiet: true })
dotenv.config({ path: path.join(here, '../../.env'), quiet: true })

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// All fields are optional: the tool applies only what's provided, so the model
// can make partial updates (summary-only, rename-only, remove-only).
const itineraryUpdateSchema = z.object({
  tripName: z.string().min(1).optional().describe('Set or update the trip name'),
  summary: z
    .string()
    .optional()
    .describe('Set or update the brief 1-3 sentence description of the itinerary'),
  days: z
    .array(
      z.object({
        date: z.string().describe('The date this day covers, YYYY-MM-DD'),
        title: z
          .string()
          .optional()
          .describe('Short title for the day. Omit to keep the day’s existing title.'),
        waypoints: z
          .array(z.string())
          .optional()
          .describe(
            'Ordered place names for the day including where it starts and ends; used to build a Google Maps directions link. Omit to keep the day’s existing route.'
          ),
        items: z.array(
          z.object({
            timeStart: z.string().nullable().describe('24h HH:MM or null'),
            timeEnd: z.string().nullable().describe('24h HH:MM or null'),
            title: z.string(),
            description: z.string().describe('Markdown details for this time block'),
            travel: z
              .boolean()
              .optional()
              .describe(
                'True when this item is pure travel time between locations (driving, flying, transit). Travel items render as a compact connector between events.'
              ),
          })
        ),
        hotelNotNeeded: z
          .boolean()
          .optional()
          .describe(
            'True only when the traveler has said no hotel is needed the night of this day. Omit to keep the day’s existing flag.'
          ),
      })
    )
    .optional()
    .describe('Full replacement for each listed day; days not listed are left unchanged'),
  removeDates: z
    .array(z.string())
    .optional()
    .describe('Dates (YYYY-MM-DD) to delete from the itinerary entirely'),
  hotelStays: z
    .array(
      z.object({
        hotelName: z.string().min(1),
        hotelAddress: z.string().describe('Street address of the hotel; empty string if unknown'),
        checkInDay: z.string().describe('Check-in date, YYYY-MM-DD'),
        checkOutDay: z
          .string()
          .describe(
            'Check-out date, YYYY-MM-DD, after checkInDay. The stay covers checkInDay through the night before checkOutDay (check-out day exclusive).'
          ),
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
      })
    )
    .optional()
    .describe(
      'Full replacement of the trip’s ENTIRE hotel-stay list. When adding or editing one stay, include every existing stay that should remain.'
    ),
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
})

// Replaces one day on a trip object (in place). Items are always a full
// replacement; title, waypoints (→ mapsUrl), imageIds (by item title), and
// hotelNotNeeded carry forward from the existing day when omitted, so a
// partial call (e.g. the flights write-along adding one item) can't wipe them.
function applyDayReplacement(trip, day) {
  const existingDay = trip.days[day.date]
  const existing = existingDay?.items ?? []
  const imagesByTitle = new Map(existing.map((it) => [it.title, it.imageIds ?? []]))
  const hotelNotNeeded = day.hotelNotNeeded ?? existingDay?.hotelNotNeeded
  trip.days[day.date] = {
    title: day.title ?? existingDay?.title ?? '',
    mapsUrl: day.waypoints ? buildMapsUrl(day.waypoints) : (existingDay?.mapsUrl ?? ''),
    items: day.items.map((item) => ({
      timeStart: item.timeStart ?? null,
      timeEnd: item.timeEnd ?? null,
      timeLabel: null,
      title: item.title,
      description: item.description,
      travel: item.travel === true,
      imageIds: imagesByTitle.get(item.title) ?? [],
    })),
    ...(hotelNotNeeded ? { hotelNotNeeded: true } : {}),
  }
}

// Applies an updateItinerary tool call to the stored trip. Exported for tests.
// Days stored as links ({ linkedTripId }) are written through to the target
// trip so the link survives — the model never needs to know links exist.
export async function applyItineraryUpdate(input, { storage, tripId, username = null }) {
  const trip = await storage.readTrip(tripId)
  if (!trip) throw new Error(`trip ${tripId} not found`)
  // A call with no fields must fail loudly (but not throw — Genkit aborts the
  // whole turn on tool errors) so the model corrects itself instead of
  // believing an empty update succeeded.
  if (
    !input.tripName &&
    typeof input.summary !== 'string' &&
    !(input.days ?? []).length &&
    !(input.removeDates ?? []).length &&
    input.hotelStays === undefined && // [] is a valid "clear all stays"
    input.flightTrips === undefined // [] is a valid "clear all flight trips"
  ) {
    return {
      ok: false,
      savedDays: [],
      removedDays: [],
      error:
        'No changes received — provide days (full replacement of each listed day), removeDates, tripName, summary, hotelStays, and/or flightTrips.',
    }
  }
  let normalizedStays = null
  if (input.hotelStays !== undefined) {
    const { stays, error } = normalizeHotelStays(input.hotelStays)
    if (error) return { ok: false, savedDays: [], removedDays: [], error }
    normalizedStays = stays
  }
  let normalizedFlightTrips = null
  if (input.flightTrips !== undefined) {
    const { flightTrips, error } = normalizeFlightTrips(input.flightTrips)
    if (error) return { ok: false, savedDays: [], removedDays: [], error }
    normalizedFlightTrips = flightTrips
  }
  for (const day of input.days ?? []) {
    if (!DATE_RE.test(day.date)) throw new Error(`invalid day date: ${day.date} — use YYYY-MM-DD`)
    for (const item of day.items) {
      for (const key of ['timeStart', 'timeEnd']) {
        if (item[key] != null && !TIME_RE.test(item[key]))
          throw new Error(`invalid ${key} "${item[key]}" — use 24h HH:MM or null`)
      }
    }
  }
  for (const date of input.removeDates ?? []) {
    if (!DATE_RE.test(date)) throw new Error(`invalid removeDates entry: ${date} — use YYYY-MM-DD`)
  }
  if (input.tripName) trip.name = input.tripName.trim()
  if (typeof input.summary === 'string') trip.summary = input.summary
  trip.days = trip.days ?? {}
  const savedDays = []
  // Linked days write through to their target trip, grouped so each target
  // is read and written once. A broken link (target gone, date missing, or
  // chained link) falls back to a local replacement — the link was already
  // dead, and the model's content must not be dropped.
  const writeThrough = new Map() // linkedTripId -> { target, days: [] }
  for (const day of input.days ?? []) {
    const stored = trip.days[day.date]
    if (isLinkedDay(stored)) {
      const entry =
        writeThrough.get(stored.linkedTripId) ??
        writeThrough.set(stored.linkedTripId, {
          target: await storage.readTrip(stored.linkedTripId).catch(() => null),
          days: [],
        }).get(stored.linkedTripId)
      const targetDay = entry.target?.days?.[day.date]
      if (entry.target && targetDay && !isLinkedDay(targetDay)) {
        if (username && !canEdit(entry.target, username)) {
          return {
            ok: false,
            savedDays: [],
            removedDays: [],
            error: `The day ${day.date} could not be changed — it belongs to the trip "${entry.target.name}", which this user cannot edit. Other requested changes were not applied; retry without ${day.date}.`,
          }
        }
        entry.days.push(day)
        savedDays.push(day.date)
        continue
      }
    }
    applyDayReplacement(trip, day)
    savedDays.push(day.date)
  }
  for (const { target, days } of writeThrough.values()) {
    if (!target || days.length === 0) continue
    for (const day of days) applyDayReplacement(target, day)
    target.updatedAt = new Date().toISOString()
    await storage.writeTrip(target)
  }
  const removedDays = []
  for (const date of input.removeDates ?? []) {
    if (date in trip.days) {
      delete trip.days[date]
      removedDays.push(date)
    }
  }
  if (normalizedStays) trip.hotelStays = normalizedStays
  if (normalizedFlightTrips) trip.flightTrips = normalizedFlightTrips
  trip.updatedAt = new Date().toISOString()
  await storage.writeTrip(trip)
  const result = { ok: true, savedDays, removedDays }
  if (normalizedStays) result.savedStays = normalizedStays.length
  if (normalizedFlightTrips) result.savedFlightTrips = normalizedFlightTrips.length
  return result
}

// Reduces chat history to what every provider can replay: user/model/tool
// messages with text, toolRequest, and toolResponse parts. Thinking/reasoning
// parts carry provider-specific metadata (e.g. thought signatures) that other
// turns — or other models, since the user can switch models mid-chat — reject
// as unsupported, and the system message is rebuilt fresh each turn from the
// current trip state, so it must not be persisted either.
const REPLAYABLE_ROLES = new Set(['user', 'model', 'tool'])

// Streaming yields a model reply as many small text chunks; storing each as
// its own part makes the UI render fake paragraph breaks at chunk boundaries
// (and lets a note or list-like fragment start mid-part). Adjacent text parts
// are deltas of one continuous reply, so they merge losslessly.
function coalesceTextParts(parts) {
  const merged = []
  for (const part of parts) {
    const prev = merged[merged.length - 1]
    if (typeof part.text === 'string' && prev && typeof prev.text === 'string') {
      merged[merged.length - 1] = { text: prev.text + part.text }
    } else {
      merged.push(part)
    }
  }
  return merged
}

export function sanitizeChatMessages(messages) {
  return (messages ?? [])
    .filter((message) => REPLAYABLE_ROLES.has(message.role))
    .map((message) => ({
      role: message.role,
      content: coalesceTextParts(
        (message.content ?? [])
          .map((part) => {
            if (typeof part.text === 'string' && part.text !== '') return { text: part.text }
            if (part.toolRequest) return { toolRequest: part.toolRequest }
            if (part.toolResponse) return { toolResponse: part.toolResponse }
            return null
          })
          .filter(Boolean)
      ),
    }))
    .filter((message) => message.content.length > 0)
}

// Replaying every historical updateItinerary payload is the dominant token
// cost of a conversation, and the current trip state supersedes them anyway.
// When sending history to the model, each old tool call/response pair becomes
// a plain-text note describing what it did — NOT a stubbed tool call, because
// models imitate prior tool-call shapes and a placeholder input teaches them
// to send empty updates. The stored history keeps everything for display.
// Matches compaction placeholder notes — including ones older builds stored
// into model text, and ones a confused model wrote itself (observed in
// production: the model "said" the note instead of calling the tool).
const NOTE_RE = /^\s*\[Applied itinerary update[^\]]*\]\s*/

function describeUpdate(input = {}) {
  const actions = []
  if (input.tripName) actions.push(`renamed the trip to "${input.tripName}"`)
  if (typeof input.summary === 'string') actions.push('updated the trip summary')
  const dates = (input.days ?? []).map((d) => d.date)
  if (dates.length) actions.push(`replaced days: ${dates.join(', ')}`)
  if (input.removeDates?.length) actions.push(`removed days: ${input.removeDates.join(', ')}`)
  if (input.hotelStays) actions.push(`replaced hotel stays (${input.hotelStays.length})`)
  if (input.flightTrips) actions.push(`replaced flight trips (${input.flightTrips.length})`)
  return actions.join('; ') || 'no changes'
}

export function compactHistoryForModel(messages) {
  const list = messages ?? []
  // The most recent tool exchange stays intact: it is a correct, complete
  // example of how to call the tool. Without any real example in context,
  // weaker models start imitating the placeholder notes instead of calling
  // the tool (observed in production).
  let lastToolIdx = -1
  list.forEach((message, index) => {
    if ((message.content ?? []).some((p) => p.toolRequest?.name === 'updateItinerary'))
      lastToolIdx = index
  })
  const out = []
  list.forEach((message, index) => {
    const kept = []
    const notes = []
    for (const part of message.content ?? []) {
      if (part.toolRequest?.name === 'updateItinerary' && index !== lastToolIdx) {
        notes.push(describeUpdate(part.toolRequest.input))
        continue
      }
      // Tool responses before the kept exchange belong to compacted calls;
      // everything after lastToolIdx belongs to the kept one.
      if (part.toolResponse && (index < lastToolIdx || lastToolIdx === -1)) continue
      // Placeholder-note text must NEVER replay in the assistant's voice —
      // that is what teaches models to fake notes instead of calling the
      // tool. Legit stored notes move to the system voice; anything after
      // the note in the same part (a faked success message) is dropped
      // with it so the model never sees its own bad pattern.
      if (message.role === 'model' && typeof part.text === 'string' && NOTE_RE.test(part.text)) {
        const inner = part.text.match(/\[Applied itinerary update — ([^\]]*)\]/)?.[1]
        if (inner) notes.push(inner)
        continue
      }
      kept.push(part)
    }
    if (kept.length) out.push({ ...message, content: kept })
    if (notes.length)
      out.push({
        role: 'user',
        content: notes.map((n) => ({
          text: `[System note, not from the traveler: the assistant applied an itinerary update here — ${n}]`,
        })),
      })
  })
  // Coalesce runs of adjacent system-note messages (old histories can hold
  // long streaks of empty-update notes).
  const coalesced = []
  for (const message of out) {
    const prev = coalesced[coalesced.length - 1]
    const isNote = (m) =>
      m.role === 'user' && m.content.every((p) => p.text?.startsWith('[System note'))
    if (prev && isNote(prev) && isNote(message)) prev.content = [...prev.content, ...message.content]
    else coalesced.push(message)
  }
  return coalesced.filter((message) => message.content.length > 0)
}

// Appends only the NEW turns from a generation onto the stored history. The
// generation's message list echoes back the (compacted) replay copy — saving
// that wholesale would permanently strip tool calls from the stored history,
// which both breaks the UI's tool cards and teaches future turns to imitate
// placeholder notes instead of calling the tool.
export function appendNewTurns(history, replayedCount, finalMessages) {
  return [...history, ...sanitizeChatMessages(finalMessages).slice(replayedCount)]
}

// Exported for tests.
export function systemPrompt(trip) {
  // Full fidelity: the model edits days by full replacement, so it needs every
  // current detail (descriptions, travel flags) to carry them forward. Image
  // ids are internal references the model shouldn't see or invent.
  const days = Object.fromEntries(
    Object.entries(trip.days ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => [
        date,
        {
          title: day.title ?? '',
          mapsUrl: day.mapsUrl ?? '',
          items: (day.items ?? []).map((it) => ({
            timeStart: it.timeStart ?? null,
            timeEnd: it.timeEnd ?? null,
            ...(it.timeLabel ? { timeLabel: it.timeLabel } : {}),
            title: it.title,
            description: it.description,
            ...(it.travel ? { travel: true } : {}),
          })),
        },
      ])
  )
  return `You are a travel-itinerary planning assistant embedded in an itinerary builder app.

Today's date is ${new Date().toISOString().slice(0, 10)}.

Current trip state:
- Name: ${trip.name}
- Summary: ${trip.summary || '(none)'}
- Hotel stays (authoritative JSON): ${(trip.hotelStays ?? []).length ? JSON.stringify(trip.hotelStays) : '(none)'}
- Flight trips (authoritative JSON): ${(trip.flightTrips ?? []).length ? JSON.stringify(trip.flightTrips) : '(none)'}
- Current itinerary (authoritative JSON — older versions referenced in the chat history have had their details omitted):
${Object.keys(days).length ? JSON.stringify(days, null, 1) : '(no days yet)'}

Rules:
- Whenever you create or change the itinerary, call the updateItinerary tool. Never describe an itinerary as saved unless the tool call succeeded.
- Batch changes: one updateItinerary call can (and should) carry every affected day in its days array. Do not make a separate call per day.
- Tool calls must always contain the complete, real field values. The conversation may contain "[System note …]" messages summarizing updates you applied earlier — the app inserts those; neither you nor the traveler writes them. Never write bracketed notes yourself: text never saves anything. Nothing is saved unless the updateItinerary tool ran in the current turn and returned ok: true.
- Extract the trip name and the dates for each day from the user's description when creating a new itinerary. Name new trips after the destination (e.g. "Yellowstone Weekend") unless the traveler gives a name — the name also becomes the trip's URL.
- To delete days (e.g. "drop day 2", "cut the last day"), pass their dates in removeDates. Days may be non-contiguous — deleting a middle day leaves a gap.
- For each day, provide ordered waypoints (real place names, including where the day starts and ends) so the app can build a Google Maps link.
- Mark items that are pure travel between locations (driving, flying, transit) with travel: true, a short title like "Drive to Biscuit Basin", and accurate timeStart/timeEnd so the app can show the duration. Do not mark stops that merely include some walking.
- Item descriptions are markdown; keep them informative but compact (why it's worth doing, practical tips, distances/durations).
- Plan realistic timings, driving distances, and pacing. Respect the traveler's stated constraints.
- Each day in days always carries its COMPLETE items list — the existing items you want kept plus anything new. Listing a day with only the new item deletes everything else on it. title and waypoints may be omitted to keep the day's existing title and route.
- When replacing a day, carry forward the existing details you do not intend to change.
- In your conversational reply, briefly summarize what you planned or changed — the app displays the full itinerary, so do not repeat it verbatim.
- If the request is ambiguous or missing dates, ask before inventing details.

Hotel stays:
- Record a hotel stay whenever the user mentions a hotel booking. hotelStays is a FULL replacement of the whole list — when adding or editing one stay, include every existing stay that should remain.
- A stay covers checkInDay (inclusive) through checkOutDay (exclusive): the check-out day's night needs its own stay. The app warns on days not covered by any stay.
- A stay can have multiple reservations: list them in confirmations, one entry per confirmation number, each with its rooms. When the user gives several confirmation numbers and room details in one message, save them all in a single tool call.
- Adding a room to an existing stay means re-sending that stay with the room appended under its confirmation. Every room lives under a confirmation: if the user doesn't say which confirmation a new room belongs to, ask whether it goes under an existing one (name them) or a new one — and get the new number before saving.
- Room details (roomType, guests, notes) are optional: save them only when the user states them; never invent them and don't press for them.
- Never invent a check-in date, check-out date, or confirmation number. If any of them is missing from the user's request, ask for it before saving the stay. If the user says they don't have a confirmation number yet, save the stay without one.
- When the user doesn't provide the hotel's address, fill it in yourself — never leave it empty. The address only feeds a Google Maps search, so it does not need to be a verified street address: give the street address if you know it, otherwise use "<hotel name>, <city, state/region>", which Maps resolves fine. State what you used in your reply so the user can correct it.
- Set a day's hotelNotNeeded: true only when the user says no hotel is needed that night (e.g. a red-eye flight, staying with friends, the trip's final night at home).

Flights:
- Record flight bookings in flightTrips — a FULL replacement of the whole list; when adding or editing one booking, include every existing flight trip that should remain — one entry per booking: a round trip or multi-city itinerary is ONE entry whose flights array holds each flight.
- departureTime and arrivalTime are local wall-clock date+times (YYYY-MM-DDTHH:MM). Never invent them — ask when the traveler doesn't give them. Ignore timezone differences.
- When adding or changing flights, in the SAME updateItinerary call also add or update an itinerary item on each flight's departure day: timeStart/timeEnd are the departure/arrival clock times, travel: true, a title naming the flight (e.g. "Flight DL1048 to Salt Lake City"), and the confirmation # in the description. Create the day if it doesn't exist yet. Remember the days rule: send each touched day's COMPLETE items list (its existing items plus the flight item), not just the flight item.
- Ask for the confirmation number, but save the flights without one if the traveler doesn't have it. Never invent flight numbers, ticket numbers, or seats — record them only when the traveler states them.`
}

// Curated fallback used when live model discovery fails (e.g. transient
// provider API errors). Only models from configured providers are offered.
const FALLBACK_MODELS = [
  { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'googleai/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'googleai/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
]

// Models that can't drive an itinerary chat even if the provider lists them.
const NON_CHAT_MODEL_RE = /image|tts|audio|embedding|live|veo|imagen/i

// Dated snapshot ids (claude-haiku-4-5-20251001) duplicate their alias — hide them.
export function isDatedSnapshot(id) {
  return /-\d{8}$/.test(id)
}

const PROVIDER_LABELS = { anthropic: 'Anthropic', googleai: 'Google' }

// Version sequence from an id: "claude-opus-4-8" -> [4, 8], "gemini-2.5-flash"
// -> [2.5]. Used to order newest-first, since discovery metadata has no dates.
function modelVersion(id) {
  return (
    id
      .split('/')
      .pop()
      .split('-')
      .filter((t) => /^\d+(\.\d+)?$/.test(t))
      .map(Number)
  )
}

// Higher version sorts first; a missing segment counts as older ("4" < "4.1").
function compareVersionsDesc(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

// Groups models by provider (in the given provider order) and sorts each group
// newest to oldest; attaches a display name for the provider.
export function sortModelsForDisplay(models, providers) {
  return models
    .map((m) => {
      const prefix = m.id.split('/')[0]
      return { ...m, provider: PROVIDER_LABELS[prefix] ?? prefix }
    })
    .sort((a, b) => {
      const providerDiff =
        providers.indexOf(a.id.split('/')[0]) - providers.indexOf(b.id.split('/')[0])
      if (providerDiff !== 0) return providerDiff
      const versionDiff = compareVersionsDesc(modelVersion(a.id), modelVersion(b.id))
      if (versionDiff !== 0) return versionDiff
      return a.label.localeCompare(b.label)
    })
}

// "anthropic/claude-opus-4-5" -> "Claude Opus 4.5": title-case the words and
// join consecutive numeric tokens with dots.
export function prettyModelLabel(id) {
  const tokens = id.split('/').pop().split('-')
  const parts = []
  for (const token of tokens) {
    const isNumeric = /^\d+(\.\d+)?$/.test(token)
    if (isNumeric && parts.length > 0 && parts[parts.length - 1].numeric) {
      parts[parts.length - 1].text += `.${token}`
    } else {
      parts.push({
        text: isNumeric ? token : token.charAt(0).toUpperCase() + token.slice(1),
        numeric: isNumeric,
      })
    }
  }
  return parts.map((p) => p.text).join(' ')
}

// Returns the agent used by app.js. Providers are enabled by supplying their
// API key in .env; the user picks a model in the app from the providers'
// live model lists.
export function createAiAgent(env = process.env) {
  const providers = []
  const plugins = []
  if (env.ANTHROPIC_API_KEY) {
    plugins.push(anthropic({ apiKey: env.ANTHROPIC_API_KEY }))
    providers.push('anthropic')
  }
  if (env.GEMINI_API_KEY) {
    plugins.push(googleAI({ apiKey: env.GEMINI_API_KEY }))
    providers.push('googleai')
  }
  if (plugins.length === 0) return { enabled: false, listModels: async () => [], respond: null }

  const ai = genkit({ plugins })

  let modelsPromise = null
  function listModels() {
    modelsPromise ??= (async () => {
      try {
        const actions = await ai.registry.listResolvableActions()
        const models = Object.values(actions)
          .filter((meta) => meta.actionType === 'model')
          .filter((meta) => providers.includes(meta.name.split('/')[0]))
          .filter((meta) => meta.metadata?.model?.supports?.tools)
          .filter((meta) => !NON_CHAT_MODEL_RE.test(meta.name))
          .filter((meta) => !isDatedSnapshot(meta.name))
          .map((meta) => {
            const label = meta.metadata?.model?.label
            // Plugins often echo the id as the label; prettify in that case.
            return {
              id: meta.name,
              label: label && label !== meta.name ? label : prettyModelLabel(meta.name),
            }
          })
        if (models.length > 0) return sortModelsForDisplay(models, providers)
      } catch (err) {
        console.error('AI model discovery failed, using fallback list:', err.message ?? err)
      }
      return sortModelsForDisplay(
        FALLBACK_MODELS.filter((m) => providers.includes(m.id.split('/')[0])),
        providers
      )
    })()
    return modelsPromise
  }

  const updateItinerary = ai.defineTool(
    {
      name: 'updateItinerary',
      description:
        'Create or update the trip itinerary. All fields are optional — only what you provide is applied. Each listed day is replaced entirely; unlisted days are untouched. Can also set the trip name and summary, delete days via removeDates, and replace the hotel-stay list via hotelStays.',
      inputSchema: itineraryUpdateSchema,
      outputSchema: z.object({
        ok: z.boolean(),
        savedDays: z.array(z.string()),
        removedDays: z.array(z.string()),
        savedStays: z.number().optional(),
        savedFlightTrips: z.number().optional(),
        error: z.string().optional(),
      }),
    },
    async (input, { context }) => {
      const result = await applyItineraryUpdate(input, context)
      context.emit('trip', {})
      return result
    }
  )

  return {
    enabled: true,
    listModels,
    async respond({ model, trip, messages, storage, emit, username = null }) {
      // Sanitize on the way in too, so histories saved before sanitization
      // (or by other models) replay cleanly; compact old tool payloads —
      // the current trip state in the system prompt supersedes them.
      const history = sanitizeChatMessages(messages)
      const replayed = compactHistoryForModel(history)
      const { stream, response } = ai.generateStream({
        model,
        system: systemPrompt(trip),
        messages: replayed,
        tools: [updateItinerary],
        maxTurns: 24,
        context: { storage, tripId: trip.id, emit, username },
      })
      for await (const chunk of stream) {
        if (chunk.text) emit('text', { text: chunk.text })
      }
      const final = await response
      // Store the ORIGINAL history plus only the new turns — never the
      // compacted replay copy that final.messages echoes back.
      return appendNewTurns(history, replayed.length, final.messages)
    },
  }
}
