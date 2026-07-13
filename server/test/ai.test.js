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
  startDate: '2026-07-01',
  endDate: '2026-07-02',
  days: [
    {
      date: '2026-07-01',
      title: 'West side geysers',
      waypoints: ['West Yellowstone', 'Fountain Paint Pot', 'Old Faithful'],
      items: [
        { timeStart: '08:15', timeEnd: '08:45', title: 'Fountain Paint Pot', description: '**Great** stop.' },
        { timeStart: null, timeEnd: null, title: 'Picnic lunch', description: 'Relax.' },
      ],
    },
  ],
})

test('applyItineraryUpdate writes days, name, dates, summary, maps link', async () => {
  const result = await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  assert.deepEqual(result, { ok: true, savedDays: ['2026-07-01'] })
  const trip = await storage.readTrip('yellowstone')
  assert.equal(trip.name, 'Yellowstone 2026')
  assert.equal(trip.summary, 'Two days of geysers')
  assert.equal(trip.startDate, '2026-07-01')
  assert.equal(trip.endDate, '2026-07-02')
  const day = trip.days['2026-07-01']
  assert.equal(day.title, 'West side geysers')
  assert.ok(day.mapsUrl.includes('origin=West%20Yellowstone'))
  assert.equal(day.items.length, 2)
  assert.equal(day.items[0].timeStart, '08:15')
  // imageIds carried forward when the item title matches the old day
  assert.deepEqual(day.items[0].imageIds, ['img_keep'])
  assert.deepEqual(day.items[1].imageIds, [])
})

test('applyItineraryUpdate rejects days outside the trip range', async () => {
  const input = baseInput()
  input.days[0].date = '2026-07-09'
  await assert.rejects(
    () => applyItineraryUpdate(input, { storage, tripId: 'yellowstone' }),
    /outside the trip range/
  )
})

test('applyItineraryUpdate rejects bad date and time formats', async () => {
  const badDate = { ...baseInput(), startDate: 'July 1' }
  await assert.rejects(() => applyItineraryUpdate(badDate, { storage, tripId: 'yellowstone' }), /YYYY-MM-DD/)

  const badTime = baseInput()
  badTime.days[0].items[0].timeStart = '8:15 am'
  await assert.rejects(() => applyItineraryUpdate(badTime, { storage, tripId: 'yellowstone' }), /HH:MM/)
})

test('applyItineraryUpdate fails for a missing trip', async () => {
  await assert.rejects(() => applyItineraryUpdate(baseInput(), { storage, tripId: 'nope' }), /not found/)
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
