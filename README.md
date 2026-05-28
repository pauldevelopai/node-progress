# Progress Tracker

**A single accountability dashboard for a newsroom manager** — see what every
reporter is publishing across Facebook, the website, TikTok and WhatsApp, track
each person against their target, and pair it with how those posts performed.
No monthly analytics subscription; the newsroom owns it.

A Node on [GROUNDED](https://grounded.developai.co.za) by Develop AI. It runs on
your own computer (your data and AI key stay on your machine) and also online.

---

## Run it on your computer (one line)

You don't need to install anything by hand — no git, no VS Code, no admin
password. Open your computer's built-in terminal and paste:

**macOS** (open the **Terminal** app):
```bash
curl -fsSL https://grounded.developai.co.za/nodes/progress-tracker/mac | bash
```

**Windows** (open **PowerShell**):
```powershell
irm https://grounded.developai.co.za/nodes/progress-tracker/windows | iex
```

It downloads the app, starts it, and opens the dashboard at
`http://localhost:3000`. Paste the same line another day to relaunch on the
latest version — your roster and data are always kept.

## First-run setup

The app asks for **one** AI key (Anthropic *or* OpenAI). It's used to read the
free-text daily reports your reporters send in and to write the accountability
brief. The key is saved to a private `.env` file on your computer and is never
uploaded.

## Using it

1. **Add reporters** — build your roster. Give each an optional daily target.
2. **Capture output** — either:
   - **Log output** for a single item, or
   - **Paste daily report**: drop in the WhatsApp/email message a reporter sent
     at the end of the day. AI turns it into entries; review and save.
3. **Add performance** — type in a post's reach/engagement when you have it.
4. Watch the **Team** view (this week vs. target by channel), the **Activity
   feed**, **Performance**, the 14-day **Timeline**, and generate the **AI
   Brief** for a who's-on-track / who's-behind / what's-landing summary.

## Your data stays yours

Everything you enter lives in `data/processed/` on your own machine and is never
committed or uploaded. The app sends Develop AI only anonymous usage counts (how
many reporters / entries / briefs) so we can see it's being used — never reporter
names, story titles, links, or report text. Turn even that off with
`GROUNDED_TELEMETRY=off` in your `.env`.

## Update / stop

- **Update:** double-click `Update.command` (Mac) or `Update.bat` (Windows), or
  just re-paste the install line.
- **Stop:** press `Ctrl+C` in the terminal window, or close it.

## For developers

```bash
npm install
npm start            # local (lite host, JSON files) → http://localhost:3000
npm run start:hosted # online (multi-tenant Postgres) — needs JWT_SECRET, DATABASE_URL, ANTHROPIC_API_KEY
```

Architecture and the host interface: see [`NODE.md`](./NODE.md), [`CLAUDE.md`](./CLAUDE.md),
and `pauldevelopai/nodes` → `HANDOVER.md`.
