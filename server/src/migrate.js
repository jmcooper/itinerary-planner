// Migrates trip files from the legacy day format ({time, plan, code, details,
// images}) to time blocks. Runs automatically at server startup and via
// scripts/migrate-days.mjs; originals are backed up before anything is written.
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { migrateTripDays } from './timeblocks.js'

function toUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function listDates(startDate, endDate) {
  const dates = []
  for (let t = toUtc(startDate); t <= toUtc(endDate) && dates.length < 366; t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}

// Converts a range-based trip (startDate/endDate + sparse days) to the
// explicit-days shape: every in-range date gets a day entry (empty entries for
// unplanned dates) and the range fields are removed. Returns true if changed.
export function normalizeTripShape(trip) {
  if (!('startDate' in trip) && !('endDate' in trip)) return false
  trip.days = trip.days ?? {}
  if (trip.startDate && trip.endDate && trip.endDate >= trip.startDate) {
    for (const date of listDates(trip.startDate, trip.endDate)) {
      trip.days[date] ??= { title: '', mapsUrl: '', items: [] }
    }
  }
  delete trip.startDate
  delete trip.endDate
  return true
}

// Converts legacy hotel stays ({ confirmationNumber: string }) to the
// multi-confirmation shape ({ confirmations: [{ confirmationNumber, rooms }] }).
// Returns true if the trip changed.
export function migrateHotelStays(trip) {
  let changed = false
  for (const stay of trip.hotelStays ?? []) {
    if (typeof stay !== 'object' || stay === null) continue
    if (Array.isArray(stay.confirmations) && !('confirmationNumber' in stay)) continue
    const conf = typeof stay.confirmationNumber === 'string' ? stay.confirmationNumber.trim() : ''
    stay.confirmations = conf ? [{ confirmationNumber: conf, rooms: [] }] : []
    delete stay.confirmationNumber
    changed = true
  }
  return changed
}

export async function migrateDataDir(dataDir) {
  let files
  try {
    files = await readdir(dataDir)
  } catch (err) {
    if (err.code === 'ENOENT') return { migrated: 0, backupDir: null }
    throw err
  }
  const tripFiles = files.filter(
    (f) =>
      f.endsWith('.json') &&
      !f.endsWith('.images.json') &&
      !f.endsWith('.chat.json') &&
      f !== 'users.json'
  )

  const backupDir = path.join(
    dataDir,
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  )
  let migrated = 0
  for (const file of tripFiles) {
    const full = path.join(dataDir, file)
    let trip
    try {
      trip = JSON.parse(await readFile(full, 'utf8'))
    } catch {
      console.warn(`migration: skipping unreadable ${file}`)
      continue
    }
    if (!trip || typeof trip !== 'object' || !trip.days) continue
    const itemsChanged = migrateTripDays(trip)
    const shapeChanged = normalizeTripShape(trip)
    const staysChanged = migrateHotelStays(trip)
    if (!itemsChanged && !shapeChanged && !staysChanged) continue
    // Back up the original before overwriting it
    await mkdir(backupDir, { recursive: true })
    await copyFile(full, path.join(backupDir, file))
    await writeFile(full, JSON.stringify(trip, null, 2), 'utf8')
    migrated++
  }
  return { migrated, backupDir: migrated ? backupDir : null }
}
