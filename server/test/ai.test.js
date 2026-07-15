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
  appendNewTurns,
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

test('applyItineraryUpdate rejects a no-op call with guidance instead of silent success', async () => {
  await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  const before = await storage.readTrip('yellowstone')

  const result = await applyItineraryUpdate({}, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.savedDays, [])
  assert.deepEqual(result.removedDays, [])
  assert.match(result.error, /No changes received/)
  assert.match(result.error, /days/)

  const after = await storage.readTrip('yellowstone')
  assert.equal(after.updatedAt, before.updatedAt) // nothing written
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

const stayInput = () => ({
  hotelStays: [
    {
      hotelName: 'Holiday Inn West Yellowstone',
      hotelAddress: '315 Yellowstone Ave, West Yellowstone, MT',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }],
    },
  ],
})

test('applyItineraryUpdate saves hotelStays alone and reports savedStays', async () => {
  const result = await applyItineraryUpdate(stayInput(), { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, true)
  assert.equal(result.savedStays, 1)
  assert.deepEqual(result.savedDays, [])
  const trip = await storage.readTrip('yellowstone')
  assert.deepEqual(trip.hotelStays, stayInput().hotelStays)
})

test('applyItineraryUpdate replaces the whole stay list; [] clears it', async () => {
  await applyItineraryUpdate(stayInput(), { storage, tripId: 'yellowstone' })
  const result = await applyItineraryUpdate({ hotelStays: [] }, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, true)
  assert.equal(result.savedStays, 0)
  const trip = await storage.readTrip('yellowstone')
  assert.deepEqual(trip.hotelStays, [])
})

test('applyItineraryUpdate saves confirmations with rooms', async () => {
  const input = {
    hotelStays: [
      {
        hotelName: 'Canyon Lodge & Cabins',
        hotelAddress: '41 Clover Ln, Yellowstone National Park, WY',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-19',
        confirmations: [
          {
            confirmationNumber: '20869678',
            rooms: [{ roomType: 'Western Cabin', guests: 'Jim & Kathy' }],
          },
          { confirmationNumber: '20871144' },
        ],
      },
    ],
  }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, true)
  const trip = await storage.readTrip('yellowstone')
  assert.deepEqual(trip.hotelStays[0].confirmations, [
    {
      confirmationNumber: '20869678',
      rooms: [{ roomType: 'Western Cabin', guests: 'Jim & Kathy' }],
    },
    { confirmationNumber: '20871144', rooms: [] },
  ])
})

test('applyItineraryUpdate rejects the legacy confirmationNumber key with a hint', async () => {
  const input = {
    hotelStays: [
      {
        hotelName: 'Canyon Lodge & Cabins',
        hotelAddress: '',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-19',
        confirmationNumber: '20869678',
      },
    ],
  }
  const result = await applyItineraryUpdate(input, { storage, tripId: 'yellowstone' })
  assert.equal(result.ok, false)
  assert.match(result.error, /replaced by confirmations/)
})

test('systemPrompt states the confirmation/room rules', () => {
  const prompt = systemPrompt({ name: 'X', summary: '', days: {} })
  assert.match(prompt, /one entry per confirmation number/)
  assert.match(prompt, /ask whether it goes under an existing one/)
  assert.match(prompt, /never invent them/)
})

