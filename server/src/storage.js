import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export function createStorage(dataDir) {
  async function ensureDir() {
    await mkdir(dataDir, { recursive: true })
  }

  function fileFor(id) {
    return path.join(dataDir, `${id}.json`)
  }

  async function readTrip(id) {
    if (!/^[a-z0-9-]+$/.test(id)) return null
    try {
      return JSON.parse(await readFile(fileFor(id), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async function writeTrip(trip) {
    await ensureDir()
    const target = fileFor(trip.id)
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(trip, null, 2), 'utf8')
    await rename(tmp, target)
    return trip
  }

  async function listTrips() {
    await ensureDir()
    const files = (await readdir(dataDir)).filter((f) => f.endsWith('.json'))
    const trips = []
    for (const file of files) {
      try {
        trips.push(JSON.parse(await readFile(path.join(dataDir, file), 'utf8')))
      } catch {
        // skip unreadable/corrupt files rather than failing the whole list
      }
    }
    trips.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    return trips
  }

  async function deleteTrip(id) {
    const trip = await readTrip(id)
    if (!trip) return false
    await rm(fileFor(id))
    return true
  }

  function slugify(name) {
    const base = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const suffix = randomBytes(3).toString('hex')
    return base ? `${base}-${suffix}` : suffix
  }

  return { readTrip, writeTrip, listTrips, deleteTrip, slugify }
}
