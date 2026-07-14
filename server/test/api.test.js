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

test('PUT /api/trips/:id updates days', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Disneyland' })
  const id = created.body.id
  const items = [
    { timeStart: '08:00', timeEnd: null, timeLabel: null, title: 'Leave hotel', description: 'Go.', imageIds: [] },
  ]
  const res = await alice
    .put(`/api/trips/${id}`)
    .send({ days: { '2026-07-04': { title: '', mapsUrl: '', items }, '2026-07-06': { title: '', mapsUrl: '', items: [] } } })
  assert.equal(res.status, 200)
  assert.equal(res.body.days['2026-07-04'].items[0].title, 'Leave hotel')

  const fetched = await alice.get(`/api/trips/${id}`)
  assert.equal(fetched.body.days['2026-07-04'].items.length, 1)

  // Trip lists derive the date span from the day entries
  const list = await alice.get('/api/trips')
  const summary = list.body.mine.find((t) => t.id === id)
  assert.equal(summary.startDate, '2026-07-04')
  assert.equal(summary.endDate, '2026-07-06')
})

test('PUT /api/trips/:id rejects non-date day keys', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Bad Keys' })
  const res = await alice
    .put(`/api/trips/${created.body.id}`)
    .send({ days: { tuesday: { title: '', mapsUrl: '', items: [] } } })
  assert.equal(res.status, 400)
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
  await alice.put(`/api/trips/${id}`).send({ days: { '2026-08-01': { title: '', mapsUrl: '', items: [] } } })
  const res = await alice.put(`/api/trips/${id}`).send({ name: 'Renamed' })
  assert.equal(res.body.name, 'Renamed')
  assert.ok('2026-08-01' in res.body.days)
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

test('POST /api/trips/:id/duplicate copies the trip and its images', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Original' })
  const id = created.body.id
  const items = [
    { timeStart: '08:00', timeEnd: null, timeLabel: null, title: 'Go', description: 'd', imageIds: [] },
  ]
  await alice.put(`/api/trips/${id}`).send({ days: { '2026-09-01': { title: 'Day', mapsUrl: '', items } } })
  const img = await alice.post(`/api/trips/${id}/images`).send({ dataUri: TINY_PNG })

  const res = await alice.post(`/api/trips/${id}/duplicate`)
  assert.equal(res.status, 201)
  assert.equal(res.body.name, 'Original (copy)')
  assert.notEqual(res.body.id, id)
  assert.equal(res.body.ownerId, 'alice')
  assert.equal(res.body.visibility, 'private')
  assert.deepEqual(res.body.sharedWith, [])
  assert.equal(res.body.days['2026-09-01'].items[0].title, 'Go')

  // Images were copied so imageIds keep resolving on the duplicate
  const copiedImg = await alice.get(`/api/trips/${res.body.id}/images/${img.body.id}`)
  assert.equal(copiedImg.status, 200)
  assert.equal(copiedImg.body.dataUri, TINY_PNG)

  // The copy is independent — editing it leaves the original alone
  await alice.put(`/api/trips/${res.body.id}`).send({ name: 'Changed Copy' })
  const original = await alice.get(`/api/trips/${id}`)
  assert.equal(original.body.name, 'Original')
})

test('POST /api/trips/:id/duplicate requires auth and a viewable trip', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Private Src' })
  assert.equal((await request(app).post(`/api/trips/${created.body.id}/duplicate`)).status, 401)
  assert.equal((await alice.post('/api/trips/nope/duplicate')).status, 404)
})

test('PUT /api/trips/:id archives and unarchives a trip', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Old Trip' })
  const id = created.body.id

  const archived = await alice.put(`/api/trips/${id}`).send({ archived: true })
  assert.equal(archived.status, 200)
  assert.equal(archived.body.archived, true)

  const list = await alice.get('/api/trips')
  assert.equal(list.body.mine.find((t) => t.id === id).archived, true)

  const restored = await alice.put(`/api/trips/${id}`).send({ archived: false })
  assert.equal(restored.body.archived, false)
})

test('PUT /api/trips/:id rejects non-boolean archived', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Bad Archive' })
  const res = await alice.put(`/api/trips/${created.body.id}`).send({ archived: 'yes' })
  assert.equal(res.status, 400)
})

test('only the owner can archive — a shared editor cannot', async () => {
  const bob = request.agent(app)
  await bob.post('/api/auth/register').send({ username: 'bob', password: 'correct horse' })
  const created = await alice.post('/api/trips').send({ name: 'Shared Not Archivable' })
  const id = created.body.id
  await alice.put(`/api/trips/${id}`).send({ sharedWith: ['bob'] })

  // bob can edit days but not archive
  const editRes = await bob
    .put(`/api/trips/${id}`)
    .send({ days: { '2026-10-01': { title: '', mapsUrl: '', items: [] } } })
  assert.equal(editRes.status, 200)
  const archiveRes = await bob.put(`/api/trips/${id}`).send({ archived: true })
  assert.equal(archiveRes.status, 403)

  // the archived flag flows through to bob's shared list once alice sets it
  await alice.put(`/api/trips/${id}`).send({ archived: true })
  const list = await bob.get('/api/trips')
  assert.equal(list.body.shared.find((t) => t.id === id).archived, true)
})

