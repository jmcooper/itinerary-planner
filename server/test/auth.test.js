import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/app.js'

let app
let dataDir
let owner // agent for user "owner"
let friend // agent for user "friend" (shared with)
let stranger // agent for user "stranger" (no access)

// Recursively assert a response body carries no password material.
const FORBIDDEN_KEYS = ['password', 'hash', 'salt', 'passwordHash']
function assertNoSecrets(value, where) {
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoSecrets(v, `${where}[${i}]`))
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_KEYS.includes(k), `response ${where} leaked key "${k}"`)
      assertNoSecrets(v, `${where}.${k}`)
    }
  }
}

async function register(username, password = 'a strong password') {
  const agent = request.agent(app)
  const res = await agent.post('/api/auth/register').send({ username, password })
  assert.equal(res.status, 201, `register ${username}: ${JSON.stringify(res.body)}`)
  return agent
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-auth-test-'))
  app = createApp(dataDir)
  owner = await register('owner')
  friend = await register('friend')
  stranger = await register('stranger')
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---- Registration / login ----

test('register returns only the username and sets an httpOnly cookie', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'cookiecheck', password: 'long enough pw' })
  assert.equal(res.status, 201)
  assert.deepEqual(res.body, { username: 'cookiecheck' })
  const cookie = res.headers['set-cookie']?.[0] ?? ''
  assert.match(cookie, /^token=/)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
})

test('register rejects invalid usernames and short passwords', async () => {
  const bad = [
    { username: 'ab', password: 'long enough pw' }, // too short
    { username: 'Has Space', password: 'long enough pw' },
    { username: '../evil', password: 'long enough pw' },
    { username: 'x'.repeat(31), password: 'long enough pw' },
    { username: 'validname', password: 'short' },
    { username: '', password: '' },
  ]
  for (const body of bad) {
    const res = await request(app).post('/api/auth/register').send(body)
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
})

test('register rejects duplicate usernames', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'owner', password: 'another password' })
  assert.equal(res.status, 409)
})

test('usernames are case-insensitive (normalized to lowercase)', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: 'OWNER', password: 'another password' })
  assert.equal(res.status, 409)
})

