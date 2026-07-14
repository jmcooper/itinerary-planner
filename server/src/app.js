import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStorage } from './storage.js'
import { createAuth, USERNAME_RE, MIN_PASSWORD_LENGTH } from './auth.js'
import { normalizeHotelStays } from './hotels.js'

// Slugs that would collide with app routes ("/trips/new") or API routes.
const RESERVED_SLUGS = new Set(['new', 'ai'])

// Legacy trips (created before accounts existed) have no ownerId; they are
// treated as public and any signed-in user may edit or delete them.
function canView(trip, username) {
  if (!trip.ownerId) return true
  if (trip.visibility === 'public') return true
  if (!username) return false
  return trip.ownerId === username || (trip.sharedWith ?? []).includes(username)
}

function canEdit(trip, username) {
  if (!username) return false
  if (!trip.ownerId) return true
  return trip.ownerId === username || (trip.sharedWith ?? []).includes(username)
}

function isOwner(trip, username) {
  if (!username) return false
  return trip.ownerId ? trip.ownerId === username : true
}


export function createApp(
  dataDir,
  {
    agent = { enabled: false, model: null },
    // Hard ceiling on one chat generation; a hung provider call must not lock
    // the trip's chat forever.
    chatTimeoutMs = Number(process.env.AI_CHAT_TIMEOUT_MS ?? 5 * 60_000),
  } = {}
) {
  const app = express()
  const storage = createStorage(dataDir)
  const auth = createAuth(dataDir)
  app.use(express.json({ limit: '15mb' }))
  app.use(cookieParser())
  app.use(auth.authenticate)

  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next)

  // ---- Auth ----
  // Responses only ever include the username; salt/hash never leave the storage layer.

  function parseCredentials(body) {
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    return { username, password }
  }

  app.post(
    '/api/auth/register',
    wrap(async (req, res) => {
      const { username, password } = parseCredentials(req.body)
      if (!USERNAME_RE.test(username))
        return res.status(400).json({
          error: 'username must be 3-30 characters: lowercase letters, digits, - or _',
        })
      if (password.length < MIN_PASSWORD_LENGTH)
        return res
          .status(400)
          .json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` })
      try {
        await auth.createUser(username, password)
      } catch (err) {
        if (err.code === 'EEXIST')
          return res.status(409).json({ error: 'that username is taken' })
        throw err
      }
      auth.setTokenCookie(res, username)
      res.status(201).json({ username })
    })
  )

  app.post(
    '/api/auth/login',
    wrap(async (req, res) => {
      const { username, password } = parseCredentials(req.body)
      const user = await auth.readUser(username)
      if (!user || !(await auth.verifyPassword(user, password)))
        return res.status(401).json({ error: 'invalid username or password' })
      auth.setTokenCookie(res, username)
      res.json({ username })
    })
  )

  app.post('/api/auth/logout', (req, res) => {
    auth.clearTokenCookie(res)
    res.status(204).end()
  })

  app.get('/api/auth/me', (req, res) => {
    res.json({ username: req.username })
  })

  app.get(
    '/api/users',
    auth.requireAuth,
    wrap(async (req, res) => {
      res.json(await auth.listUsernames())
    })
  )

  // ---- AI ----

  app.get(
    '/api/ai/status',
    wrap(async (req, res) => {
      if (!agent.enabled) return res.json({ enabled: false, models: [] })
      res.json({ enabled: true, models: await agent.listModels() })
    })
  )

  function provisionalName(description) {
    const words = description.trim().split(/\s+/).slice(0, 6).join(' ')
    return words.length > 48 ? `${words.slice(0, 48)}…` : words
  }

  // Creates a trip shell for the AI flow; the agent fills in name/dates/days
  // once the client sends the description as the first chat message.
  app.post(
    '/api/trips/ai',
    auth.requireAuth,
    wrap(async (req, res) => {
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : ''
      if (!description) return res.status(400).json({ error: 'description is required' })
      const now = new Date().toISOString()
      const name = provisionalName(description)
      const trip = {
        id: storage.slugify(name),
        name,
        ownerId: req.username,
        visibility: 'private',
        sharedWith: [],
        summary: '',
        aiCreated: true,
        days: {},
        createdAt: now,
        updatedAt: now,
      }
      await storage.writeTrip(trip)
      res.status(201).json(withPermissions(trip, req.username))
    })
  )

  // ---- Trips ----

  function summarize(trip) {
    const { id, name, createdAt, updatedAt } = trip
    // The trip's span is derived from its day entries (days own their dates).
    const dates = Object.keys(trip.days ?? {}).sort()
    return {
      id,
      name,
      startDate: dates[0] ?? null,
      endDate: dates[dates.length - 1] ?? null,
      createdAt,
      updatedAt,
      ownerId: trip.ownerId ?? null,
      visibility: trip.ownerId ? trip.visibility ?? 'private' : 'public',
      archived: trip.archived === true,
    }
  }

  app.get(
    '/api/trips',
    wrap(async (req, res) => {
      const username = req.username
      const trips = await storage.listTrips()
      const mine = []
      const shared = []
      const publicTrips = []
      for (const trip of trips) {
        if (username && trip.ownerId === username) mine.push(trip)
        else if (username && (trip.sharedWith ?? []).includes(username)) shared.push(trip)
        else if (canView(trip, null)) publicTrips.push(trip)
      }
      res.json({
        mine: mine.map(summarize),
        shared: shared.map(summarize),
        public: publicTrips.map(summarize),
      })
    })
  )

  app.post(
    '/api/trips',
    auth.requireAuth,
    wrap(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      if (!name) return res.status(400).json({ error: 'name is required' })
      const now = new Date().toISOString()
      const trip = {
        id: storage.slugify(name),
        name,
        ownerId: req.username,
        visibility: 'private',
        sharedWith: [],
        days: {},
        createdAt: now,
        updatedAt: now,
      }
      await storage.writeTrip(trip)
      res.status(201).json(withPermissions(trip, req.username))
    })
  )

  // Duplicates a viewable trip into a new private trip owned by the caller.
  // Days and images are copied; the chat history starts fresh.
  app.post(
    '/api/trips/:id/duplicate',
    auth.requireAuth,
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      const now = new Date().toISOString()
      const name = `${trip.name} (copy)`
      const copy = {
        ...trip,
        id: storage.slugify(name),
        name,
        ownerId: req.username,
        visibility: 'private',
        sharedWith: [],
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      await storage.writeTrip(copy)
      const images = await storage.readImages(trip.id)
      if (Object.keys(images).length > 0) await storage.writeImages(copy.id, images)
      res.status(201).json(withPermissions(copy, req.username))
    })
  )

  // Non-viewable trips 404 (not 403) so private trip ids are indistinguishable
  // from missing ones.
  async function loadViewableTrip(req, res) {
    const trip = await storage.readTrip(req.params.id)
    if (!trip || !canView(trip, req.username)) {
      res.status(404).json({ error: 'trip not found' })
      return null
    }
    return trip
  }

  function requireEditable(trip, req, res) {
    if (canEdit(trip, req.username)) return true
    if (!req.username) res.status(401).json({ error: 'authentication required' })
    else res.status(403).json({ error: 'you do not have permission to change this trip' })
    return false
  }

  function withPermissions(trip, username) {
    return { ...trip, isOwner: isOwner(trip, username), canEdit: canEdit(trip, username) }
  }

  app.get(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      res.json(withPermissions(trip, req.username))
    })
  )

  app.put(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      const body = req.body ?? {}

      // Visibility and sharing are owner-only controls.
      if ('visibility' in body || 'sharedWith' in body) {
        if (!isOwner(trip, req.username))
          return res.status(403).json({ error: 'only the owner can change sharing settings' })
      }
      if ('visibility' in body) {
        if (body.visibility !== 'private' && body.visibility !== 'public')
          return res.status(400).json({ error: 'visibility must be "private" or "public"' })
        trip.visibility = body.visibility
      }
      if ('sharedWith' in body) {
        if (!Array.isArray(body.sharedWith) || body.sharedWith.some((u) => typeof u !== 'string'))
          return res.status(400).json({ error: 'sharedWith must be an array of usernames' })
        const usernames = [...new Set(body.sharedWith)].filter((u) => u !== trip.ownerId)
        for (const username of usernames) {
          if (!(await auth.readUser(username)))
            return res.status(400).json({ error: `unknown user: ${username}` })
        }
        trip.sharedWith = usernames
      }

      // The slug is the trip's id, URL, and on-disk filename; changing it
      // renames all of them together.
      if ('slug' in body) {
        if (!isOwner(trip, req.username))
          return res.status(403).json({ error: 'only the owner can change the trip URL' })
        const slug = body.slug
        if (
          typeof slug !== 'string' ||
          slug.length < 3 ||
          slug.length > 80 ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
          RESERVED_SLUGS.has(slug)
        )
          return res.status(400).json({
            error: 'the URL must be 3-80 characters: lowercase letters, digits, and hyphens',
          })
        if (slug !== trip.id) {
          if (activeChats.has(trip.id))
            return res
              .status(409)
              .json({ error: 'The assistant is working on this trip — try again when it finishes.' })
          if (await storage.readTrip(slug))
            return res.status(409).json({ error: 'that URL is already taken' })
          await storage.renameTrip(trip.id, slug)
          trip.id = slug
        }
      }

      if ('name' in body) {
        if (typeof body.name !== 'string' || !body.name.trim())
          return res.status(400).json({ error: 'name must be a non-empty string' })
        trip.name = body.name.trim()
      }
      if ('archived' in body) {
        if (!isOwner(trip, req.username))
          return res.status(403).json({ error: 'only the owner can archive this trip' })
        if (typeof body.archived !== 'boolean')
          return res.status(400).json({ error: 'archived must be a boolean' })
        trip.archived = body.archived
      }
      if ('days' in body) {
        if (typeof body.days !== 'object' || body.days === null || Array.isArray(body.days))
          return res.status(400).json({ error: 'days must be an object keyed by date' })
        if (Object.keys(body.days).some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)))
          return res.status(400).json({ error: 'days keys must be YYYY-MM-DD dates' })
        trip.days = body.days
      }
      if ('hotelStays' in body) {
        const { stays, error } = normalizeHotelStays(body.hotelStays)
        if (error) return res.status(400).json({ error })
        trip.hotelStays = stays
      }
      trip.updatedAt = new Date().toISOString()
      await storage.writeTrip(trip)
      res.json(withPermissions(trip, req.username))
    })
  )

  app.delete(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!req.username) return res.status(401).json({ error: 'authentication required' })
      if (!isOwner(trip, req.username))
        return res.status(403).json({ error: 'only the owner can delete this trip' })
      await storage.deleteTrip(trip.id)
      res.status(204).end()
    })
  )

  // ---- Images ----
  // Images are stored per trip in a separate <id>.images.json file so trip
  // fetches stay small; clients load image data on demand by id.
  // Reading follows trip view permissions; writing follows edit permissions.
  const DATA_URI_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i
  const MAX_DATA_URI_CHARS = 14_000_000 // ~10MB of image data

  app.post(
    '/api/trips/:id/images',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      const dataUri = req.body?.dataUri
      if (typeof dataUri !== 'string' || !DATA_URI_RE.test(dataUri))
        return res.status(400).json({ error: 'dataUri must be a base64 image data URI' })
      if (dataUri.length > MAX_DATA_URI_CHARS)
        return res.status(400).json({ error: 'image is too large (10MB max)' })
      const images = await storage.readImages(trip.id)
      const id = storage.newImageId()
      images[id] = dataUri
      await storage.writeImages(trip.id, images)
      res.status(201).json({ id })
    })
  )

  app.get(
    '/api/trips/:id/images/:imageId',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      const images = await storage.readImages(trip.id)
      const dataUri = images[req.params.imageId]
      if (!dataUri) return res.status(404).json({ error: 'image not found' })
      res.json({ id: req.params.imageId, dataUri })
    })
  )

  app.delete(
    '/api/trips/:id/images/:imageId',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      const images = await storage.readImages(trip.id)
      if (!(req.params.imageId in images)) return res.status(404).json({ error: 'image not found' })
      delete images[req.params.imageId]
      await storage.writeImages(trip.id, images)
      res.status(204).end()
    })
  )

  // ---- Chat ----
  // Per-trip AI conversation. Reading and writing both require edit permission
  // because the conversation drives itinerary edits.

  const activeChats = new Set() // trip ids with an in-flight generation

  app.get(
    '/api/trips/:id/chat',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      const chat = await storage.readChat(trip.id)
      // pending lets the client show progress (and poll) when the user returns
      // to a trip whose response is still being generated.
      res.json({ ...chat, pending: activeChats.has(trip.id) })
    })
  )

  app.post(
    '/api/trips/:id/chat',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      if (!agent.enabled)
        return res.status(503).json({ error: 'AI is not configured on this server' })
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      if (!message) return res.status(400).json({ error: 'message is required' })
      const models = await agent.listModels()
      const model =
        typeof req.body?.model === 'string' && req.body.model ? req.body.model : models[0]?.id
      if (!models.some((m) => m.id === model))
        return res.status(400).json({ error: `unknown model: ${model}` })
      if (activeChats.has(trip.id))
        return res
          .status(409)
          .json({ error: 'The assistant is still working on this trip — wait for it to finish.' })
      activeChats.add(trip.id)

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
      const emit = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)
      }

      let timer
      try {
        const chat = await storage.readChat(trip.id)
        const messages = [...chat.messages, { role: 'user', content: [{ text: message }] }]
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('the assistant took too long to respond — please try again')),
            chatTimeoutMs
          )
        })
        const updated = await Promise.race([
          agent.respond({ model, trip, messages, storage, emit }),
          timeout,
        ])
        await storage.writeChat(trip.id, { messages: updated })
        emit('done', {})
      } catch (err) {
        console.error(err)
        emit('error', { error: err.message ?? 'generation failed' })
      } finally {
        clearTimeout(timer)
        activeChats.delete(trip.id)
        res.end()
      }
    })
  )

  // Serve the built client when present, so `node src/index.js` alone can host
  // the whole app (nginx static hosting also works — see README).
  const clientDist = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../client/dist')
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err)
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
