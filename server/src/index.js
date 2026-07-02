import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'

const dataDir =
  process.env.DATA_DIR ?? path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../data')
const port = Number(process.env.PORT ?? 3001)

createApp(dataDir).listen(port, () => {
  console.log(`Itinerary server listening on http://localhost:${port} (data: ${dataDir})`)
})
