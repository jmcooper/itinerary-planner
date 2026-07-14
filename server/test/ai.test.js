import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStorage } from '../src/storage.js'
import {
  applyItineraryUpdate,
  prettyModelLabel,
  isDatedSnapshot,
  sortModelsForDisplay,
  sanitizeChatMessages,
  compactHistoryForModel,
  systemPrompt,
} from '../src/ai.js'

let dataDir
let storage

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-ai-'))
  storage = createStorage(dataDir)
  await storage.writeTrip({
    id: 'yellowstone',
    name: 'Planning…',
    ownerId: 'alice',
    startDate: null,
    endDate: null,
    summary: '',
    days: {
      '2026-07-01': {
        title: 'Old day',
        mapsUrl: '',
        items: [
          {
            timeStart: '08:00',
            timeEnd: null,
            timeLabel: null,
            title: 'Fountain Paint Pot',
            description: 'old',
            imageIds: ['img_keep'],
          },
        ],
      },
    },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  })
})

after(async () => rm(dataDir, { recursive: true, force: true }))

const baseInput = () => ({
  tripName: 'Yellowstone 2026',
  summary: 'Two days of geysers',
  days: [
    {
      date: '2026-07-01',
      title: 'West side geysers',
      waypoints: ['West Yellowstone', 'Fountain Paint Pot', 'Old Faithful'],
      items: [
        { timeStart: '08:15', timeEnd: '08:45', title: 'Fountain Paint Pot', description: '**Great** stop.' },
        { timeStart: '08:45', timeEnd: '09:00', title: 'Drive to Old Faithful', description: '', travel: true },
        { timeStart: null, timeEnd: null, title: 'Picnic lunch', description: 'Relax.' },
      ],
    },
  ],
})

test('applyItineraryUpdate writes days, name, summary, maps link', async () => {
  const result = await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  assert.deepEqual(result, { ok: true, savedDays: ['2026-07-01'], removedDays: [] })
  const trip = await storage.readTrip('yellowstone')
  assert.equal(trip.name, 'Yellowstone 2026')
  assert.equal(trip.summary, 'Two days of geysers')
  const day = trip.days['2026-07-01']
  assert.equal(day.title, 'West side geysers')
  assert.ok(day.mapsUrl.includes('origin=West%20Yellowstone'))
  assert.equal(day.items.length, 3)
  assert.equal(day.items[0].timeStart, '08:15')
  // travel flag persists; absent means false
  assert.equal(day.items[0].travel, false)
  assert.equal(day.items[1].travel, true)
  // imageIds carried forward when the item title matches the old day
  assert.deepEqual(day.items[0].imageIds, ['img_keep'])
  assert.deepEqual(day.items[2].imageIds, [])
})

test('applyItineraryUpdate applies partial updates (summary only)', async () => {
  await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  const before = await storage.readTrip('yellowstone')

  const result = await applyItineraryUpdate(
    { summary: 'Just a new summary' },
    { storage, tripId: 'yellowstone' }
  )
  assert.deepEqual(result, { ok: true, savedDays: [], removedDays: [] })
  const after = await storage.readTrip('yellowstone')
  assert.equal(after.summary, 'Just a new summary')
  assert.equal(after.name, before.name)
  assert.deepEqual(after.days, before.days)
})

test('applyItineraryUpdate handles removeDates without days or summary', async () => {
  await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  const before = await storage.readTrip('yellowstone')
  const result = await applyItineraryUpdate(
    { removeDates: ['2026-07-01'] },
    { storage, tripId: 'yellowstone' }
  )
  assert.deepEqual(result, { ok: true, savedDays: [], removedDays: ['2026-07-01'] })
  const after = await storage.readTrip('yellowstone')
  assert.ok(!('2026-07-01' in after.days))
  assert.equal(after.summary, before.summary) // untouched without an explicit summary
})

test('applyItineraryUpdate removes days listed in removeDates', async () => {
  await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  const input = { summary: 'One day now', days: [], removeDates: ['2026-07-01', '2026-07-09'] }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.deepEqual(result, { ok: true, savedDays: [], removedDays: ['2026-07-01'] })
  const trip = await storage.readTrip('yellowstone')
  assert.ok(!('2026-07-01' in trip.days))
})

test('applyItineraryUpdate rejects bad date and time formats', async () => {
  const badDate = baseInput()
  badDate.days[0].date = 'July 1'
  await assert.rejects(() => applyItineraryUpdate(badDate, { storage, tripId: 'yellowstone' }), /YYYY-MM-DD/)

  const badRemove = { summary: 's', days: [], removeDates: ['tomorrow'] }
  await assert.rejects(() => applyItineraryUpdate(badRemove, { storage, tripId: 'yellowstone' }), /removeDates/)

  const badTime = baseInput()
  badTime.days[0].items[0].timeStart = '8:15 am'
  await assert.rejects(() => applyItineraryUpdate(badTime, { storage, tripId: 'yellowstone' }), /HH:MM/)
})

test('applyItineraryUpdate fails for a missing trip', async () => {
  await assert.rejects(() => applyItineraryUpdate(baseInput(), { storage, tripId: 'nope' }), /not found/)
})