test('applyItineraryUpdate returns ok:false (not throw) for invalid stays', async () => {
  const before = await storage.readTrip('yellowstone')
  for (const hotelStays of [
    [{ hotelName: 'X', checkInDay: 'July 18', checkOutDay: '2026-07-21' }],
    [{ hotelName: 'X', checkInDay: '2026-07-21', checkOutDay: '2026-07-18' }],
    [{ hotelName: '', checkInDay: '2026-07-18', checkOutDay: '2026-07-21' }],
  ]) {
    const result = await applyItineraryUpdate({ hotelStays }, { storage, tripId: 'yellowstone' })
    assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(hotelStays)}`)
    assert.ok(result.error)
  }
  const after = await storage.readTrip('yellowstone')
  assert.equal(after.updatedAt, before.updatedAt) // nothing written
})

// ---- Linked-day write-through ----

async function seedLinkedPair(suffix) {
  const targetId = `target-${suffix}`
  const linkerId = `linker-${suffix}`
  await storage.writeTrip({
    id: targetId,
    name: 'Target Trip',
    ownerId: 'alice',
    days: {
      '2026-07-18': {
        title: 'Original day',
        mapsUrl: '',
        items: [
          { timeStart: '09:00', timeEnd: null, timeLabel: null, title: 'Shared stop', description: 'old', imageIds: ['img_linked'] },
        ],
      },
    },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  })
  await storage.writeTrip({
    id: linkerId,
    name: 'Linker Trip',
    ownerId: 'bob',
    sharedWith: [],
    days: { '2026-07-18': { linkedTripId: targetId } },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  })
  return { targetId, linkerId }
}

const linkedDayInput = () => ({
  days: [
    {
      date: '2026-07-18',
      title: 'Rewritten day',
      waypoints: ['A', 'B'],
      items: [
        { timeStart: '10:00', timeEnd: null, title: 'Shared stop', description: 'new details' },
      ],
    },
  ],
})

test('linked day edits write through to the target trip, keeping the link', async () => {
  const { targetId, linkerId } = await seedLinkedPair('wt')
  const result = await applyItineraryUpdate(linkedDayInput(), { storage, tripId: linkerId })
  assert.equal(result.ok, true)
  assert.deepEqual(result.savedDays, ['2026-07-18'])

  const target = await storage.readTrip(targetId)
  assert.equal(target.days['2026-07-18'].title, 'Rewritten day')
  assert.equal(target.days['2026-07-18'].items[0].description, 'new details')
  // imageIds carried forward from the TARGET's items by title
  assert.deepEqual(target.days['2026-07-18'].items[0].imageIds, ['img_linked'])

  const linker = await storage.readTrip(linkerId)
  assert.deepEqual(linker.days['2026-07-18'], { linkedTripId: targetId }) // marker intact
})

test('write-through refuses when the user cannot edit the target', async () => {
  const { targetId, linkerId } = await seedLinkedPair('perm')
  const result = await applyItineraryUpdate(linkedDayInput(), {
    storage,
    tripId: linkerId,
    username: 'bob', // owns the linker but not the target
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Target Trip/)
  const target = await storage.readTrip(targetId)
  assert.equal(target.days['2026-07-18'].title, 'Original day') // untouched
})

test('a broken link is replaced locally instead of dropping the content', async () => {
  const { linkerId } = await seedLinkedPair('broken')
  const linker = await storage.readTrip(linkerId)
  linker.days['2026-07-18'] = { linkedTripId: 'no-such-trip' }
  await storage.writeTrip(linker)

  const result = await applyItineraryUpdate(linkedDayInput(), { storage, tripId: linkerId })
  assert.equal(result.ok, true)
  const after = await storage.readTrip(linkerId)
  assert.equal(after.days['2026-07-18'].title, 'Rewritten day')
  assert.ok(!after.days['2026-07-18'].linkedTripId)
})

test('removing a linked day removes only the link, not the target day', async () => {
  const { targetId, linkerId } = await seedLinkedPair('rm')
  const result = await applyItineraryUpdate(
    { removeDates: ['2026-07-18'] },
    { storage, tripId: linkerId }
  )
  assert.deepEqual(result.removedDays, ['2026-07-18'])
  assert.ok(!('2026-07-18' in (await storage.readTrip(linkerId)).days))
  assert.equal((await storage.readTrip(targetId)).days['2026-07-18'].title, 'Original day')
})

test('day replacement carries hotelNotNeeded forward; explicit value wins', async () => {
  // seed the flag on the existing day
  const flagged = baseInput()
  flagged.days[0].hotelNotNeeded = true
  await applyItineraryUpdate(flagged, { storage, tripId: 'yellowstone' })
  assert.equal((await storage.readTrip('yellowstone')).days['2026-07-01'].hotelNotNeeded, true)

  // replace the day without mentioning the flag — it survives
  await applyItineraryUpdate(baseInput(), { storage, tripId: 'yellowstone' })
  assert.equal((await storage.readTrip('yellowstone')).days['2026-07-01'].hotelNotNeeded, true)

  // explicit false clears it
  const cleared = baseInput()
  cleared.days[0].hotelNotNeeded = false
  await applyItineraryUpdate(cleared, { storage, tripId: 'yellowstone' })
  assert.ok(!('hotelNotNeeded' in (await storage.readTrip('yellowstone')).days['2026-07-01']))
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

test('sanitizeChatMessages coalesces adjacent streamed text chunks', () => {
  const messages = [
    {
      role: 'model',
      content: [
        { text: 'Done' },
        { text: '! I updated confirmation #' },
        { text: '89903962) for you.\n\nAnything else?' },
        { toolRequest: { name: 'updateItinerary', ref: '1', input: {} } },
        { text: 'After the tool.' },
      ],
    },
  ]
  assert.deepEqual(sanitizeChatMessages(messages), [
    {
      role: 'model',
      content: [
        // One part per contiguous run — real line breaks inside the text stay.
        { text: 'Done! I updated confirmation #89903962) for you.\n\nAnything else?' },
        { toolRequest: { name: 'updateItinerary', ref: '1', input: {} } },
        { text: 'After the tool.' },
      ],
    },
  ])
})

test('compactHistoryForModel compacts older tool pairs but keeps the latest intact', () => {
  const bigDay = {
    date: '2026-07-01',
    title: 'Geysers',
    waypoints: ['A', 'B'],
    items: [{ timeStart: '08:00', timeEnd: null, title: 'Go', description: 'x'.repeat(500) }],
  }
  const call = (input) => ({ toolRequest: { name: 'updateItinerary', ref: '0', input } })
  const resp = () => ({
    toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true, savedDays: ['2026-07-01'], removedDays: [] } },
  })
  const messages = [
    { role: 'user', content: [{ text: 'Plan my trip, no strenuous hikes' }] },
    {
      role: 'model',
      content: [
        { text: 'Here is the plan.' },
        call({ tripName: 'Yellowstone', summary: 's', days: [bigDay], removeDates: ['2026-07-05'] }),
      ],
    },
    { role: 'tool', content: [resp()] },
    { role: 'user', content: [{ text: 'Make day 1 end earlier' }] },
    { role: 'model', content: [{ text: 'Adjusted.' }, call({ days: [bigDay] })] },
    { role: 'tool', content: [resp()] },
    { role: 'user', content: [{ text: 'Thanks' }] },
  ]

  const compacted = compactHistoryForModel(messages)

  // The OLDER pair became a SYSTEM note in the user voice — never assistant
  // text, which models would imitate instead of calling the tool.
  assert.deepEqual(compacted[0], messages[0])
  assert.deepEqual(compacted[1], { role: 'model', content: [{ text: 'Here is the plan.' }] })
  assert.equal(compacted[2].role, 'user')
  const note = compacted[2].content[0].text
  assert.match(note, /^\[System note/)
  assert.match(note, /2026-07-01/)
  assert.match(note, /2026-07-05/)
  assert.match(note, /renamed the trip to "Yellowstone"/)
  assert.ok(note.length < 250, `note should be small, got ${note.length}`)
  assert.ok(!note.includes('xxxxx'), 'old day content must not be replayed')

  // The LATEST exchange survives verbatim — a correct worked example
  const keptModel = compacted.find((m) => m.content.some((p) => p.toolRequest))
  assert.ok(keptModel, 'latest tool call kept')
  assert.equal(keptModel.content[1].toolRequest.input.days[0].date, '2026-07-01')
  assert.ok(
    compacted.some((m) => m.content.some((p) => p.toolResponse)),
    'latest tool response kept'
  )

  // user, model, note, user, model(real call), tool, user — old tool msg gone
  assert.equal(compacted.length, 7)

  // Stored messages are not mutated in place
  assert.equal(messages[1].content[1].toolRequest.input.days[0].items[0].description.length, 500)
  assert.equal(messages.length, 7)
})

test('compactHistoryForModel scrubs note-styled text from model messages', () => {
  // Old builds stored compaction notes into model text, and a confused model
  // once wrote a fake note claiming success. Neither may replay as
  // assistant prose.
  const messages = [
    { role: 'user', content: [{ text: 'add the stay' }] },
    {
      role: 'model',
      content: [
        { text: '[Applied itinerary update — replaced hotel stays (2)]\n\nDone! Your stay is recorded.' },
      ],
    },
    { role: 'model', content: [{ text: '[Applied itinerary update — no changes]' }] },
    { role: 'model', content: [{ text: '[Applied itinerary update — no changes]' }] },
    { role: 'user', content: [{ text: 'thanks' }] },
  ]
  const compacted = compactHistoryForModel(messages)
  const modelTexts = compacted
    .filter((m) => m.role === 'model')
    .flatMap((m) => m.content.map((p) => p.text ?? ''))
  assert.ok(
    modelTexts.every((t) => !t.includes('[Applied itinerary update')),
    'no note-styled assistant text may replay'
  )
  assert.ok(
    modelTexts.every((t) => !t.includes('Done! Your stay is recorded')),
    'fake success prose is dropped with its note'
  )
  // The legit information moves to system notes, coalesced into one message
  const noteMessages = compacted.filter(
    (m) => m.role === 'user' && m.content.some((p) => p.text?.startsWith('[System note'))
  )
  assert.equal(noteMessages.length, 1)
  assert.equal(noteMessages[0].content.length, 3)
  assert.match(noteMessages[0].content[0].text, /replaced hotel stays \(2\)/)
})

test('appendNewTurns keeps the stored history intact and adds only new turns', () => {
  const history = [
    { role: 'user', content: [{ text: 'hi' }] },
    {
      role: 'model',
      content: [
        { text: 'made it' },
        { toolRequest: { name: 'updateItinerary', ref: '0', input: { summary: 'old' } } },
      ],
    },
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true, savedDays: [], removedDays: [] } } }],
    },
    { role: 'user', content: [{ text: 'again' }] },
  ]
  const replayed = compactHistoryForModel(history)
  // Genkit echoes the system prompt + the replay copy back in final.messages
  const finalMessages = [
    { role: 'system', content: [{ text: 'prompt' }] },
    ...replayed,
    {
      role: 'model',
      content: [
        { text: 'done' },
        { toolRequest: { name: 'updateItinerary', ref: '0', input: { summary: 'new' } } },
      ],
    },
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'updateItinerary', ref: '0', output: { ok: true, savedDays: [], removedDays: [] } } }],
    },
  ]
  const stored = appendNewTurns(history, replayed.length, finalMessages)
  assert.equal(stored.length, history.length + 2)
  // The original REAL tool call is still stored — not a compacted note
  assert.deepEqual(stored.slice(0, 4), history)
  assert.ok(stored[1].content.some((p) => p.toolRequest?.input?.summary === 'old'))
  assert.ok(stored[4].content.some((p) => p.toolRequest?.input?.summary === 'new'))
})

test('compactHistoryForModel notes hotel-stay replacements', () => {
  const messages = [
    {
      role: 'model',
      content: [
        {
          toolRequest: {
            name: 'updateItinerary',
            ref: '0',
            input: { hotelStays: [{ hotelName: 'A' }, { hotelName: 'B' }] },
          },
        },
      ],
    },
    // a later exchange, so the hotel one is "older" and gets compacted
    {
      role: 'model',
      content: [{ toolRequest: { name: 'updateItinerary', ref: '0', input: { summary: 's' } } }],
    },
  ]
  const compacted = compactHistoryForModel(messages)
  assert.equal(compacted[0].role, 'user') // system note, never assistant text
  assert.match(compacted[0].content[0].text, /replaced hotel stays \(2\)/)
})

test('systemPrompt embeds hotel stays and the coverage rules', () => {
  const trip = {
    name: 'Yellowstone',
    summary: '',
    days: {},
    hotelStays: [
      {
        hotelName: 'Holiday Inn West Yellowstone',
        hotelAddress: '315 Yellowstone Ave',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-21',
        confirmations: [{ confirmationNumber: 'ABC123', rooms: [] }],
      },
    ],
  }
  const prompt = systemPrompt(trip)
  assert.match(prompt, /Holiday Inn West Yellowstone/)
  assert.match(prompt, /ABC123/)
  assert.match(prompt, /checkOutDay \(exclusive\)/)
  assert.match(prompt, /Never invent a check-in date, check-out date, or confirmation number/)
  // Without stays the section reads (none)
  assert.match(systemPrompt({ name: 'X', summary: '', days: {} }), /Hotel stays[^\n]*\(none\)/)
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
