import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createAiAgent } from './ai.js'

const dataDir =
  process.env.DATA_DIR ?? path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')
const port = Number(process.env.PORT ?? 3001)

const agent = createAiAgent()

createApp(dataDir, { agent }).listen(port, () => {
  console.log(`Itinerary server listening on http://localhost:${port} (data: ${dataDir})`)
  console.log(agent.enabled ? `AI assistant enabled (${agent.model})` : 'AI assistant disabled (set AI_MODEL + provider key)')
})