test('sanitizeChatMessages keeps only replayable message parts', () => {
  const messages = [
    // The system prompt is rebuilt each turn from trip state — never replayed
    { role: 'system', content: [{ text: 'You are a travel assistant' }] },
    { role: 'user', content: [{ text: 'Plan my trip' }] },
    {
      role: 'model',
      content: [
        // Thinking output with provider-specific metadata (e.g. Gemini
        // thoughtSignature) is not replayable across turns/providers.
        { reasoning: '', metadata: { thoughtSignature: 'CAIS...' } },
        { text: 'Done!', metadata: { extra: true } },
        { toolRequest: { name: 'updateItinerary', ref: '0', input: { days: [] } } },
        { custom: { something: 1 } },
      ],
    },
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true } } }],
    },
    // A message left with no replayable parts is dropped entirely
    { role: 'model', content: [{ reasoning: 'thinking…' }] },
  ]
  assert.deepEqual(sanitizeChatMessages(messages), [
    { role: 'user', content: [{ text: 'Plan my trip' }] },
    {
      role: 'model',
      content: [
        { text: 'Done!' },
        { toolRequest: { name: 'updateItinerary', ref: '0', input: { days: [] } } },
      ],
    },
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true } } }],
    },
  ])
})

test('compactHistoryForModel stubs out old tool payloads but keeps the dialogue', () => {
  const bigDay = {
    date: '2026-07-01',
    title: 'Geysers',
    waypoints: ['A', 'B'],
    items: [{ timeStart: '08:00', timeEnd: null, title: 'Go', description: 'x'.repeat(500) }],
  }
  const messages = [
    { role: 'user', content: [{ text: 'Plan my trip, no strenuous hikes' }] },
    {
      role: 'model',
      content: [
        { text: 'Here is the plan.' },
        {
          toolRequest: {
            name: 'updateItinerary',
            ref: '0',
            input: { tripName: 'Yellowstone', summary: 's', days: [bigDay], removeDates: ['2026-07-05'] },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        { toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true, savedDays: ['2026-07-01'], removedDays: ['2026-07-05'] } } },
      ],
    },
    { role: 'user', content: [{ text: 'Make day 1 end earlier' }] },
  ]

  const compacted = compactHistoryForModel(messages)

  // Dialogue text is untouched
  assert.deepEqual(compacted[0], messages[0])
  assert.deepEqual(compacted[1].content[0], { text: 'Here is the plan.' })
  assert.deepEqual(compacted[3], messages[3])

  // The bulky tool input is replaced with a compact description
  const stub = compacted[1].content[1].toolRequest
  assert.equal(stub.name, 'updateItinerary')
  assert.equal(stub.ref, '0') // ref preserved so the tool response still pairs up
  const stubText = JSON.stringify(stub.input)
  assert.ok(stubText.length < 250, `stub should be small, got ${stubText.length}`)
  assert.match(stubText, /2026-07-01/)
  assert.match(stubText, /2026-07-05/)
  assert.ok(!stubText.includes('xxxxx'), 'day content must not be replayed')

  // Tool responses pass through (already tiny) and inputs are not mutated in place
  assert.deepEqual(compacted[2], messages[2])
  assert.ok(messages[1].content[1].toolRequest.input.days[0].items[0].description.length === 500)
})

test('systemPrompt embeds the full current itinerary details', () => {
  const trip = {
    name: 'Yellowstone',
    summary: 'Fun',
    days: {
      '2026-07-01': {
        title: 'Geysers',
        mapsUrl: 'https://www.google.com/maps/dir/?api=1&origin=A&destination=B',
        items: [
          {
            timeStart: '08:00',
            timeEnd: '08:30',
            timeLabel: null,
            title: 'Fountain Paint Pot',
            description: 'Easy **boardwalk** stop.',
            travel: false,
            imageIds: ['img_secret'],
          },
        ],
      },
    },
  }
  const prompt = systemPrompt(trip)
  assert.match(prompt, /Fountain Paint Pot/)
  assert.match(prompt, /Easy \*\*boardwalk\*\* stop\./) // full descriptions included
  assert.match(prompt, /maps\.google|google\.com\/maps/) // maps link retained for waypoint context
  assert.ok(!prompt.includes('img_secret'), 'image ids are noise for the model')
})

test('prettyModelLabel humanizes model ids', () => {
  assert.equal(prettyModelLabel('anthropic/claude-opus-4-5'), 'Claude Opus 4.5')
  assert.equal(prettyModelLabel('anthropic/claude-sonnet-4-6'), 'Claude Sonnet 4.6')
  assert.equal(prettyModelLabel('anthropic/claude-opus-4'), 'Claude Opus 4')
  assert.equal(prettyModelLabel('googleai/gemini-2.5-flash'), 'Gemini 2.5 Flash')
})

test('isDatedSnapshot detects dated model id variants', () => {
  assert.equal(isDatedSnapshot('anthropic/claude-haiku-4-5-20251001'), true)
  assert.equal(isDatedSnapshot('anthropic/claude-haiku-4-5'), false)
  assert.equal(isDatedSnapshot('googleai/gemini-2.5-flash'), false)
})

test('sortModelsForDisplay groups by provider and orders newest to oldest', () => {
  const ids = [
    'anthropic/claude-opus-4',
    'googleai/gemini-2.5-flash',
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-5',
    'googleai/gemini-3.1-pro',
    'anthropic/claude-opus-4-1',
    'anthropic/claude-sonnet-4-6',
  ]
  const sorted = sortModelsForDisplay(
    ids.map((id) => ({ id, label: id })),
    ['anthropic', 'googleai']
  )
  assert.deepEqual(
    sorted.map((m) => m.id),
    [
      'anthropic/claude-sonnet-5', // 5 > 4.x
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-1',
      'anthropic/claude-opus-4', // 4 alone is older than 4.1
      'googleai/gemini-3.1-pro',
      'googleai/gemini-2.5-flash',
    ]
  )
  // provider display names attached
  assert.equal(sorted[0].provider, 'Anthropic')
  assert.equal(sorted[5].provider, 'Google')
})
