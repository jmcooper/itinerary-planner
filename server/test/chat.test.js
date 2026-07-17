import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

// Scripted fake agent: emits text, performs one itinerary write, returns history.
function fakeAgent() {
  const agent = {
    enabled: true,
    lastModel: null,
    listModels: async () => [
      { id: 'fake/model', label: 'Fake Model' },
      { id: 'fake/other', label: 'Other Model' },
    ],
    async respond({ model, trip, messages, storage, emit }) {
      agent.lastModel = model
      emit('text', { text: 'Planning your trip' })
      const fresh = await storage.readTrip(trip.id)
      fresh.name = 'Yellowstone 2026'
      fresh.summary = 'Two days in Yellowstone'
      fresh.days = {
        '2026-07-01': {
          title: 'West side',
          mapsUrl: '',
          items: [
            {
              timeStart: '08:00',
              timeEnd: null,
              timeLabel: null,
              title: 'Go',
              description: 'd',
              imageIds: [],
            },
          ],
        },
      }
      await storage.writeTrip(fresh)
      emit('trip', {})
      return [...messages, { role: 'model', content: [{ text: 'Planning your trip' }] }]
    },
  }
  return agent
}

let app
let dataDir
let alice
let agent

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-chat-'))
  agent = fakeAgent()
  app = createApp(dataDir, { agent })
  alice = request.agent(app)
  await alice.post('/api/auth/register').send({ username: 'alice', password: 'correct horse' })
})

after(async () => rm(dataDir, { recursive: true, force: true }))

test('GET /api/ai/status reports the injected agent and its models', async () => {
  const res = await request(app).get('/api/ai/status')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, {
    enabled: true,
    models: [
      { id: 'fake/model', label: 'Fake Model' },
      { id: 'fake/other', label: 'Other Model' },
    ],
  })
})

test('POST /api/trips/ai creates a placeholder trip from a description', async () => {
  const res = await alice
    .post('/api/trips/ai')
    .send({ description: 'Trip to Yellowstone with my wife in July' })
  assert.equal(res.status, 201)
  assert.equal(res.body.ownerId, 'alice')
  assert.equal(res.body.aiCreated, true)
  assert.ok(res.body.name.length > 0)
  assert.deepEqual(res.body.days, {})
})

test('POST /api/trips/ai requires auth and a description', async () => {
  assert.equal((await request(app).post('/api/trips/ai').send({ description: 'x' })).status, 401)
  assert.equal((await alice.post('/api/trips/ai').send({})).status, 400)
})

// The final trip event carries the renamed id when the agent's first naming
// re-slugged the trip.
function finalTripId(sseText, fallback) {
  const ids = [...sseText.matchAll(/event: trip\ndata: (\{[^\n]*\})/g)]
    .map((m) => JSON.parse(m[1]).id)
    .filter(Boolean)
  return ids[ids.length - 1] ?? fallback
}

test('chat endpoints stream SSE and persist history', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Yellowstone' })
  const id = created.body.id
  const res = await alice.post(`/api/trips/${id}/chat`).send({ message: 'Plan my trip' })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.match(res.text, /event: text/)
  assert.match(res.text, /event: trip/)
  assert.match(res.text, /event: done/)

  // The agent named the trip, so its provisional prompt-derived slug was
  // replaced with a name-based one ("Yellowstone 2026" already has the year).
  const newId = finalTripId(res.text, id)
  assert.match(newId, /^yellowstone-2026-[0-9a-f]{6}$/)
  assert.equal((await alice.get(`/api/trips/${id}`)).status, 404) // old id gone

  const hist = await alice.get(`/api/trips/${newId}/chat`)
  assert.equal(hist.status, 200)
  assert.equal(hist.body.messages.length, 2)
  assert.equal(hist.body.messages[0].role, 'user')
  assert.equal(hist.body.messages[1].role, 'model')

  const trip = await alice.get(`/api/trips/${newId}`)
  assert.equal(trip.body.name, 'Yellowstone 2026')
  assert.equal(trip.body.summary, 'Two days in Yellowstone')
  assert.equal(trip.body.provisionalSlug, undefined)

  // The rename happens exactly once: another turn keeps the slug.
  const again = await alice.post(`/api/trips/${newId}/chat`).send({ message: 'More' })
  assert.equal(finalTripId(again.text, newId), newId)
})

