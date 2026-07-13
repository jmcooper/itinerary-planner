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
  assert.equal(hist.body.messages[1].role, 'model')

  const trip = await alice.get(`/api/trips/${id}`)
  assert.equal(trip.body.name, 'Yellowstone 2026')
  assert.equal(trip.body.summary, 'Two days in Yellowstone')
})

test('chat rejects an empty message', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Anywhere' })
  const res = await alice.post(`/api/trips/${created.body.id}/chat`).send({ message: '  ' })
  assert.equal(res.status, 400)
})

test('chat passes the requested model through and rejects unknown models', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Model test' })
  const id = created.body.id
  const ok = await alice.post(`/api/trips/${id}/chat`).send({ message: 'hi', model: 'fake/other' })
  assert.equal(ok.status, 200)
  assert.equal(agent.lastModel, 'fake/other')

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

test('deleting a trip removes its chat history file', async () => {
  const created = await alice.post('/api/trips/ai').send({ description: 'Short trip' })
  const id = created.body.id
  await alice.post(`/api/trips/${id}/chat`).send({ message: 'Plan it' })
  assert.equal((await alice.get(`/api/trips/${id}/chat`)).body.messages.length, 2)
  assert.equal((await alice.delete(`/api/trips/${id}`)).status, 204)
  assert.equal((await alice.get(`/api/trips/${id}/chat`)).status, 404)
})
