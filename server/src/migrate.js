// Migrates trip files from the legacy day format ({time, plan, code, details,
// images}) to time blocks. Runs automatically at server startup and via
// scripts/migrate-days.mjs; originals are backed up before anything is written.
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { migrateTripDays } from './timeblocks.js'

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
    if (!migrateTripDays(trip)) continue
    // Back up the original before overwriting it
    await mkdir(backupDir, { recursive: true })
    await copyFile(full, path.join(backupDir, file))
    await writeFile(full, JSON.stringify(trip, null, 2), 'utf8')
    migrated++
  }
  return { migrated, backupDir: migrated ? backupDir : null }
}
