# Progress Tracker — a GROUNDED Node (Claude Code map)

> Auto-loaded by Claude Code. Read before changing things. This Node is part of
> the GROUNDED system — the whole-system map is `pauldevelopai/nodes` →
> `HANDOVER.md` then `ADD_A_NODE.md`. This file is just the per-repo orientation.

## What this is

A newsroom manager's accountability dashboard: who's publishing what across
**Facebook / website / TikTok / WhatsApp**, vs. targets, plus how posts perform.
Reporters' output reaches the system three ways, all feeding ONE parse+save
pipeline: logged by hand, pasted by the manager, the reporter's self-serve submit
link, or **emailed by the reporter** (the inbound-email webhook). `host.ai` turns
free-text into entries. Performance numbers come in two ways: entered by hand, or
pulled automatically by a **performance connector** (Facebook Page Insights is the
first; the framework is pluggable). The editor views everything by **Today / This
week / This month / This year / All time**, with a per-reporter drill-down.

Built on `@developai/grounded-node-runtime#v0.14.0`. Same handler code runs two
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
| `lib/report.js` | `buildDashboard(data, now, newsroomId, period)` + `buildAllPeriods(...)` — ALL aggregation, in JS, per time period. `getReport` returns every period at once so the client switches with no re-fetch. |
| `lib/parse-report.js` | `host.ai` parse of a free-text daily report → `{items:[…]}`. |
| `lib/inbound.js` | Email self-report: `normalizeInbound` (provider-agnostic payload → {from,to,subject,text,token}) + `ingestInboundEmail` (sender→reporter match → same parse+save path). |
| `lib/handlers.js` | Standard routes: `getSetupStatus`, `postSetup`, `getReport`, `getActivity`, `postBrief`. `loadAll` merges hand-entered metrics + connector auto-metrics. |
| `lib/routes.js` | Custom routes: `/api/reporters`, `/api/entries`, `/api/daily-report`, `/api/metrics`, `/api/connectors[/:id/config\|/sync]`, `/api/inbound`; **ungated** `/submit/*` + `/inbound/email`. |
| `lib/connectors/index.js` | Pluggable connector framework: config + pulled metrics live in `host.store` (not the metrics table — keeps re-sync idempotent on the lite engine). `runSync`, `listAutoMetrics`, `describeConnectors`. |
| `lib/connectors/facebook.js` | Facebook Page Insights connector (Graph API; attributes posts to reporters by permalink↔entry-URL match). |
| `lib/beacon.js` | Local-install telemetry heartbeat (counts only). |
| `tests/connectors.test.js` | `node --test` — connector framework + FB connector with a mock fetch (no network/key). |
| `tests/report-periods.test.js` | Period-window aggregation (today/week/month/year/all), target scaling, timeline granularity. |
| `tests/inbound.test.js` | Email payload normalisation (SendGrid/Mailgun/Postmark shapes), token extraction, sender→reporter ingest. |
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

- **Relative paths in `public/`** — hosted serves under `/nodes/progress/app/`.
  An absolute `/api/…` or `/app.js` hits the tracker and 404s (the "only nav, no
  content" bug).
- **Don't hand-write nav** — the runtime injects `/nodes/chrome.js`.
- **Bump the runtime** — pinned by git tag in `package.json`; after a tag move,
  on the box `rm -rf node_modules/@developai && npm install && pm2 restart progress-hosted`.

## Deploy

- Code change to this Node, on the box:
  `cd /home/ubuntu/node-progress && git pull && rm -rf node_modules/@developai && npm install && pm2 restart progress-hosted`
- First-time host: `cd /home/ubuntu/nodes && bash deploy-node.sh progress <port>`
  then paste the Caddy block + `sudo systemctl restart caddy`.

## Performance connectors

Pull post performance automatically instead of typing it. The framework
(`lib/connectors/`) is pluggable: a connector module exports `id`, `label`,
`channel`, `configFields`, `validate`, and `sync({config, entries, fetchImpl})`,
and is added to the `REGISTRY` in `index.js`. Two deliberate storage choices:

- **Config + pulled metrics live in `host.store`**, not the `metrics` table. The
  lite engine can't `UPDATE`/selectively `DELETE`, so re-syncing the same post
  would duplicate rows; a keyed `store.put()` (collection `auto_metrics`, key
  `${id}:${postKey}`) is idempotent. `handlers.loadAll` merges these with the
  hand-entered rows, so `report.js` is unchanged.
- **Secrets never leave the server** — `describeConnectors` masks secret fields
  to `"********"`; a blank/masked secret on save keeps the stored token.

Attribution: a connector tags each metric with a `reporter_name` by matching the
platform post to a logged entry (FB permalink ↔ a facebook entry's URL). Posts
matching no entry are counted in `last_sync` but not stored — so reporters who
log their post links get auto-metrics for free.

**Facebook** (`facebook.js`): needs a long-lived Page access token
(`read_insights` + `pages_read_engagement`) + Page ID, pasted in the Connectors
panel. Sync is manual ("Sync now") for now.

## Email intake (reporters self-report by email)

Same parse+save pipeline as the submit link, new front door. `POST /inbound/email`
is **ungated** (mounted outside `/api`, like `/submit/*`) because a mail service
calls it — so it's protected two ways: (1) a shared `INBOUND_EMAIL_SECRET` the
caller must present (header `x-grounded-inbound-secret`, `?k=`, or a `secret`
field) — **if that env var is unset the endpoint is OFF (503)**; (2) a per-newsroom
token in the recipient address (`reports+<token>@<domain>`, same
`base64url("<newsroom_id>:<secret>")` scheme as submit links) whose secret must
match the one stored in `host.store` collection `inbound` — this scopes the hosted
pg host (`req.user = { id: newsroomId }`) AND stops cross-newsroom spoofing. Then
the sender is matched to a reporter by their roster `email`; unknown senders are
rejected (200, `unknown_sender`, nothing saved). `normalizeInbound` accepts the
common provider payloads (SendGrid/Mailgun/Postmark) or an explicit `token` field
(for a Cloudflare Worker we control). Env: `INBOUND_EMAIL_SECRET` (enables it) +
`INBOUND_EMAIL_DOMAIN` (display only). The actual mail-route/DNS wiring is ops, not
in this repo — `GET /api/inbound` gives the dashboard the address + reporter
email-coverage to show.

## Time periods (editor views)

`buildAllPeriods` computes the dashboard for every `PERIODS` key in one response;
the front-end holds them all and switches instantly (the runtime's GET `wrap`
passes `req.body` not `req.query`, so a `?period=` wouldn't arrive anyway). Windows
are calendar-based off a UTC `now`: today / this-week (Mon) / this-month / this-year
/ all. A daily target scales to the period (`daily_target × days-elapsed`). Per-
reporter drill-down is the period `feed` filtered client-side by name. The timeline
auto-switches to monthly bars for year/all.

## Next

- Inbound WhatsApp → `/inbound/email`-style bridge (Twilio/Meta webhook) — the
  email path is the template.
- Wire a real mail route to `POST /inbound/email` (provider + MX/Worker) and a
  real Meta token to the Facebook connector — both are "built, awaiting creds".
- **Scheduled** connector sync (today it's manual "Sync now"). Local: a simple
  interval in `index.js`. Hosted multi-tenant: a cron that iterates newsrooms
  with an enabled connector.
- More connectors: TikTok (business API), website (GA4). Each is one module in
  `lib/connectors/` added to the registry.
