# Progress Tracker — handoff / where we are

_Last updated: 2026-06-02. Pick this up to continue._

## What it is
A GROUNDED Node: a newsroom-manager accountability dashboard — what every reporter
publishes across **Facebook / website / TikTok / WhatsApp**, against their targets,
plus how those posts perform. No monthly analytics subscription; the newsroom owns it.

## Status: LIVE ✅
- **Hosted:** https://grounded.developai.co.za/nodes/progress-tracker/app/ (behind the Grounded login)
- pm2 process `progress-tracker-hosted` on **port 3005**; Caddy routes `/nodes/progress-tracker/app/*` → it.
- Front-door card live; install links (`/mac`, `/windows`) work.
- Repo: `pauldevelopai/node-progress-tracker`. Runtime pinned `#v0.10.0`.

## What's built (and shipped to `main` + the box)
- **Data:** `node_progress_tracker_{reporters,entries,metrics}` (relational, `ensureSchema`).
  Reads are simple per-newsroom SELECTs; **all aggregation is in JS** (`lib/report.js`)
  so the same code runs on a laptop (lite JSON host) and online (Postgres).
- **Dashboard** (`public/`): light theme matching Election Watch + the Grounded nav.
  Topline, Team cards (this-week vs target, by-channel), Activity feed, Performance,
  14-day Timeline, AI accountability brief.
