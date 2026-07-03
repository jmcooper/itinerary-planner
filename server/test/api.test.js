import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

let app
let dataDir
// A signed-in agent (cookie jar) shared across the CRUD tests.
let alice

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-test-'))
  app = createApp(dataDir)
  alice = request.agent(app)
  await alice.post('/api/auth/register').send({ username: 'alice', password: 'correct horse' })
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

test('GET /api/trips returns empty sections initially', async () => {
  const res = await alice.get('/api/trips')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { mine: [], shared: [], public: [] })
})

test('POST /api/trips creates a private trip owned by the caller', async () => {
  const res = await alice.post('/api/trips').send({ name: 'Europe 2026' })
  assert.equal(res.status, 201)
  assert.equal(res.body.name, 'Europe 2026')
  assert.ok(res.body.id)
  assert.deepEqual(res.body.days, {})
  assert.equal(res.body.ownerId, 'alice')
  assert.equal(res.body.visibility, 'private')
  assert.deepEqual(res.body.sharedWith, [])
})

test('POST /api/trips requires authentication', async () => {
  const res = await request(app).post('/api/trips').send({ name: 'Anon Trip' })
  assert.equal(res.status, 401)
})

test('POST /api/trips rejects missing name', async () => {
  const res = await alice.post('/api/trips').send({})
  assert.equal(res.status, 400)
})

test('GET /api/trips lists created trips as summaries under mine', async () => {
  const res = await alice.get('/api/trips')
  assert.equal(res.status, 200)
  assert.equal(res.body.mine.length, 1)
  assert.equal(res.body.mine[0].name, 'Europe 2026')
  assert.ok(!('days' in res.body.mine[0]))
})

test('GET /api/trips/:id returns the full trip with permission flags', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Yellowstone' })
  const res = await alice.get(`/api/trips/${created.body.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.name, 'Yellowstone')
  assert.deepEqual(res.body.days, {})
  assert.equal(res.body.isOwner, true)
  assert.equal(res.body.canEdit, true)
})

test('GET /api/trips/:id 404s for unknown trip', async () => {
  const res = await alice.get('/api/trips/nope')
  assert.equal(res.status, 404)
})

test('PUT /api/trips/:id updates dates and days', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Disneyland' })
  const id = created.body.id
  const items = [{ time: '8:00 am', plan: 'Leave hotel', code: 'S1', details: '## S1 — Leave hotel\n\nGo.' }]
  const res = await alice
    .put(`/api/trips/${id}`)
    .send({ startDate: '2026-07-04', endDate: '2026-07-06', days: { '2026-07-04': { items } } })
  assert.equal(res.status, 200)
  assert.equal(res.body.startDate, '2026-07-04')
  assert.equal(res.body.days['2026-07-04'].items[0].plan, 'Leave hotel')

  const fetched = await alice.get(`/api/trips/${id}`)
  assert.equal(fetched.body.endDate, '2026-07-06')
  assert.equal(fetched.body.days['2026-07-04'].items.length, 1)
})

test('PUT /api/trips/:id round-trips extra day fields like mapsUrl', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Maps Trip' })
  const id = created.body.id
  const day = { items: [], mapsUrl: 'https://maps.app.goo.gl/abc123' }
  await alice.put(`/api/trips/${id}`).send({ days: { '2026-07-18': day } })
  const res = await alice.get(`/api/trips/${id}`)
  assert.equal(res.body.days['2026-07-18'].mapsUrl, 'https://maps.app.goo.gl/abc123')
})

test('PUT /api/trips/:id preserves fields not in the payload', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Keep Me' })
  const id = created.body.id
  await alice.put(`/api/trips/${id}`).send({ startDate: '2026-08-01', endDate: '2026-08-03' })
  const res = await alice.put(`/api/trips/${id}`).send({ name: 'Renamed' })
  assert.equal(res.body.name, 'Renamed')
  assert.equal(res.body.startDate, '2026-08-01')
})

test('PUT /api/trips/:id 404s for unknown trip', async () => {
  const res = await alice.put('/api/trips/nope').send({ name: 'x' })
  assert.equal(res.status, 404)
})

test('DELETE /api/trips/:id removes the trip', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Doomed' })
  const del = await alice.delete(`/api/trips/${created.body.id}`)
  assert.equal(del.status, 204)
  const res = await alice.get(`/api/trips/${created.body.id}`)
  assert.equal(res.status, 404)
})

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('image upload / fetch / delete lifecycle', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Photo Trip' })
  const id = created.body.id

  const posted = await alice.post(`/api/trips/${id}/images`).send({ dataUri: TINY_PNG })
  assert.equal(posted.status, 201)
  assert.match(posted.body.id, /^img_[a-f0-9]+$/)

  const fetched = await alice.get(`/api/trips/${id}/images/${posted.body.id}`)
  assert.equal(fetched.status, 200)
  assert.equal(fetched.body.dataUri, TINY_PNG)

  const deleted = await alice.delete(`/api/trips/${id}/images/${posted.body.id}`)
  assert.equal(deleted.status, 204)
  const gone = await alice.get(`/api/trips/${id}/images/${posted.body.id}`)
  assert.equal(gone.status, 404)
})

test('image upload rejects non-image data URIs', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Bad Image Trip' })
  for (const dataUri of ['not a data uri', 'data:text/html;base64,PGI+', '', null]) {
    const res = await alice.post(`/api/trips/${created.body.id}/images`).send({ dataUri })
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(dataUri)}`)
  }
})

test('image routes 404 for unknown trip or image', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Missing Image Trip' })
  assert.equal((await alice.post('/api/trips/nope/images').send({ dataUri: TINY_PNG })).status, 404)
  assert.equal((await alice.get(`/api/trips/${created.body.id}/images/img_ffffff`)).status, 404)
  assert.equal((await alice.delete(`/api/trips/${created.body.id}/images/img_ffffff`)).status, 404)
})

test('images file does not leak into the trips list', async () => {
  const created = await alice.post('/api/trips').send({ name: 'List Clean Trip' })
  await alice.post(`/api/trips/${created.body.id}/images`).send({ dataUri: TINY_PNG })
  const list = await alice.get('/api/trips')
  const all = [...list.body.mine, ...list.body.shared, ...list.body.public]
  assert.ok(all.every((t) => t.name && t.id))
})

test('deleting a trip also deletes its images', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Cleanup Trip' })
  const id = created.body.id
  const posted = await alice.post(`/api/trips/${id}/images`).send({ dataUri: TINY_PNG })
  await alice.delete(`/api/trips/${id}`)
  const res = await alice.get(`/api/trips/${id}/images/${posted.body.id}`)
  assert.equal(res.status, 404)
})

test('trip ids are url-safe slugs derived from the name', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Grand Cañón & Back!' })
  assert.match(created.body.id, /^[a-z0-9-]+$/)
})
