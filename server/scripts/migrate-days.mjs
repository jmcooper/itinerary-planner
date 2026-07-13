// Manual entry point for the day-format migration (it also runs automatically
// at server startup — see src/index.js). Originals are backed up first.
// Usage: node scripts/migrate-days.mjs [dataDir]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateDataDir } from '../src/migrate.js'

const dataDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')

const { migrated, backupDir } = await migrateDataDir(dataDir)
console.log(
  migrated
    ? `Done: ${migrated} trip(s) migrated. Backups in ${backupDir}`
    : 'Nothing to migrate.'
)
