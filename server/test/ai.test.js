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
