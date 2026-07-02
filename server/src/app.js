import express from 'express'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStorage } from './storage.js'

export function createApp(dataDir) {
  const app = express()
  const storage = createStorage(dataDir)
  app.use(express.json({ limit: '15mb' }))

  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next)

  app.get(
    '/api/trips',
    wrap(async (req, res) => {
      const trips = await storage.listTrips()
      res.json(
        trips.map(({ id, name, startDate, endDate, createdAt, updatedAt }) => ({
          id,
          name,
          startDate,
          endDate,
          createdAt,
          updatedAt,
        }))
      )
    })
  )

  app.post(
    '/api/trips',
    wrap(async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      if (!name) return res.status(400).json({ error: 'name is required' })
      const now = new Date().toISOString()
      const trip = {
        id: storage.slugify(name),
        name,
        startDate: null,
        endDate: null,
        days: {},
        createdAt: now,
        updatedAt: now,
      }
      await storage.writeTrip(trip)
      res.status(201).json(trip)
    })
  )

  app.get(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const trip = await storage.readTrip(req.params.id)
      if (!trip) return res.status(404).json({ error: 'trip not found' })
      res.json(trip)
    })
  )

  app.put(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const trip = await storage.readTrip(req.params.id)
      if (!trip) return res.status(404).json({ error: 'trip not found' })
      const body = req.body ?? {}
      if ('name' in body) {
        if (typeof body.name !== 'string' || !body.name.trim())
          return res.status(400).json({ error: 'name must be a non-empty string' })
        trip.name = body.name.trim()
      }
      for (const key of ['startDate', 'endDate']) {
        if (key in body) {
          if (body[key] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body[key]))
            return res.status(400).json({ error: `${key} must be YYYY-MM-DD or null` })
          trip[key] = body[key]
        }
      }
      if ('days' in body) {
        if (typeof body.days !== 'object' || body.days === null || Array.isArray(body.days))
          return res.status(400).json({ error: 'days must be an object keyed by date' })
        trip.days = body.days
      }
      trip.updatedAt = new Date().toISOString()
      await storage.writeTrip(trip)
      res.json(trip)
    })
  )

  app.delete(
    '/api/trips/:id',
    wrap(async (req, res) => {
      const removed = await storage.deleteTrip(req.params.id)
      if (!removed) return res.status(404).json({ error: 'trip not found' })
      res.status(204).end()
    })
  )

  // Images are stored per trip in a separate <id>.images.json file so trip
  // fetches stay small; clients load image data on demand by id.
  const DATA_URI_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i
  const MAX_DATA_URI_CHARS = 14_000_000 // ~10MB of image data

  app.post(
    '/api/trips/:id/images',
    wrap(async (req, res) => {
      const trip = await storage.readTrip(req.params.id)
      if (!trip) return res.status(404).json({ error: 'trip not found' })
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
      const trip = await storage.readTrip(req.params.id)
      if (!trip) return res.status(404).json({ error: 'trip not found' })
      const images = await storage.readImages(trip.id)
      const dataUri = images[req.params.imageId]
      if (!dataUri) return res.status(404).json({ error: 'image not found' })
      res.json({ id: req.params.imageId, dataUri })
    })
  )

  app.delete(
    '/api/trips/:id/images/:imageId',
    wrap(async (req, res) => {
      const trip = await storage.readTrip(req.params.id)
      if (!trip) return res.status(404).json({ error: 'trip not found' })
      const images = await storage.readImages(trip.id)
      if (!(req.params.imageId in images)) return res.status(404).json({ error: 'image not found' })
      delete images[req.params.imageId]
      await storage.writeImages(trip.id, images)
      res.status(204).end()
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
