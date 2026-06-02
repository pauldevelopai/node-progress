# NODE.md — Progress Tracker

This card identifies this repo as a Node in the GROUNDED ecosystem.
The full system architecture lives elsewhere; this file just locates
this Node within it.

## Identity

| | |
|---|---|
| **Slug** | `progress-tracker` |
| **Display name** | Progress Tracker |
| **Current version** | 0.1.0 |
| **Status** | build |
| **Born** | 2026-05-28 |
| **Repo** | `pauldevelopai/node-progress-tracker` (public) |
| **Storage pattern** | Postgres tables (`ensureSchema`) — relational reporters / entries / metrics |
| **Runtime** | `@developai/grounded-node-runtime#v0.10.0` |

## What this Node does

A single accountability view for a newsroom manager: **who is publishing
what, where, and how often**, and how that work performs.

Reporters' multi-channel output (Facebook, the website, TikTok, WhatsApp
channel) lands here several ways:

1. **Reporter self-submit link** — each reporter gets a personal link
   (`submit.html?t=<token>`, no login) to a phone-friendly page where they
   paste their day's work; `host.ai` parses it into entries against their
   name. The token is `base64url("<newsroom_id>:<secret>")`; the submit
   routes live OUTSIDE `/api` so the tracker-login gate doesn't bounce them.
2. **Logged by hand** — the manager records an item against a reporter.
3. **Pasted daily report** — the manager pastes the WhatsApp/email message
   a reporter sent; `host.ai` turns the prose into structured entries to
   review and save.
4. **Email** — reporters email their day to the newsroom's inbound address; the
   ungated `/inbound/email` webhook matches the sender to a reporter and parses
   the message into entries with zero clicks for the editor. Provider-agnostic
   (`lib/inbound.js`); the mail-route/DNS wiring is ops. WhatsApp can reuse the
   same path later.

The dashboard shows each reporter's output for the selected period — **Today /
This week / This month / This year / All time** (instant switch) — by channel,
against a period-scaled daily target (on-track / behind), with a per-reporter
drill-down, a team timeline (daily, or monthly for long periods), an activity
feed, and an AI "accountability brief" (on track / falling behind / what's
landing / do this week).

**Performance** (reach, engagement, rate) is recorded per post, two ways:
**manual entry**, or pulled automatically by a **performance connector**
(`lib/connectors/`). The first connector is **Facebook Page Insights** — paste
a long-lived Page token + Page ID, hit "Sync now", and it pulls recent posts'
numbers and attributes each to the reporter who logged that post's link. The
framework is pluggable (one module per platform); config + pulled metrics live
in `host.store` (idempotent re-sync), merged with manual rows at read time.

## How this Node fits into GROUNDED

A standalone Node built on the shared `grounded-node-runtime`. It runs two
ways from one codebase:

- **Local** (`index.js` → `createServer` + lite host): a newsroom installs
  it with one command; reporters/entries/metrics live in JSON files under
  `data/processed/`, the AI key is the newsroom's own.
- **Hosted** (`server-hosted.js` → `createHostedServer`): online,
  multi-tenant behind the Grounded login; storage is per-newsroom Postgres,
  the AI key is server-managed.

Handlers target only the host interface, so the two boots share all logic.
All aggregation happens in JS (`lib/report.js`) because the lite host's JSON
"SQL" engine only does per-newsroom selects — keep reads simple and shape in
JS.

## API surface

Auto-mounted by the runtime (standard names):
```
GET  /api/setup       configured? (server-managed online)
POST /api/setup       save AI key (laptop only)
GET  /api/report      the manager dashboard model (all time-periods at once)
GET  /api/activity    activity log
POST /api/brief       AI accountability brief
```

Write routes (mounted via mountRoutes / index.js):
```
POST /api/reporters     add a reporter to the roster (gated)
POST /api/entries       log one piece of output by hand (gated)
POST /api/daily-report  AI-parse a free-text daily report → entries (gated)
POST /api/metrics       record a post's real-world performance by hand (gated)
GET  /api/connectors            list performance connectors + status (gated)
POST /api/connectors/:id/config save a connector's settings (gated, secret-masked)
POST /api/connectors/:id/sync   pull metrics now → attribute → store (gated)
GET  /api/inbound               the newsroom's email-intake address + reporter coverage (gated)
GET  /submit/whoami     validate a reporter's submit link → their name (UNGATED, token)
POST /submit/ingest     reporter self-submits their day → AI parse → entries (UNGATED, token)
POST /inbound/email     mail service posts a reporter's email → match sender → parse → entries (UNGATED, shared secret + newsroom token)
```

## Trajectory

- **v0.1 (now):** roster + multi-channel output logging + AI daily-report
  parsing + **email self-report** + manual performance + **performance
  connectors (Facebook)** + **Today/Week/Month/Year editor views** + dashboard +
  AI brief. Local and hosted.
- **Next (awaiting creds/ops):** wire a real mail route to `/inbound/email`;
  live-test the Facebook connector against a real Meta token; scheduled (not just
  manual) connector sync; more connectors (TikTok, GA4); WhatsApp via the same
  inbound path.

## Links

- README for the newsroom: [`README.md`](./README.md)
- System map: `pauldevelopai/nodes` → `HANDOVER.md`, `ADD_A_NODE.md`
- Runtime: `pauldevelopai/grounded-node-runtime`