test('login succeeds with correct credentials, fails with wrong password', async () => {
  const ok = await request(app)
    .post('/api/auth/login')
    .send({ username: 'owner', password: 'a strong password' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { username: 'owner' })

  const bad = await request(app)
    .post('/api/auth/login')
    .send({ username: 'owner', password: 'wrong password' })
  assert.equal(bad.status, 401)

  const unknown = await request(app)
    .post('/api/auth/login')
    .send({ username: 'nobody-here', password: 'a strong password' })
  assert.equal(unknown.status, 401)
  // Same message for unknown user and wrong password.
  assert.deepEqual(unknown.body, bad.body)
})

test('me reflects the session; logout clears it', async () => {
  const agent = await register('sessionuser')
  assert.deepEqual((await agent.get('/api/auth/me')).body, { username: 'sessionuser' })
  const out = await agent.post('/api/auth/logout')
  assert.equal(out.status, 204)
  assert.deepEqual((await agent.get('/api/auth/me')).body, { username: null })
})

test('a tampered token is treated as anonymous', async () => {
  const res = await request(app)
    .get('/api/auth/me')
    .set('Cookie', 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.forged')
  assert.deepEqual(res.body, { username: null })
})

test('GET /api/users lists usernames only and requires auth', async () => {
  const anon = await request(app).get('/api/users')
  assert.equal(anon.status, 401)
  const res = await owner.get('/api/users')
  assert.equal(res.status, 200)
  assert.ok(res.body.includes('owner') && res.body.includes('friend'))
  assert.ok(res.body.every((u) => typeof u === 'string'))
})

// ---- Authorization matrix ----

let privateTripId
let publicTripId

test('setup: owner creates a private trip shared with friend, and a public trip', async () => {
  const priv = await owner.post('/api/trips').send({ name: 'Private Trip' })
  privateTripId = priv.body.id
  const share = await owner.put(`/api/trips/${privateTripId}`).send({ sharedWith: ['friend'] })
  assert.equal(share.status, 200)
  assert.deepEqual(share.body.sharedWith, ['friend'])

  const pub = await owner.post('/api/trips').send({ name: 'Public Trip' })
  publicTripId = pub.body.id
  const vis = await owner.put(`/api/trips/${publicTripId}`).send({ visibility: 'public' })
  assert.equal(vis.status, 200)
  assert.equal(vis.body.visibility, 'public')
})

test('private trip: owner and shared user can view; others get 404', async () => {
  assert.equal((await owner.get(`/api/trips/${privateTripId}`)).status, 200)
  const asFriend = await friend.get(`/api/trips/${privateTripId}`)
  assert.equal(asFriend.status, 200)
  assert.equal(asFriend.body.isOwner, false)
  assert.equal(asFriend.body.canEdit, true)
  assert.equal((await stranger.get(`/api/trips/${privateTripId}`)).status, 404)
  assert.equal((await request(app).get(`/api/trips/${privateTripId}`)).status, 404)
})

test('public trip: anyone can view, only editors can change', async () => {
  const anon = await request(app).get(`/api/trips/${publicTripId}`)
  assert.equal(anon.status, 200)
  assert.equal(anon.body.canEdit, false)

  assert.equal(
    (await request(app).put(`/api/trips/${publicTripId}`).send({ name: 'Hacked' })).status,
    401
  )
  assert.equal(
    (await stranger.put(`/api/trips/${publicTripId}`).send({ name: 'Hacked' })).status,
    403
  )
})

test('shared user can edit content but not sharing, visibility, or delete', async () => {
  const edit = await friend
    .put(`/api/trips/${privateTripId}`)
    .send({ startDate: '2026-09-01', endDate: '2026-09-03' })
  assert.equal(edit.status, 200)

  assert.equal(
    (await friend.put(`/api/trips/${privateTripId}`).send({ visibility: 'public' })).status,
    403
  )
  assert.equal(
    (await friend.put(`/api/trips/${privateTripId}`).send({ sharedWith: ['stranger'] })).status,
    403
  )
  assert.equal((await friend.delete(`/api/trips/${privateTripId}`)).status, 403)
})

test('sharedWith rejects unknown users and drops duplicates and the owner', async () => {
  const bad = await owner.put(`/api/trips/${privateTripId}`).send({ sharedWith: ['ghost-user'] })
  assert.equal(bad.status, 400)
  const ok = await owner
    .put(`/api/trips/${privateTripId}`)
    .send({ sharedWith: ['friend', 'friend', 'owner'] })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.sharedWith, ['friend'])
})

test('trip lists are segmented per user', async () => {
  const forOwner = (await owner.get('/api/trips')).body
  assert.ok(forOwner.mine.some((t) => t.id === privateTripId))
  assert.ok(forOwner.mine.some((t) => t.id === publicTripId))
  assert.ok(!forOwner.public.some((t) => t.id === publicTripId), 'own public trip stays in mine')

  const forFriend = (await friend.get('/api/trips')).body
  assert.ok(forFriend.shared.some((t) => t.id === privateTripId))
  assert.ok(forFriend.public.some((t) => t.id === publicTripId))
  assert.ok(!forFriend.mine.some((t) => t.id === privateTripId))

  const forStranger = (await stranger.get('/api/trips')).body
  assert.ok(!forStranger.shared.some((t) => t.id === privateTripId))
  assert.ok(!forStranger.public.some((t) => t.id === privateTripId))
  assert.ok(forStranger.public.some((t) => t.id === publicTripId))

  const forAnon = (await request(app).get('/api/trips')).body
  assert.deepEqual(forAnon.mine, [])
  assert.deepEqual(forAnon.shared, [])
  assert.ok(forAnon.public.some((t) => t.id === publicTripId))
  assert.ok(!forAnon.public.some((t) => t.id === privateTripId))
})

test('images follow trip permissions', async () => {
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const posted = await owner.post(`/api/trips/${privateTripId}/images`).send({ dataUri: TINY_PNG })
  assert.equal(posted.status, 201)
  const imageId = posted.body.id

  assert.equal((await friend.get(`/api/trips/${privateTripId}/images/${imageId}`)).status, 200)
  assert.equal((await stranger.get(`/api/trips/${privateTripId}/images/${imageId}`)).status, 404)
  assert.equal(
    (await stranger.post(`/api/trips/${privateTripId}/images`).send({ dataUri: TINY_PNG })).status,
    404
  )
  assert.equal(
    (await request(app).post(`/api/trips/${publicTripId}/images`).send({ dataUri: TINY_PNG }))
      .status,
    401
  )
  assert.equal(
    (await stranger.post(`/api/trips/${publicTripId}/images`).send({ dataUri: TINY_PNG })).status,
    403
  )
})

test('deleting is owner-only and works for the owner', async () => {
  const doomed = await owner.post('/api/trips').send({ name: 'Owner Deletes Me' })
  assert.equal((await stranger.delete(`/api/trips/${doomed.body.id}`)).status, 404)
  assert.equal((await owner.delete(`/api/trips/${doomed.body.id}`)).status, 204)
})

// ---- No password material ever leaves the API ----

test('no API response contains password, hash, or salt fields', async () => {
  const responses = [
    await request(app).post('/api/auth/register').send({ username: 'leakcheck', password: 'long enough pw' }),
    await request(app).post('/api/auth/login').send({ username: 'leakcheck', password: 'long enough pw' }),
    await owner.get('/api/auth/me'),
    await owner.get('/api/users'),
    await owner.get('/api/trips'),
    await owner.get(`/api/trips/${privateTripId}`),
    await owner.put(`/api/trips/${privateTripId}`).send({ name: 'Leak Check Trip' }),
    await request(app).get('/api/trips'),
    await request(app).get(`/api/trips/${publicTripId}`),
  ]
  for (const res of responses) {
    assertNoSecrets(res.body, res.req?.path ?? 'response')
    const text = JSON.stringify(res.body)
    assert.ok(!text.includes('a strong password'), 'plaintext password leaked')
    assert.ok(!/"(salt|hash)"/.test(text), 'hash material leaked')
  }
})
