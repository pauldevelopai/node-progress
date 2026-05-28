# Progress Tracker — handoff / where we are

_Last updated: 2026-05-28. Pick this up to continue._

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
- **Getting output in — three ways today:**
  1. **Reporter self-serve link** (no login): each reporter has a `submit_token`; their
     link is `submit.html?t=base64url("<newsroom_id>:<secret>")`. Manager copies it from
     the reporter card ("Copy submit link") and sends it. Reporter pastes their day →
     `host.ai` parses → entries. Routes `GET /submit/whoami` + `POST /submit/ingest` live
     OUTSIDE `/api` (so the login gate doesn't bounce reporters).
  2. **Log output** — manager enters one item by hand.
  3. **Paste daily report** — manager pastes a message they received; AI parses it.
- **AI brief:** who's on track / falling behind / what's landing / do this week.
- **Performance:** entered by hand for now (`Add performance`).

## Verified
- Local end-to-end smoke test (add reporter → entry → metric → `/api/report` aggregation).
- Submit-link flow locally (token decode, scoping, reporter match, ungated route).
- Live on the box: `/app/` 302→login, `/api/*` 401, `submit.html` 200, `/submit/*` ungated,
  bad tokens 400, `submit_token` column present in Postgres.

## NOT done yet — next session
1. **Live-test the AI parse** (needs login + spends a few cents; only Paul can):
   sign in → add a reporter → **Copy submit link** → open it incognito → submit a real
   message (e.g. "posted 2 FB updates on the budget, filed a website story, made a TikTok")
   → confirm it parses and appears on the dashboard.
2. **Automatic performance metrics** — currently manual. The `metrics` table + dashboard
   are shaped for a pluggable connector (store platform logins → pull from FB/TikTok APIs).
3. **Inbound WhatsApp/email → the parser** — the "reporters WhatsApp their stats directly"
   vision; would POST to the same parse path. Needs a provider (Twilio/Meta or an
   inbound-email service) + a public webhook + phone/email → reporter mapping.
4. **Rotate the Lightsail SSH key** (it was pasted into a chat 2026-05-28 → exposed).

## Deploy mechanics (differ from nodes/HANDOVER.md)
- `deploy-node.sh` is in **`/var/www/nodes`** (not `/home/ubuntu/nodes`).
- Update this Node on the box: `cd /home/ubuntu/node-progress-tracker && git pull --ff-only && pm2 restart progress-tracker-hosted` (restart re-runs `ensureSchema` and reloads `index.html`/`submit.html`).
- Caddy file `/etc/caddy/sites/ailegal.co.za.caddy` uses explicit per-node `@matchers`
  (mirror the verifier block); validate with `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, then `sudo systemctl restart caddy` (admin off → restart, not reload).
