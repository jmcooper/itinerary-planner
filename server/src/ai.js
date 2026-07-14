// AI agent for itinerary planning, built on Genkit so the model providers are
// configurable via .env API keys.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { genkit, z } from 'genkit'
import { anthropic } from '@genkit-ai/anthropic'
import { googleAI } from '@genkit-ai/google-genai'
import { buildMapsUrl } from './timeblocks.js'

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
        title: z.string().describe('Short title for the day'),
        waypoints: z
          .array(z.string())
          .describe(
            'Ordered place names for the day including where it starts and ends; used to build a Google Maps directions link'
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
      })
    )
    .optional()
    .describe('Full replacement for each listed day; days not listed are left unchanged'),
  removeDates: z
    .array(z.string())
    .optional()
    .describe('Dates (YYYY-MM-DD) to delete from the itinerary entirely'),
})

// Applies an updateItinerary tool call to the stored trip. Exported for tests.
export async function applyItineraryUpdate(input, { storage, tripId }) {
  const trip = await storage.readTrip(tripId)
  if (!trip) throw new Error(`trip ${tripId} not found`)
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
  for (const day of input.days ?? []) {
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
        travel: item.travel === true,
        imageIds: imagesByTitle.get(item.title) ?? [],
      })),
    }
    savedDays.push(day.date)
  }
  const removedDays = []
  for (const date of input.removeDates ?? []) {
    if (date in trip.days) {
      delete trip.days[date]
      removedDays.push(date)
    }
  }
  trip.updatedAt = new Date().toISOString()
  await storage.writeTrip(trip)
  return { ok: true, savedDays, removedDays }
}

// Reduces chat history to what every provider can replay: user/model/tool
// messages with text, toolRequest, and toolResponse parts. Thinking/reasoning
// parts carry provider-specific metadata (e.g. thought signatures) that other
// turns — or other models, since the user can switch models mid-chat — reject
// as unsupported, and the system message is rebuilt fresh each turn from the
// current trip state, so it must not be persisted either.
const REPLAYABLE_ROLES = new Set(['user', 'model', 'tool'])

export function sanitizeChatMessages(messages) {
  return (messages ?? [])
    .filter((message) => REPLAYABLE_ROLES.has(message.role))
    .map((message) => ({
      role: message.role,
      content: (message.content ?? [])
        .map((part) => {
          if (typeof part.text === 'string' && part.text !== '') return { text: part.text }
          if (part.toolRequest) return { toolRequest: part.toolRequest }
          if (part.toolResponse) return { toolResponse: part.toolResponse }
          return null
        })
        .filter(Boolean),
    }))
    .filter((message) => message.content.length > 0)
}

// Replaying every historical updateItinerary payload is the dominant token
// cost of a conversation, and the current trip state supersedes them anyway.
// When sending history to the model, swap old tool inputs for a short
// description of what the call did; the stored history keeps everything for
// display. Refs are preserved so tool responses still pair up.
export function compactHistoryForModel(messages) {
  return (messages ?? []).map((message) => ({
    ...message,
    content: message.content.map((part) => {
      const req = part.toolRequest
      if (!req || req.name !== 'updateItinerary') return part
      const input = req.input ?? {}
      const actions = []
      if (input.tripName) actions.push(`renamed the trip to "${input.tripName}"`)
      if (typeof input.summary === 'string') actions.push('updated the trip summary')
      const dates = (input.days ?? []).map((d) => d.date)
      if (dates.length) actions.push(`replaced days: ${dates.join(', ')}`)
      if (input.removeDates?.length) actions.push(`removed days: ${input.removeDates.join(', ')}`)
      return {
        toolRequest: {
          ...req,
          input: {
            compacted: actions.join('; ') || 'no changes',
            note: 'Superseded by the current trip state.',
          },
        },
      }
    }),
  }))
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
- Current itinerary (authoritative JSON — older versions referenced in the chat history have had their details omitted):
${Object.keys(days).length ? JSON.stringify(days, null, 1) : '(no days yet)'}

Rules:
- Whenever you create or change the itinerary, call the updateItinerary tool. Never describe an itinerary as saved unless the tool call succeeded.
- Batch changes: one updateItinerary call can (and should) carry every affected day in its days array. Do not make a separate call per day.
- Extract the trip name and the dates for each day from the user's description when creating a new itinerary.
- To delete days (e.g. "drop day 2", "cut the last day"), pass their dates in removeDates. Days may be non-contiguous — deleting a middle day leaves a gap.
- For each day, provide ordered waypoints (real place names, including where the day starts and ends) so the app can build a Google Maps link.
- Mark items that are pure travel between locations (driving, flying, transit) with travel: true, a short title like "Drive to Biscuit Basin", and accurate timeStart/timeEnd so the app can show the duration. Do not mark stops that merely include some walking.
- Item descriptions are markdown; keep them informative but compact (why it's worth doing, practical tips, distances/durations).
- Plan realistic timings, driving distances, and pacing. Respect the traveler's stated constraints.
- When replacing a day, carry forward the existing details you do not intend to change.
- In your conversational reply, briefly summarize what you planned or changed — the app displays the full itinerary, so do not repeat it verbatim.
- If the request is ambiguous or missing dates, ask before inventing details.`
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
        'Create or update the trip itinerary. All fields are optional — only what you provide is applied. Each listed day is replaced entirely; unlisted days are untouched. Can also set the trip name and summary, and delete days via removeDates.',
      inputSchema: itineraryUpdateSchema,
      outputSchema: z.object({
        ok: z.boolean(),
        savedDays: z.array(z.string()),
        removedDays: z.array(z.string()),
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
    async respond({ model, trip, messages, storage, emit }) {
      const { stream, response } = ai.generateStream({
        model,
        system: systemPrompt(trip),
        // Sanitize on the way in too, so histories saved before sanitization
        // (or by other models) replay cleanly; compact old tool payloads —
        // the current trip state in the system prompt supersedes them.
        messages: compactHistoryForModel(sanitizeChatMessages(messages)),
        tools: [updateItinerary],
        maxTurns: 24,
        context: { storage, tripId: trip.id, emit },
      })
      for await (const chunk of stream) {
        if (chunk.text) emit('text', { text: chunk.text })
      }
      const final = await response
      return sanitizeChatMessages(final.messages)
    },
  }
}
