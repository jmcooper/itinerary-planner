// One-shot migration of trip day items from {time, plan, code, details, images}
// to {timeStart, timeEnd, timeLabel, title, description, imageIds}.
// Usage: node scripts/migrate-days.mjs [dataDir]
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateTripDays } from '../src/timeblocks.js'

const dataDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')

const backupDir = path.join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const files = (await readdir(dataDir)).filter(
  (f) =>
    f.endsWith('.json') &&
    !f.endsWith('.images.json') &&
    !f.endsWith('.chat.json') &&
    f !== 'users.json'
)

let migrated = 0
for (const file of files) {
  const full = path.join(dataDir, file)
  let trip
  try {
    trip = JSON.parse(await readFile(full, 'utf8'))
  } catch {
    console.warn(`skipping unreadable ${file}`)
    continue
  }
  if (!trip || typeof trip !== 'object' || !trip.days) continue
  if (!migrateTripDays(trip)) continue
  await mkdir(backupDir, { recursive: true })
  await copyFile(full, path.join(backupDir, file))
  await writeFile(full, JSON.stringify(trip, null, 2), 'utf8')
  migrated++
  console.log(`migrated ${file}`)
}
console.log(
  migrated ? `Done: ${migrated} trip(s) migrated. Backups in ${backupDir}` : 'Nothing to migrate.'
)
