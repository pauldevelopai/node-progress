# Progress Tracker — a GROUNDED Node (Claude Code map)

> Auto-loaded by Claude Code. Read before changing things. This Node is part of
> the GROUNDED system — the whole-system map is `pauldevelopai/nodes` →
> `HANDOVER.md` then `ADD_A_NODE.md`. This file is just the per-repo orientation.

## What this is

A newsroom manager's accountability dashboard: who's publishing what across
**Facebook / website / TikTok / WhatsApp**, vs. targets, plus how posts perform.
Reporters' output is logged by hand or pasted as a free-text end-of-day report
that `host.ai` parses into entries. Performance numbers are entered by hand (v1).

Built on `@developai/grounded-node-runtime#v0.10.0`. Same handler code runs two
ways:

- **Local** — `index.js` → `createServer` + `createLiteHost`. Storage = JSON
  files under `data/processed/`. AI = the newsroom's own key.
- **Hosted** — `server-hosted.js` → `createHostedServer` (sets
  `GROUNDED_HOSTED=1`). Storage = per-newsroom Postgres (`ensureSchema`). Auth =
  tracker cookie. AI = server key. Nav/feedback chrome injected via
  `/nodes/chrome.js`.

## Files

| File | Role |
|------|------|
| `index.js` | Local boot. `createServer(...)` then `mountProgressRoutes(app, () => host)`. |
| `server-hosted.js` | Online boot. `createHostedServer({ handlers, ensureSchema, mountRoutes })`. |
| `lib/schema.js` | The three Postgres tables (hosted): `reporters`, `entries`, `metrics`. |
| `lib/store.js` | Data access via `host.db` only. Inserts list `newsroom_id` first; reads are plain per-newsroom selects. |
| `lib/report.js` | `buildDashboard(...)` — ALL aggregation, in JS. |
| `lib/parse-report.js` | `host.ai` parse of a free-text daily report → `{items:[…]}`. |
| `lib/handlers.js` | Standard routes: `getSetupStatus`, `postSetup`, `getReport`, `getActivity`, `postBrief`. |
| `lib/routes.js` | Custom write routes: `/api/reporters`, `/api/entries`, `/api/daily-report`, `/api/metrics`. |
| `lib/beacon.js` | Local-install telemetry heartbeat (counts only). |
| `public/` | Dashboard. **Relative** paths only (`fetch("api/…")`, `<script src="app.js">`). |

## The one rule that bites: keep SQL lite-compatible

The lite host's JSON "SQL" engine (runtime `src/host-lite.js`) only understands:
- `SELECT * … WHERE newsroom_id = $1 [AND source_label = $2]` (+ `GROUP BY
  source_label`, `ORDER BY ingested_at DESC LIMIT 1`, `ORDER BY n`)
- `INSERT INTO t (newsroom_id, …) VALUES ($1,$2,…)` — **`newsroom_id` first**,
  user params start at `$2`; the host binds `$1`.
- `DELETE … WHERE newsroom_id = $1 AND source_label = $2`

So: **no JOINs, no `WHERE reporter_id`, no `GROUP BY reporter` in SQL.** Every
read is a simple per-newsroom select; reporter↔entry↔metric joining and all
roll-ups happen in JS (`lib/report.js`). `reporter_name` is denormalised onto
entries and metrics for exactly this reason. `id` (bigserial) and `ingested_at`
(`DEFAULT now()` / stamped by the lite host) are never inserted by hand.

Postgres runs the same SQL verbatim with `$1 = newsroom_id` auto-bound, so valid
lite shapes are also valid pg.

## Gotchas

- **Relative paths in `public/`** — hosted serves under `/nodes/progress-tracker/app/`.
  An absolute `/api/…` or `/app.js` hits the tracker and 404s (the "only nav, no
  content" bug).
- **Don't hand-write nav** — runtime v0.10.0 injects `/nodes/chrome.js`.
- **Bump the runtime** — pinned by git tag in `package.json`; after a tag move,
  on the box `rm -rf node_modules/@developai && npm install && pm2 restart progress-tracker-hosted`.

## Deploy

- Code change to this Node, on the box:
  `cd /home/ubuntu/node-progress-tracker && git pull && rm -rf node_modules/@developai && npm install && pm2 restart progress-tracker-hosted`
- First-time host: `cd /home/ubuntu/nodes && bash deploy-node.sh progress-tracker <port>`
  then paste the Caddy block + `sudo systemctl restart caddy`.

## Next

- Inbound WhatsApp/email → `POST /api/daily-report` bridge (Twilio / email
  forwarder) so reporters submit directly.
- A connector layer (stored per-platform login details) to pull performance
  automatically instead of manual entry — the `metrics` table + dashboard are
  already shaped for it.
