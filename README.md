# Bloom Outbound App — standalone dashboard

A real, self-hosted version of the Bloom outbound review dashboard: same
Hold / Edit / Send flow and branding, but running as its own web app instead
of inside Cowork. Send calls Apollo's API directly — no Cowork bridge, no chat.

## What's here

- `server.js` — Express app: serves the dashboard, exposes the API.
- `lib/apollo.js` — direct calls to Apollo's REST API (contacts search, create
  draft, send now, check status) using your own Apollo API key.
- `lib/store.js` — reads/writes `data/queue.json` (today's queue + per-item
  status: pending / held / sent). File-based for now; swap for a real database
  once this needs to hold more than one day / one user.
- `public/index.html` — the dashboard itself (Bloom's branding head + the
  Hold/Edit/Send interaction, adapted to call this server instead of
  `window.cowork.callMcpTool`).
- `data/queue.json` — seeded with today's real queue so the app is demoable
  immediately.

## What's NOT here yet (by design, for v1)

- **The research/reconciliation brain.** Deciding what's due today, reconciling
  yesterday's sends, and researching + drafting new accounts still happens in
  the Cowork scheduled task (`bloom-outbound-review`), same as now. This app
  is the *front end + send mechanism* for that output. See "Daily sync" below
  for how the two connect.
- **Multi-tenant / ICP-upload flow.** The vision of "anyone can paste an ICP
  and upload 500 contacts" is a phase-2 build: real user accounts, a database
  instead of a JSON file, and moving the research step server-side (needs an
  LLM API key + web search, not just Apollo). This v1 is deliberately scoped
  to "get the main feature working" first.

## 1. Run it locally (to try it before deploying)

```
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000 — you'll see today's real queue. Hold works
immediately. Send will show "Apollo not configured" until you add
`APOLLO_API_KEY` to `.env` and restart.

## 2. Get an Apollo API key

Apollo Settings → Integrations → API (or ask your product contact — sounds
like Sterling is already looped in for Monday). This key is **different**
from the OAuth connection Cowork uses — it's a direct API key tied to
whichever Apollo user it's created under (sends will come from that user's
linked mailbox).

Add it as `APOLLO_API_KEY` — locally in `.env`, or as an environment variable
in your hosting dashboard once deployed. Nothing else needs to change; Send
starts working the moment the key is present.

## 3. Deploy it (Render — free tier is fine to start)

1. Push this folder to a GitHub repo (private is fine).
2. Go to render.com → New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add:
   - `APOLLO_API_KEY` — from step 2 (or leave blank until Monday — the app
     works fine without it, Send just stays disabled).
   - `SYNC_SECRET` — any long random string you make up (used in step 4 below).
5. Deploy. Render gives you a URL like `https://bloom-outbound.onrender.com`
   — that's the one you bookmark and open every morning.

Railway, Fly.io, or a plain VM work the same way (`npm install && npm start`,
same environment variables). Render's free tier just needs the least setup.

**Note on storage:** `data/queue.json` lives on the app's local disk. Render's
free tier disk is *not* persistent across redeploys — fine for now while
you're iterating, but before this matters day-to-day, either add a paid
persistent disk in Render, or (better, once you're ready) swap `lib/store.js`
for a small Postgres/SQLite database.

## 4. Wire up daily sync (connects this to the existing Cowork automation)

Right now the Cowork scheduled task computes today's queue and writes it into
a Cowork artifact. To feed this app instead (or as well), it needs one more
step each morning: POST the same queue JSON to this app.

```
POST https://<your-app-url>/api/sync
Headers: x-sync-secret: <the SYNC_SECRET you set>
Body: { "today": "2026-07-25", "queue": [ ...same shape as todays_queue.json... ] }
```

Once you have a live URL, tell Claude in Cowork to add this POST call as a
step in the `bloom-outbound-review` scheduled task (right after it builds
`todays_queue.json`), and it'll keep both the Cowork artifact and this
standalone site in sync automatically every weekday morning — no manual copy.

## API reference

- `GET /api/health` → `{ ok, apolloConfigured }`
- `GET /api/queue` → `{ today, queue: [{ id, status, company, contact, to, step, subject, body }] }`
- `POST /api/sync` (needs `x-sync-secret` header) → overwrites today's queue
- `POST /api/items/:id/hold` → marks an item held
- `POST /api/items/:id/send` body `{ to, subject, body }` → looks up the
  contact in Apollo by exact email, drafts, sends, returns
  `{ status: 'completed' | 'queued' | 'failed', message }`
- `POST /api/research-more` → not implemented yet (placeholder), returns 501
  with a message pointing back to the Cowork artifact's "Go for more" button
