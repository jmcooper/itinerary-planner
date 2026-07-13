import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createAiAgent } from './ai.js'
import { migrateDataDir } from './migrate.js'

const dataDir =
  process.env.DATA_DIR ?? path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')
const port = Number(process.env.PORT ?? 3001)

// Upgrade any legacy-format trip data before serving (backs up originals).
const migration = await migrateDataDir(dataDir)
if (migration.migrated > 0)
  console.log(
    `Migrated ${migration.migrated} trip(s) to the time-block format (backups in ${migration.backupDir})`
  )

const agent = createAiAgent()

createApp(dataDir, { agent }).listen(port, () => {
  console.log(`Itinerary server listening on http://localhost:${port} (data: ${dataDir})`)
  console.log(
    agent.enabled
      ? 'AI assistant enabled'
      : 'AI assistant disabled (set ANTHROPIC_API_KEY and/or GEMINI_API_KEY)'
  )
})