test('duplicating an archived trip yields an unarchived copy', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Archived Source' })
  await alice.put(`/api/trips/${created.body.id}`).send({ archived: true })
  const copy = await alice.post(`/api/trips/${created.body.id}/duplicate`)
  assert.equal(copy.status, 201)
  assert.equal(copy.body.archived, false)
})

test('PUT /api/trips/:id round-trips hotelStays with normalization', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Hotel Trip' })
  const id = created.body.id
  const res = await alice.put(`/api/trips/${id}`).send({
    hotelStays: [
      {
        hotelName: '  Holiday Inn  ',
        hotelAddress: ' 315 Yellowstone Ave ',
        checkInDay: '2026-07-18',
        checkOutDay: '2026-07-21',
        confirmationNumber: ' ABC123 ',
        junkField: 'dropped',
      },
      { hotelName: 'No Conf Inn', checkInDay: '2026-07-21', checkOutDay: '2026-07-22', confirmationNumber: '' },
    ],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.hotelStays, [
    {
      hotelName: 'Holiday Inn',
      hotelAddress: '315 Yellowstone Ave',
      checkInDay: '2026-07-18',
      checkOutDay: '2026-07-21',
      confirmationNumber: 'ABC123',
    },
    { hotelName: 'No Conf Inn', hotelAddress: '', checkInDay: '2026-07-21', checkOutDay: '2026-07-22' },
  ])
  const fetched = await alice.get(`/api/trips/${id}`)
  assert.equal(fetched.body.hotelStays.length, 2)
})

test('PUT /api/trips/:id rejects invalid hotelStays', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Bad Hotels' })
  const id = created.body.id
  const bad = [
    { hotelStays: 'not an array' },
    { hotelStays: [{ hotelName: '', checkInDay: '2026-07-18', checkOutDay: '2026-07-21' }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: 'July 18', checkOutDay: '2026-07-21' }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-21', checkOutDay: '2026-07-21' }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-22', checkOutDay: '2026-07-21' }] },
    { hotelStays: [{ hotelName: 'X', checkInDay: '2026-07-18', checkOutDay: '2026-07-21', confirmationNumber: 7 }] },
  ]
  for (const body of bad) {
    const res = await alice.put(`/api/trips/${id}`).send(body)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
})

