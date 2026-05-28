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
4. *(future)* an inbound WhatsApp/email webhook POSTing to the same parser,
   so reporters' messages flow in with zero clicks.

The dashboard then shows each reporter's output this week by channel,
against an optional daily target (on-track / behind), plus a team timeline,
an activity feed, and an AI "accountability brief" (on track / falling
behind / what's landing / do this week).

**Performance** (reach, engagement, rate) is recorded per post. v1 is
**manual entry**; the metrics table and the dashboard are shaped so a
pluggable connector layer — storing per-platform login details and pulling
numbers from Facebook/TikTok/etc. APIs — drops in later without reshaping
the data.

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
GET  /api/report      the manager dashboard model
GET  /api/activity    activity log
POST /api/brief       AI accountability brief
```

Write routes (mounted via mountRoutes / index.js):
```
POST /api/reporters     add a reporter to the roster (gated)
POST /api/entries       log one piece of output by hand (gated)
POST /api/daily-report  AI-parse a free-text daily report → entries (gated)
POST /api/metrics       record a post's real-world performance (gated)
GET  /submit/whoami     validate a reporter's submit link → their name (UNGATED, token)
POST /submit/ingest     reporter self-submits their day → AI parse → entries (UNGATED, token)
```

## Trajectory

- **v0.1 (now):** roster + multi-channel output logging + AI daily-report
  parsing + manual performance + dashboard + AI brief. Local and hosted.
- **Next:** inbound WhatsApp/email → `/api/daily-report` bridge so reporters
  submit directly; a connector layer (stored platform credentials) to pull
  performance automatically instead of by hand.

## Links

- README for the newsroom: [`README.md`](./README.md)
- System map: `pauldevelopai/nodes` → `HANDOVER.md`, `ADD_A_NODE.md`
- Runtime: `pauldevelopai/grounded-node-runtime`
