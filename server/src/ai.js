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
          .describe(
            'Ordered place names for the day including where it starts and ends; used to build a Google Maps directions link'
          ),
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

// Applies an updateItinerary tool call to the stored trip. Exported for tests.
export async function applyItineraryUpdate(input, { storage, tripId }) {
  const trip = await storage.readTrip(tripId)
  if (!trip) throw new Error(`trip ${tripId} not found`)
  if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate) || input.endDate < input.startDate)
    throw new Error('startDate/endDate must be valid YYYY-MM-DD with endDate >= startDate')
  for (const day of input.days) {
    if (!DATE_RE.test(day.date)) throw new Error(`invalid day date: ${day.date} — use YYYY-MM-DD`)
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
        .map(
          (it) =>
            `    - ${it.timeStart ?? it.timeLabel ?? ''}${it.timeEnd ? `–${it.timeEnd}` : ''} ${it.title}`
        )
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
- Item descriptions are markdown; keep them informative but compact (why it's worth doing, practical tips, distances/durations).
- Plan realistic timings, driving distances, and pacing. Respect the traveler's stated constraints.
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
        'Create or update the trip itinerary. Replaces each listed day entirely; unlisted days are untouched. Also sets the trip name, summary, and date range.',
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
    listModels,
    async respond({ model, trip, messages, storage, emit }) {
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
