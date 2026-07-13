# Itinerary Builder

A travel-itinerary builder with an integrated AI planning assistant: describe your trip
("Yellowstone 7/1–7/4, entering from West Yellowstone…") and the assistant names the
trip, sets the dates, and drafts a day-by-day itinerary you refine in chat ("Let's have
day 2 end at 3pm"). Every day is also editable by hand, and a manual creation path
(date pickers + CSV paste) remains available when no AI provider is configured.

- **Frontend**: React + Vite (client-side only), React Router, react-markdown, custom CSS
- **Backend**: Node Express; trips stored as JSON files in `server/data/` (no database)
- **AI**: [Genkit](https://genkit.dev) with Anthropic and/or Google AI providers,
  streaming chat over SSE, itinerary edits applied via a typed `updateItinerary` tool

## AI configuration

Copy `server/.env.example` to `server/.env` and set one or more provider keys:

```
ANTHROPIC_API_KEY=sk-ant-...   # enables Anthropic (Claude) models
GEMINI_API_KEY=...             # enables Google AI (Gemini) models
```

The app discovers each configured provider's chat-capable models at runtime and offers
them in a model dropdown on the AI dialogs (new-trip form and chat panel); the last-used
model is remembered per browser. With no keys set, all AI UI hides itself and the app
behaves like the classic manual builder.

Note: the AI assistant is available to anyone with **edit** access on a trip, and all
usage bills to the server's API keys.

## Data migration (one-time)

The AI integration changed the on-disk day format from `{time, plan, code, details}`
rows to time blocks (`{timeStart, timeEnd, title, description, imageIds}`). Migrate
existing data once before deploying this version:

```sh
cd server
node scripts/migrate-days.mjs           # migrates ./data (or pass a data dir)
```

Originals are backed up to `data/backup-<timestamp>/`; the script is idempotent.

## Development

```sh
npm install
npm --prefix server install
npm --prefix client install

npm run dev   # Express on :3001 + Vite dev server on :5173 (proxies /api)
```

Open http://localhost:5173.

## Tests

```sh
npm test      # server API tests (node:test) + client parse tests (vitest)
```

## Production build & deploy

```sh
npm run build   # outputs static site to client/dist
```

### Option A — Node serves everything

`npm start` runs Express on `:3001`; it serves `client/dist` (with SPA fallback) and the
`/api` routes from one process. Put nginx in front as a plain reverse proxy if desired.

### Option B — nginx serves the static app, proxies the API

```nginx
server {
    listen 80;
    server_name example.com;

    root /var/www/itinerary/client/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }

    location / {
        try_files $uri /index.html;   # SPA fallback
    }
}
```

Run the API with `PORT=3001 node server/src/index.js` (systemd, pm2, etc.). Trip data
lives in `server/data/*.json` — set `DATA_DIR` to relocate it; back it up by copying the
directory.

### Option C — Docker (production, via the webhost)

Production runs behind the [webhost](https://git.cooperplanet.com) reverse proxy at
https://travel.cooperplanet.com on the `10.42.10.0/24` subnet:

- `ui` (`10.42.10.20`) — nginx serving the built client, proxying `/api` to the API
  container ([client/Dockerfile](client/Dockerfile), [client/nginx.conf](client/nginx.conf))
- `api` (`10.42.10.40`) — Express on `:3001`, internal only; trip data persisted to
  `./data` on the host via a bind mount (`DATA_DIR=/data`)

Deploy on the server:

```sh
docker compose up -d --build       # from this repo
docker exec nginx nginx -s reload  # from the webhost repo, first deploy only
```

The webhost side (server block + routing-table entry) lives in the webhost repo:
`nginx/servers/travel.cooperplanet.conf`. TLS is covered by the existing
`*.cooperplanet.com` wildcard cert.

## Day import format

CSV (`Time,Plan,Detail` header optional):

```
Time,Plan,Detail
8:00 am,Leave Holiday Inn West Yellowstone,S1
8:05–8:40,Enter park and drive to Madison Junction,S2
```

Details markdown — one section per stop, separated by `---`, headed by the matching code:

```
## S1 — Leave Holiday Inn West Yellowstone

Leave at **8:00 am** …

---

## S2 — Enter park and drive to Madison Junction

…
```

The `S#` codes link CSV rows to their detail sections. Unmatched sections are appended
rather than dropped; malformed CSV rows are skipped with a warning.