test('a shared editor can update hotelStays', async () => {
  const carol = request.agent(app)
  await carol.post('/api/auth/register').send({ username: 'carol', password: 'correct horse' })
  const created = await alice.post('/api/trips').send({ name: 'Shared Hotels' })
  const id = created.body.id
  await alice.put(`/api/trips/${id}`).send({ sharedWith: ['carol'] })
  const res = await carol.put(`/api/trips/${id}`).send({
    hotelStays: [{ hotelName: 'Carol Inn', checkInDay: '2026-08-01', checkOutDay: '2026-08-02' }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.hotelStays[0].hotelName, 'Carol Inn')
})

test('duplicating a trip copies hotelStays', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Hotels To Copy' })
  await alice.put(`/api/trips/${created.body.id}`).send({
    hotelStays: [{ hotelName: 'Copy Inn', checkInDay: '2026-09-01', checkOutDay: '2026-09-03' }],
  })
  const copy = await alice.post(`/api/trips/${created.body.id}/duplicate`)
  assert.equal(copy.body.hotelStays[0].hotelName, 'Copy Inn')
})

test('day-level hotelNotNeeded flag round-trips through days', async () => {
  const created = await alice.post('/api/trips').send({ name: 'No Hotel Day' })
  const id = created.body.id
  await alice
    .put(`/api/trips/${id}`)
    .send({ days: { '2026-07-04': { title: '', mapsUrl: '', items: [], hotelNotNeeded: true } } })
  const res = await alice.get(`/api/trips/${id}`)
  assert.equal(res.body.days['2026-07-04'].hotelNotNeeded, true)
})

// ---- Linked days ----

const linkedItems = [
  { timeStart: '09:00', timeEnd: null, timeLabel: null, title: 'Shared stop', description: 'd', travel: false, imageIds: [] },
]

async function makeLinkedPair() {
  const a = (await alice.post('/api/trips').send({ name: `Target ${Math.random().toString(36).slice(2, 8)}` })).body
  await alice.put(`/api/trips/${a.id}`).send({
    days: { '2026-07-18': { title: 'A day', mapsUrl: '', items: linkedItems } },
  })
  const b = (await alice.post('/api/trips').send({ name: `Linker ${Math.random().toString(36).slice(2, 8)}` })).body
  await alice.put(`/api/trips/${b.id}`).send({
    days: {
      '2026-07-17': { title: '', mapsUrl: '', items: [] },
      '2026-07-18': { linkedTripId: a.id },
    },
  })
  return { a, b }
}

test('GET resolves a linked day to the target content with link metadata', async () => {
  const { a, b } = await makeLinkedPair()
  const res = await alice.get(`/api/trips/${b.id}`)
  const day = res.body.days['2026-07-18']
  assert.equal(day.linkedTripId, a.id)
  assert.match(day.linkedTripName, /^Target /)
  assert.equal(day.linkedCanEdit, true)
  assert.equal(day.title, 'A day')
  assert.equal(day.items[0].title, 'Shared stop')
})

test('linked content is never duplicated — target stays the source of truth', async () => {
  const { a, b } = await makeLinkedPair()
  // Round-trip the resolved payload (what the client sends on unrelated saves)
  const resolved = (await alice.get(`/api/trips/${b.id}`)).body
  await alice.put(`/api/trips/${b.id}`).send({ days: resolved.days })
  // Now edit the target; the linker must reflect it (a stored copy would not)
  await alice.put(`/api/trips/${a.id}`).send({
    days: { '2026-07-18': { title: 'A day CHANGED', mapsUrl: '', items: linkedItems } },
  })
  const after = (await alice.get(`/api/trips/${b.id}`)).body
  assert.equal(after.days['2026-07-18'].title, 'A day CHANGED')
})

test('PUT rejects malformed links', async () => {
  const { b } = await makeLinkedPair()
  const self = await alice.put(`/api/trips/${b.id}`).send({ days: { '2026-07-18': { linkedTripId: b.id } } })
  assert.equal(self.status, 400)
  const bad = await alice.put(`/api/trips/${b.id}`).send({ days: { '2026-07-18': { linkedTripId: '  ' } } })
  assert.equal(bad.status, 400)
})

test('a deleted target resolves as a broken link, not an error', async () => {
  const { a, b } = await makeLinkedPair()
  await alice.delete(`/api/trips/${a.id}`)
  const res = await alice.get(`/api/trips/${b.id}`)
  const day = res.body.days['2026-07-18']
  assert.equal(day.linkedBroken, true)
  assert.deepEqual(day.items, [])
  // ...and unrelated saves still work (the marker is preserved untouched)
  const save = await alice.put(`/api/trips/${b.id}`).send({ days: res.body.days })
  assert.equal(save.status, 200)
})

test('link chains are not followed', async () => {
  const { a, b } = await makeLinkedPair()
  // c links to b's linked day — resolving c must not chase b -> a
  const c = (await alice.post('/api/trips').send({ name: 'Chain Trip' })).body
  await alice.put(`/api/trips/${c.id}`).send({ days: { '2026-07-18': { linkedTripId: b.id } } })
  const res = await alice.get(`/api/trips/${c.id}`)
  assert.equal(res.body.days['2026-07-18'].linkedBroken, true)
  assert.equal(res.body.days['2026-07-18'].linkedTripId, b.id)
  void a
})

test('linkedCanEdit reflects the viewer, not the linker', async () => {
  const dave = request.agent(app)
  await dave.post('/api/auth/register').send({ username: 'dave', password: 'correct horse' })
  const { a, b } = await makeLinkedPair()
  await alice.put(`/api/trips/${b.id}`).send({ sharedWith: ['dave'] })
  const res = await dave.get(`/api/trips/${b.id}`)
  const day = res.body.days['2026-07-18']
  assert.equal(day.linkedCanEdit, false) // dave cannot edit trip A
  assert.equal(day.items[0].title, 'Shared stop') // but sees the content
  void a
})

test('unlinking stores a plain day again', async () => {
  const { b } = await makeLinkedPair()
  const resolved = (await alice.get(`/api/trips/${b.id}`)).body
  await alice.put(`/api/trips/${b.id}`).send({
    days: { ...resolved.days, '2026-07-18': { title: '', mapsUrl: '', items: [] } },
  })
  const after = (await alice.get(`/api/trips/${b.id}`)).body
  assert.ok(!after.days['2026-07-18'].linkedTripId)
  assert.deepEqual(after.days['2026-07-18'].items, [])
})

test('trip ids are url-safe slugs derived from the name', async () => {
  const created = await alice.post('/api/trips').send({ name: 'Grand Cañón & Back!' })
  assert.match(created.body.id, /^[a-z0-9-]+$/)
})