- **Getting output in — four ways:** reporter self-serve link, manager log-by-hand,
  manager paste-daily-report, AND reporters emailing their day (see below). All four
  feed one `parseDailyReport`→`addEntries` pipeline.
  1. **Reporter self-serve link** (no login): each reporter has a `submit_token`; their
     link is `submit.html?t=base64url("<newsroom_id>:<secret>")`. Manager copies it from
     the reporter card ("Copy submit link") and sends it. Reporter pastes their day →
     `host.ai` parses → entries. Routes `GET /submit/whoami` + `POST /submit/ingest` live
     OUTSIDE `/api` (so the login gate doesn't bounce reporters).
  2. **Log output** — manager enters one item by hand.
  3. **Paste daily report** — manager pastes a message they received; AI parses it.
- **AI brief:** who's on track / falling behind / what's landing / do this week.
- **Performance — two ways:** entered by hand (`Add performance`), OR pulled
  automatically by a **performance connector** (`Connectors` panel). NEW 2026-06-02.

### Email self-report + editor time-views (NEW — 2026-06-02)
- **Reporters self-report by email.** `POST /inbound/email` (ungated, outside `/api`)
  takes reporter emails from any mail service (provider-agnostic payload via
  `lib/inbound.js`). Protected by a shared `INBOUND_EMAIL_SECRET` (OFF/503 if unset)
  + a per-newsroom token in the address (`reports+<token>@<INBOUND_EMAIL_DOMAIN>`,
  same scheme as submit links). Sender matched to a reporter by roster `email`;
  feeds the SAME `parseDailyReport`→`addEntries` path (source `email`). `GET
  /api/inbound` gives the dashboard the address + email-coverage; new "Email intake"
  panel. **App-side done + tested; the real mail route/DNS is ops (not in repo).**
- **Editor time-views.** `getReport` now returns Today / This week / This month /
  This year / All time in one payload (`buildAllPeriods`); the dashboard has a period
  switcher (instant, no re-fetch) + a per-reporter drill-down (click a card). Daily
  targets scale to the period; the timeline goes monthly for year/all.
- Verified: `node --test tests/*.test.js` (19 pass) + live smoke — all 5 periods
  scope correctly, inbound webhook 401(no secret)/403(bad token)/unknown_sender, and
  a known sender reaches the AI (fake key → 401, proving the full pipeline).

### Performance connectors (NEW — 2026-06-02)
- **Pluggable framework** `lib/connectors/` (`index.js` registry + `runSync` +
  `listAutoMetrics` + `describeConnectors`; `facebook.js` is the first connector).
- **Facebook Page Insights:** manager pastes a long-lived Page access token
  (`read_insights` + `pages_read_engagement`) + Page ID → "Sync now" pulls recent
  posts' reach/reactions/comments/shares and attributes each to the reporter who
  logged that post's link (permalink ↔ entry URL). Unmatched posts are counted,
  not stored.
- **Storage choice:** connector config + pulled metrics live in `host.store`
  (collections `connectors` / `auto_metrics`), NOT the `metrics` table — keyed
  `put()` makes re-sync idempotent (the lite engine has no UPDATE). `loadAll`
  merges auto + manual metrics, so `report.js` is untouched.
- **Secrets:** never returned to the browser (masked `"********"`); a blank/masked
  token on save keeps the stored one.
- Routes: `GET /api/connectors`, `POST /api/connectors/:id/config`,
  `POST /api/connectors/:id/sync`.

## Verified
- Local end-to-end smoke test (add reporter → entry → metric → `/api/report` aggregation).
- Submit-link flow locally (token decode, scoping, reporter match, ungated route).
- **Connectors (2026-06-02):** `node --test tests/connectors.test.js` (6 pass:
  FB parse+match, idempotent re-sync, secret masking, masked-secret-keeps-token,
  validate, Graph-error handling). Local smoke run: config saved + token masked,
  `sync` against the real Graph with a fake token errors cleanly (no crash),
  a seeded auto-metric merges into `/api/report` (topline reach + standouts +
  reporter card). NOT yet run on the box / against a real token.
- Live on the box: `/app/` 302→login, `/api/*` 401, `submit.html` 200, `/submit/*` ungated,
  bad tokens 400, `submit_token` column present in Postgres.

## NOT done yet — next session
1. **Live-test the AI parse** (needs login + spends a few cents; only Paul can):
   sign in → add a reporter → **Copy submit link** → open it incognito → submit a real
   message (e.g. "posted 2 FB updates on the budget, filed a website story, made a TikTok")
   → confirm it parses and appears on the dashboard.
2. **Automatic performance metrics** — ✅ framework + Facebook connector shipped
   (2026-06-02). STILL TO DO: (a) **live-test against a real Meta token** — create a
   Meta app, get a long-lived Page token with `read_insights` + `pages_read_engagement`,
   paste it in the Connectors panel, Sync now, confirm real numbers land; (b) **scheduled
   sync** (currently manual "Sync now") — local interval + hosted multi-tenant cron;
   (c) **more connectors** (TikTok, GA4 website) — each is one module in `lib/connectors/`.
3. **Email self-report** — ✅ app-side built + tested (2026-06-02). STILL TO DO (ops):
   wire a real mail route to `POST /inbound/email` — pick a provider (SendGrid Inbound
   Parse / Mailgun Routes / Postmark / Cloudflare Email-Routing Worker), set
   `INBOUND_EMAIL_SECRET` + `INBOUND_EMAIL_DOMAIN` on the box, point MX/route at the
   webhook presenting the secret. Then **WhatsApp** can reuse the same path (Twilio/Meta
   webhook → POST /inbound/email-style).
4. **Rotate the Lightsail SSH key** (it was pasted into a chat 2026-05-28 → exposed).

## Deploy mechanics (differ from nodes/HANDOVER.md)
- `deploy-node.sh` is in **`/var/www/nodes`** (not `/home/ubuntu/nodes`).
- Update this Node on the box: `cd /home/ubuntu/node-progress-tracker && git pull --ff-only && pm2 restart progress-tracker-hosted` (restart re-runs `ensureSchema` and reloads `index.html`/`submit.html`).
- Caddy file `/etc/caddy/sites/ailegal.co.za.caddy` uses explicit per-node `@matchers`
  (mirror the verifier block); validate with `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, then `sudo systemctl restart caddy` (admin off → restart, not reload).
