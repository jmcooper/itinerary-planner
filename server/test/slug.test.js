import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

// Minimal agent so a chat history file exists to be renamed along with the trip.
const fakeAgent = {
  enabled: true,
  listModels: async () => [{ id: 'fake/model', label: 'Fake Model' }],
  async respond({ messages, emit }) {
    emit('text', { text: 'ok' })
    return [...messages, { role: 'model', content: [{ text: 'ok' }] }]
  },
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let app
let dataDir
let alice

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-slug-'))
  app = createApp(dataDir, { agent: fakeAgent })
  alice = request.agent(app)
  await alice.post('/api/auth/register').send({ username: 'alice', password: 'correct horse' })
})

after(async () => rm(dataDir, { recursive: true, force: true }))

test('PUT slug renames the trip id and moves images and chat with it', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Slug Trip' })
  const oldId = created.body.id
  const img = await alice.post(`/api/trips/${oldId}/images`).send({ dataUri: TINY_PNG })
  await alice.post(`/api/trips/${oldId}/chat`).send({ message: 'hello' })

  const res = await alice.put(`/api/trips/${oldId}`).send({ slug: 'yellowstone-2026' })
  assert.equal(res.status, 200)
  assert.equal(res.body.id, 'yellowstone-2026')
  assert.equal(res.body.name, 'Slug Trip') // name untouched

  // New id serves everything; old id is gone
  assert.equal((await alice.get('/api/trips/yellowstone-2026')).status, 200)
  assert.equal((await alice.get(`/api/trips/${oldId}`)).status, 404)
  const image = await alice.get(`/api/trips/yellowstone-2026/images/${img.body.id}`)
  assert.equal(image.status, 200)
  const chat = await alice.get('/api/trips/yellowstone-2026/chat')
  assert.equal(chat.body.messages.length, 2)

  // Renaming can be combined with other fields in the same PUT
  const combo = await alice
    .put('/api/trips/yellowstone-2026')
    .send({ slug: 'yellowstone-final', name: 'Renamed Too' })
  assert.equal(combo.body.id, 'yellowstone-final')
  assert.equal(combo.body.name, 'Renamed Too')
})

test('PUT slug validates format and reserved names', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Validate Slug' })
  const id = created.body.id
  for (const slug of ['Has Spaces', 'UPPER', 'aa', '-leading', 'trailing-', 'a_b', 'new', 'ai']) {
    const res = await alice.put(`/api/trips/${id}`).send({ slug })
    assert.equal(res.status, 400, `expected 400 for slug ${JSON.stringify(slug)}`)
  }
  // Unchanged slug is a no-op, not an error
  const same = await alice.put(`/api/trips/${id}`).send({ slug: id })
  assert.equal(same.status, 200)
})

test('PUT slug rejects a slug already in use', async () => {
  const a = await alice.post('/api/trips').send({ name: 'Taken A' })
  await alice.put(`/api/trips/${a.body.id}`).send({ slug: 'taken-slug' })
  const b = await alice.post('/api/trips').send({ name: 'Taken B' })
  const res = await alice.put(`/api/trips/${b.body.id}`).send({ slug: 'taken-slug' })
  assert.equal(res.status, 409)
})

test('only the owner can change the slug', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Owner Slug' })
  const id = created.body.id
  await alice.put(`/api/trips/${id}`).send({ sharedWith: [] , visibility: 'public' })
  const bob = request.agent(app)
  await bob.post('/api/auth/register').send({ username: 'bob-slug', password: 'correct horse' })
  await alice.put(`/api/trips/${id}`).send({ sharedWith: ['bob-slug'] })
  const res = await bob.put(`/api/trips/${id}`).send({ slug: 'bobs-url' })
  assert.equal(res.status, 403)
})

// agentSlugBasis: the name plus month/year pieces the name doesn't already have.
test('agentSlugBasis appends month and year from the earliest day', async () => {
  const { agentSlugBasis } = await import('../src/slug.js')
  assert.equal(
    agentSlugBasis({ name: 'Yellowstone Weekend', days: { '2026-07-18': {}, '2026-07-17': {} } }),
    'Yellowstone Weekend july 2026'
  )
})

test('agentSlugBasis skips pieces the name already mentions', async () => {
  const { agentSlugBasis } = await import('../src/slug.js')
  assert.equal(agentSlugBasis({ name: 'Summer 2026 Trip', days: { '2026-07-16': {} } }), 'Summer 2026 Trip')
  assert.equal(
    agentSlugBasis({ name: 'July in Yellowstone', days: { '2026-07-16': {} } }),
    'July in Yellowstone 2026'
  )
  assert.equal(agentSlugBasis({ name: 'Yellowstone', days: {} }), 'Yellowstone')
})
