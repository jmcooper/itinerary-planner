import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrateDataDir } from '../src/migrate.js'

let dataDir

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'itin-migrate-'))
})

afterEach(async () => rm(dataDir, { recursive: true, force: true }))

const legacyTrip = {
  id: 'legacy-trip',
  name: 'Legacy',
  days: {
    '2026-07-01': {
      mapsUrl: 'https://maps.example',
      items: [{ time: '8:00 am', plan: 'Go', code: 'S1', details: '## S1 — Go\n\nText.' }],
    },
  },
}

test('migrateDataDir converts legacy trips and backs up originals first', async () => {
  await writeFile(path.join(dataDir, 'legacy-trip.json'), JSON.stringify(legacyTrip))
  await writeFile(path.join(dataDir, 'legacy-trip.images.json'), '{}')
  await mkdir(path.join(dataDir, 'users'))
  await writeFile(path.join(dataDir, 'users', 'alice.json'), '{}')

  const result = await migrateDataDir(dataDir)
  assert.equal(result.migrated, 1)
  assert.ok(result.backupDir)

  // Backup contains the original legacy file
  const backedUp = JSON.parse(await readFile(path.join(result.backupDir, 'legacy-trip.json'), 'utf8'))
  assert.equal(backedUp.days['2026-07-01'].items[0].plan, 'Go')

  // Live file is converted
  const migrated = JSON.parse(await readFile(path.join(dataDir, 'legacy-trip.json'), 'utf8'))
  const item = migrated.days['2026-07-01'].items[0]
  assert.equal(item.title, 'Go')
  assert.equal(item.timeStart, '08:00')
  assert.ok(!('plan' in item))
})

test('migrateDataDir is a no-op on already-migrated data', async () => {
  await writeFile(path.join(dataDir, 'legacy-trip.json'), JSON.stringify(legacyTrip))
  await migrateDataDir(dataDir)
  const again = await migrateDataDir(dataDir)
  assert.equal(again.migrated, 0)
  assert.equal(again.backupDir, null)
  // Only one backup dir was ever created
  const backups = (await readdir(dataDir)).filter((f) => f.startsWith('backup-'))
  assert.equal(backups.length, 1)
})

test('migrateDataDir handles a missing data dir and empty trips', async () => {
  const missing = await migrateDataDir(path.join(dataDir, 'does-not-exist'))
  assert.deepEqual(missing, { migrated: 0, backupDir: null })

  await writeFile(path.join(dataDir, 'no-days.json'), JSON.stringify({ id: 'no-days', days: {} }))
  await writeFile(path.join(dataDir, 'corrupt.json'), '{not json')
  const result = await migrateDataDir(dataDir)
  assert.equal(result.migrated, 0)
})
