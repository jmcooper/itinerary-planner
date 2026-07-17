import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStorage } from './storage.js'
import { createAuth, USERNAME_RE, MIN_PASSWORD_LENGTH } from './auth.js'
import { normalizeHotelStays } from './hotels.js'
import { normalizeFlightTrips } from './flights.js'
import { canView, canEdit, isOwner } from './permissions.js'
import { normalizeLinkedDay, validateLinkedDay, resolveTripDays, findLinkingTrips } from './links.js'
import { agentSlugBasis } from './slug.js'
import { isMapsPhotoLink, isPhotoHost, upgradePhotoSize, extractPhotoUrl } from './mapsphoto.js'

// Slugs that would collide with app routes ("/trips/new") or API routes.
const RESERVED_SLUGS = new Set(['new', 'ai'])


export function createApp(
  dataDir,
  {
    agent = { enabled: false, model: null },
    // Hard ceiling on one chat generation; a hung provider call must not lock
    // the trip's chat forever.
    chatTimeoutMs = Number(process.env.AI_CHAT_TIMEOUT_MS ?? 5 * 60_000),
    // Max silence between model stream chunks before the turn is declared
    // stalled (network drop to the provider) and the chat lock is freed.
    chatIdleMs = Number(process.env.AI_CHAT_IDLE_MS ?? 60_000),
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
        // The prompt-derived slug is temporary: the chat route renames the
        // trip once the agent names it (destination + month + year).
        provisionalSlug: true,
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
      // The copy's slug comes from its "(copy)" name; never provisional.
      delete copy.provisionalSlug
      await storage.writeTrip(copy)
      const images = await storage.readImages(trip.id)
      if (Object.keys(images).length > 0) await storage.writeImages(copy.id, images)
      const resolvedCopy = await resolveTripDays(copy, { storage, username: req.username })
      res.status(201).json(withPermissions(resolvedCopy, req.username))
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
      const resolved = await resolveTripDays(trip, { storage, username: req.username })
      res.json(withPermissions(resolved, req.username))
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
        // A public trip whose days are linked FROM a public trip cannot go
        // private — the linking trip's viewers would lose the linked days.
        if (body.visibility === 'private' && trip.visibility === 'public') {
          const publicLinkers = (await findLinkingTrips(trip.id, storage)).filter(
            (t) => (t.ownerId ? t.visibility : 'public') === 'public'
          )
          if (publicLinkers.length > 0)
            return res.status(409).json({
              error: `Days of this trip are linked from the public trip${publicLinkers.length > 1 ? 's' : ''} ${publicLinkers.map((t) => `"${t.name}"`).join(', ')}. Unlink those days or make that trip private before making this one private.`,
            })
        }
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
        // Users cannot be unshared while a trip that links here still shares
        // with them — they'd lose the linked days on that trip.
        const removed = (trip.sharedWith ?? []).filter((u) => !usernames.includes(u))
        if (removed.length > 0) {
          const linkers = await findLinkingTrips(trip.id, storage)
          for (const username of removed) {
            const blocking = linkers.filter((t) => (t.sharedWith ?? []).includes(username))
            if (blocking.length > 0)
              return res.status(409).json({
                error: `"${username}" still has access to the trip${blocking.length > 1 ? 's' : ''} ${blocking.map((t) => `"${t.name}"`).join(', ')}, which link${blocking.length > 1 ? '' : 's'} days of this trip. Unshare that trip (or unlink the days) first.`,
              })
          }
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
        // The user chose a URL — the agent must not rename it later.
        delete trip.provisionalSlug
      }

      if ('name' in body) {
        if (typeof body.name !== 'string' || !body.name.trim())
          return res.status(400).json({ error: 'name must be a non-empty string' })
        trip.name = body.name.trim()
        // The user named the trip themselves — the agent must not rename the
        // URL from it later.
        delete trip.provisionalSlug
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
        // Linked days round-trip from GET with resolved content; store only
        // the marker so the target trip stays the single source of truth.
        const days = {}
        for (const [date, day] of Object.entries(body.days)) {
          const problem = validateLinkedDay(day, trip.id)
          if (problem) return res.status(400).json({ error: problem })
          days[date] = normalizeLinkedDay(day)
        }
        trip.days = days
      }
      if ('hotelStays' in body) {
        const { stays, error } = normalizeHotelStays(body.hotelStays)
        if (error) return res.status(400).json({ error })
        trip.hotelStays = stays
      }
      if ('flightTrips' in body) {
        const { flightTrips, error } = normalizeFlightTrips(body.flightTrips)
        if (error) return res.status(400).json({ error })
        trip.flightTrips = flightTrips
      }
      trip.updatedAt = new Date().toISOString()
      await storage.writeTrip(trip)
      // Responses always carry resolved days, like GET — the client keeps
      // rendering from whatever trip object it last received.
      const resolved = await resolveTripDays(trip, { storage, username: req.username })
      res.json(withPermissions(resolved, req.username))
    })
  )

  // Names of trips that link days to this one — the client checks this on
  // delete so the copy-and-delete warning shows before any confirmation.
  app.get(
    '/api/trips/:id/linkers',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!req.username) return res.status(401).json({ error: 'authentication required' })
      if (!isOwner(trip, req.username))
        return res.status(403).json({ error: 'only the owner can inspect linking trips' })
      const linkers = await findLinkingTrips(trip.id, storage)
      res.json({ linkers: linkers.map((t) => t.name) })
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

      // Other trips may link days to this one. A plain delete would leave
      // them with broken links, so it is refused; ?copyLinks=1 materializes
      // this trip's content into the linking trips first.
      const linkers = await findLinkingTrips(trip.id, storage)
      if (linkers.length > 0 && req.query.copyLinks !== '1')
        return res.status(409).json({
          error: `Days of this trip are linked from ${linkers.map((t) => `"${t.name}"`).join(', ')}. Copy the itinerary details to those trips and delete, or cancel.`,
          linkers: linkers.map((t) => t.name),
        })
      if (linkers.length > 0) {
        const sourceImages = await storage.readImages(trip.id)
        for (const linker of linkers) {
          const usedImageIds = []
          for (const [date, day] of Object.entries(linker.days ?? {})) {
            if (day?.linkedTripId !== trip.id) continue
            const sourceDay = trip.days?.[date]
            linker.days[date] = sourceDay
              ? structuredClone(sourceDay)
              : { title: '', mapsUrl: '', items: [] }
            for (const item of linker.days[date].items ?? [])
              usedImageIds.push(...(item.imageIds ?? []))
            // The day's hotel coverage came from this trip too — keep it.
            for (const stay of trip.hotelStays ?? []) {
              if (!(stay.checkInDay <= date && date <= stay.checkOutDay)) continue
              linker.hotelStays = linker.hotelStays ?? []
              const exists = linker.hotelStays.some(
                (s) =>
                  s.hotelName === stay.hotelName &&
                  s.checkInDay === stay.checkInDay &&
                  s.checkOutDay === stay.checkOutDay
              )
              if (!exists) linker.hotelStays.push({ ...stay })
            }
            // Flight coverage for this day came from this trip too — keep it.
            for (const ft of trip.flightTrips ?? []) {
              const touches = (ft.flights ?? []).some(
                (f) =>
                  f.departureTime?.slice(0, 10) === date || f.arrivalTime?.slice(0, 10) === date
              )
              if (!touches) continue
              linker.flightTrips = linker.flightTrips ?? []
              const exists = linker.flightTrips.some(
                (t) => JSON.stringify(t.flights) === JSON.stringify(ft.flights)
              )
              if (!exists) linker.flightTrips.push(structuredClone(ft))
            }
          }
          if (usedImageIds.length > 0) {
            const linkerImages = await storage.readImages(linker.id)
            let imagesChanged = false
            for (const imageId of usedImageIds) {
              if (sourceImages[imageId] && !linkerImages[imageId]) {
                linkerImages[imageId] = sourceImages[imageId]
                imagesChanged = true
              }
            }
            if (imagesChanged) await storage.writeImages(linker.id, linkerImages)
          }
          linker.updatedAt = new Date().toISOString()
          await storage.writeTrip(linker)
        }
      }

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

  // Imports the photo behind a Google Maps share link (or a direct
  // googleusercontent image URL) into the trip's image store. Fetches are
  // restricted to Google hosts, and the resolved image is stored as the same
  // kind of data URI a pasted image produces.
  const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  app.post(
    '/api/trips/:id/images/from-url',
    wrap(async (req, res) => {
      const trip = await loadViewableTrip(req, res)
      if (!trip) return
      if (!requireEditable(trip, req, res)) return
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
      if (!isMapsPhotoLink(url))
        return res
          .status(400)
          .json({ error: 'url must be a Google Maps link or googleusercontent image URL' })

      let imageUrl = null
      try {
        if (isPhotoHost(url)) {
          imageUrl = upgradePhotoSize(url)
        } else {
          const page = await fetch(url, {
            redirect: 'follow',
            headers: { 'user-agent': BROWSER_UA },
            signal: AbortSignal.timeout(15_000),
          })
          // The redirect target's URL usually carries the photo; the page
          // HTML is the fallback. Both only ever yield googleusercontent URLs.
          imageUrl = extractPhotoUrl(page.url)
          if (!imageUrl && (page.headers.get('content-type') ?? '').includes('text/html')) {
            imageUrl = extractPhotoUrl(await page.text())
          }
        }
      } catch {
        imageUrl = null
      }
      if (!imageUrl)
        return res.status(422).json({ error: "couldn't find a photo in that link" })

      let dataUri
      try {
        const img = await fetch(imageUrl, {
          headers: { 'user-agent': BROWSER_UA },
          signal: AbortSignal.timeout(20_000),
        })
        const type = (img.headers.get('content-type') ?? '').split(';')[0]
        if (!img.ok || !type.startsWith('image/')) throw new Error('not an image')
        const buf = Buffer.from(await img.arrayBuffer())
        dataUri = `data:${type};base64,${buf.toString('base64')}`
      } catch {
        return res.status(422).json({ error: "that link's photo could not be downloaded" })
      }
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
      let watchdog
      const aborter = new AbortController()
      try {
        const chat = await storage.readChat(trip.id)
        // Messages from previously failed turns stay in the file (the client
        // shows them as "not sent") but are never replayed to the model — a
        // retry would otherwise be answered twice.
        const messages = [
          ...chat.messages.filter((m) => m.failed !== true),
          { role: 'user', content: [{ text: message }] },
        ]
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('the assistant took too long to respond — please try again')),
            chatTimeoutMs
          )
        })
        // A healthy generation streams chunks continuously; prolonged silence
        // means the provider connection stalled. Fail fast so the chat lock
        // frees, instead of holding "thinking…" until the total timeout. The
        // same tick sends an SSE comment so proxies keep the stream open.
        let lastActivity = Date.now()
        const markActivity = () => {
          lastActivity = Date.now()
        }
        const stalled = new Promise((_, reject) => {
          watchdog = setInterval(() => {
            res.write(': keepalive\n\n')
            if (Date.now() - lastActivity > chatIdleMs)
              reject(
                new Error(
                  'the assistant stopped responding (connection stalled) — please try again'
                )
              )
          }, Math.min(15_000, Math.max(25, Math.floor(chatIdleMs / 2))))
        })
        // The agent sees linked days as ordinary content (resolved), and the
        // tool write-through uses the username for target-trip permission.
        const resolvedTrip = await resolveTripDays(trip, { storage, username: req.username })
        const updated = await Promise.race([
          agent.respond({
            model,
            trip: resolvedTrip,
            messages,
            storage,
            emit,
            username: req.username,
            onActivity: markActivity,
            abortSignal: aborter.signal,
          }),
          timeout,
          stalled,
        ])
        // An AI-created trip keeps its provisional prompt-derived slug only
        // until the agent names it; then it's renamed once to a
        // "<name>-<month>-<year>-<suffix>" slug. The final trip event carries
        // the new id so the client can follow the URL.
        let chatId = trip.id
        const fresh = await storage.readTrip(trip.id)
        if (fresh?.provisionalSlug && fresh.name !== trip.name) {
          delete fresh.provisionalSlug
          await storage.writeTrip(fresh)
          const newId = storage.slugify(agentSlugBasis(fresh))
          if (!RESERVED_SLUGS.has(newId) && !(await storage.readTrip(newId))) {
            await storage.renameTrip(trip.id, newId)
            chatId = newId
          }
        }
        await storage.writeChat(chatId, { messages: updated })
        if (chatId !== trip.id) emit('trip', { id: chatId })
        emit('done', {})
      } catch (err) {
        console.error(err)
        // The turn failed, but the traveler's message must not be lost:
        // persist it flagged as failed so the client can show it (and the
        // traveler can copy/retry) even after a reload.
        try {
          const chat = await storage.readChat(trip.id)
          await storage.writeChat(trip.id, {
            messages: [...chat.messages, { role: 'user', failed: true, content: [{ text: message }] }],
          })
        } catch {
          // preserving the message is best-effort; the error event still goes out
        }
        emit('error', { error: err.message ?? 'generation failed' })
      } finally {
        // Stop the abandoned generation too — without this it keeps running
        // in the background and can mutate the trip minutes later.
        aborter.abort()
        clearTimeout(timer)
        clearInterval(watchdog)
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