test('manually renaming or re-slugging stops the agent rename', async () => {
  const viaName = (await alice.post('/api/trips/ai').send({ description: 'Named by hand' })).body
  await alice.put(`/api/trips/${viaName.id}`).send({ name: 'My Own Name' })
  const res1 = await alice.post(`/api/trips/${viaName.id}/chat`).send({ message: 'Plan' })
  assert.equal(finalTripId(res1.text, viaName.id), viaName.id) // no rename

  const viaSlug = (await alice.post('/api/trips/ai').send({ description: 'Slugged by hand' })).body
  await alice.put(`/api/trips/${viaSlug.id}`).send({ slug: 'my-chosen-url' })
  const res2 = await alice.post('/api/trips/my-chosen-url/chat').send({ message: 'Plan' })
  assert.equal(finalTripId(res2.text, 'my-chosen-url'), 'my-chosen-url')
})

test('chat rejects an empty message', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Anywhere' })
  const res = await alice.post(`/api/trips/${created.body.id}/chat`).send({ message: '  ' })
  assert.equal(res.status, 400)
})

test('chat passes the requested model through and rejects unknown models', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Model test' })
  let id = created.body.id
  const ok = await alice.post(`/api/trips/${id}/chat`).send({ message: 'hi', model: 'fake/other' })
  assert.equal(ok.status, 200)
  assert.equal(agent.lastModel, 'fake/other')
  id = finalTripId(ok.text, id) // first naming renames the slug

  // Defaults to the first available model when none is given
  await alice.post(`/api/trips/${id}/chat`).send({ message: 'hi again' })
  assert.equal(agent.lastModel, 'fake/model')

  const bad = await alice.post(`/api/trips/${id}/chat`).send({ message: 'hi', model: 'nope/nope' })
  assert.equal(bad.status, 400)
})

test('chat requires edit permission', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Private trip' })
  const id = created.body.id
  // Anonymous viewers can't see a private trip at all
  assert.equal((await request(app).get(`/api/trips/${id}/chat`)).status, 404)
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
  assert.deepEqual(status.body, { enabled: false, models: [] })
})

test('GET /api/trips/:id/chat reports pending while a response is in flight', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const slowAgent = {
    enabled: true,
    listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
    async respond({ messages, emit }) {
      emit('text', { text: 'working' })
      await gate
      return [...messages, { role: 'model', content: [{ text: 'done' }] }]
    },
  }
  const slowApp = createApp(dataDir, { agent: slowAgent })
  const dana = request.agent(slowApp)
  await dana.post('/api/auth/register').send({ username: 'dana', password: 'correct horse' })
  const created = await dana.post('/api/trips/ai').send({ description: 'Slow trip' })
  const id = created.body.id

  const inFlight = dana.post(`/api/trips/${id}/chat`).send({ message: 'take your time' }).then((r) => r)
  await new Promise((r) => setTimeout(r, 100)) // let the handler start

  const during = await dana.get(`/api/trips/${id}/chat`)
  assert.equal(during.body.pending, true)
  const blocked = await dana.post(`/api/trips/${id}/chat`).send({ message: 'me too' })
  assert.equal(blocked.status, 409)

  release()
  const first = await inFlight
  assert.equal(first.status, 200)
  const after = await dana.get(`/api/trips/${id}/chat`)
  assert.equal(after.body.pending, false)
  assert.equal(after.body.messages.length, 2)
})

test('a hung generation times out, frees the lock, and reports an error', async () => {
  const hungAgent = {
    enabled: true,
    listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
    respond: () => new Promise(() => {}), // never settles
  }
  const hungApp = createApp(dataDir, { agent: hungAgent, chatTimeoutMs: 60 })
  const erin = request.agent(hungApp)
  await erin.post('/api/auth/register').send({ username: 'erin', password: 'correct horse' })
  const created = await erin.post('/api/trips/ai').send({ description: 'Hung trip' })
  const id = created.body.id

  const res = await erin.post(`/api/trips/${id}/chat`).send({ message: 'hello' })
  assert.equal(res.status, 200)
  assert.match(res.text, /event: error/)
  assert.match(res.text, /took too long/)

  // Lock is released: pending is false and a new request is accepted
  const status = await erin.get(`/api/trips/${id}/chat`)
  assert.equal(status.body.pending, false)
  const retry = await erin.post(`/api/trips/${id}/chat`).send({ message: 'retry' })
  assert.equal(retry.status, 200)
})

test('a stalled stream frees the chat lock quickly and keeps the message', async () => {
  const stallAgent = {
    enabled: true,
    listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
    async respond({ emit }) {
      emit('text', { text: 'starting…' })
      await new Promise(() => {}) // network stall: no further chunks, never settles
    },
  }
  const stallApp = createApp(dataDir, { agent: stallAgent, chatIdleMs: 80 })
  const gina = request.agent(stallApp)
  await gina.post('/api/auth/register').send({ username: 'gina', password: 'correct horse' })
  const id = (await gina.post('/api/trips').send({ name: 'Stall Trip' })).body.id

  const res = await gina.post(`/api/trips/${id}/chat`).send({ message: 'hello?' })
  assert.equal(res.status, 200)
  assert.match(res.text, /event: error/)
  assert.match(res.text, /stopped responding/)

  // The lock is freed immediately (not after the 5-minute total timeout),
  // the message is preserved, and a retry is accepted.
  const status = await gina.get(`/api/trips/${id}/chat`)
  assert.equal(status.body.pending, false)
  assert.equal(status.body.messages[0].failed, true)
  const retry = await gina.post(`/api/trips/${id}/chat`).send({ message: 'retry' })
  assert.equal(retry.status, 200)
})

test('slow but active generations are not treated as stalled', async () => {
  const slowActiveAgent = {
    enabled: true,
    listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
    async respond({ messages, emit, onActivity }) {
      // Long silence between text events, but chunk-level liveness the whole
      // time — the shape of a big tool-call argument stream.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 40))
        onActivity?.()
      }
      emit('text', { text: 'done thinking' })
      return [...messages, { role: 'model', content: [{ text: 'done thinking' }] }]
    },
  }
  const activeApp = createApp(dataDir, { agent: slowActiveAgent, chatIdleMs: 120 })
  const hana = request.agent(activeApp)
  await hana.post('/api/auth/register').send({ username: 'hana', password: 'correct horse' })
  const id = (await hana.post('/api/trips').send({ name: 'Active Trip' })).body.id
  const res = await hana.post(`/api/trips/${id}/chat`).send({ message: 'take your time' })
  assert.match(res.text, /event: done/)
  assert.doesNotMatch(res.text, /event: error/)
})

test('a failed turn keeps the user message (flagged) without replaying it to the model', async () => {
  const calls = []
  let shouldFail = true
  const flakyAgent = {
    enabled: true,
    listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
    async respond({ messages, emit }) {
      calls.push(messages)
      if (shouldFail) throw new Error('network blip')
      emit('text', { text: 'ok' })
      return [...messages, { role: 'model', content: [{ text: 'ok' }] }]
    },
  }
  const flakyApp = createApp(dataDir, { agent: flakyAgent })
  const fred = request.agent(flakyApp)
  await fred.post('/api/auth/register').send({ username: 'fred', password: 'correct horse' })
  const id = (await fred.post('/api/trips').send({ name: 'Flaky Trip' })).body.id

  const res = await fred.post(`/api/trips/${id}/chat`).send({ message: 'Plan my trip please' })
  assert.match(res.text, /event: error/)

  // The message survives the failure, flagged so the client can show it.
  const hist = await fred.get(`/api/trips/${id}/chat`)
  assert.equal(hist.body.messages.length, 1)
  assert.equal(hist.body.messages[0].failed, true)
  assert.equal(hist.body.messages[0].content[0].text, 'Plan my trip please')

  // The retry succeeds, and the model sees the request exactly once.
  shouldFail = false
  await fred.post(`/api/trips/${id}/chat`).send({ message: 'Plan my trip please' })
  const lastCall = calls[calls.length - 1]
  assert.equal(lastCall.filter((m) => m.role === 'user').length, 1)

  // The successful turn supersedes the failed copy in stored history.
  const after = await fred.get(`/api/trips/${id}/chat`)
  assert.equal(after.body.messages.length, 2)
  assert.ok(after.body.messages.every((m) => m.failed !== true))
})

test('deleting a trip removes its chat history file', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Short trip' })
  let id = created.body.id
  const res = await alice.post(`/api/trips/${id}/chat`).send({ message: 'Plan it' })
  id = finalTripId(res.text, id) // first naming renames the slug
  assert.equal((await alice.get(`/api/trips/${id}/chat`)).body.messages.length, 2)
  assert.equal((await alice.delete(`/api/trips/${id}`)).status, 204)
  assert.equal((await alice.get(`/api/trips/${id}/chat`)).status, 404)
})
