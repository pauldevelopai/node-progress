/**
 * lib/handlers.js — the standard /api/* surface, auto-mounted by the runtime
 * (createServer locally, createHostedServer online). Each takes the host facade
 * (+ a request-like object) and returns a plain object (the JSON response).
 *
 *   GET  /api/setup     → getSetupStatus
 *   POST /api/setup     → postSetup        (laptop only; server manages the key online)
 *   GET  /api/report    → getReport        (the manager accountability dashboard)
 *   GET  /api/activity  → getActivity      (everything this Node has done)
 *   POST /api/brief     → postBrief        (AI editor's accountability brief)
 *
 * The reporter / entry / metric write routes are non-standard, so they're mounted
 * separately (lib/routes.js). Everything talks only to the host interface, so the
 * same code runs on a laptop (JSON files) and online (per-newsroom Postgres).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { listReporters, listEntries, listMetrics } from "./store.js";
import { listAutoMetrics } from "./connectors/index.js";
import { buildDashboard, buildAllPeriods } from "./report.js";

const PRODUCT = "Progress Tracker";
const ENV_PATH = ".env";
const HOSTED = () => !!process.env.GROUNDED_HOSTED;

// ── Local API-key setup (laptop only) ────────────────────────────────────────
function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
function writeEnvFile(updates) {
  const merged = { ...readEnvFile(), ...updates };
  const order = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_PROVIDER", "MODEL", "OPENAI_BASE_URL", "NEWSROOM", "PORT"];
  const lines = [
    "# Saved by the in-app setup screen. Update through the app, not by editing this.",
    "# Keep this file private — it contains your API key. (Already in .gitignore.)",
    "",
  ];
  for (const k of order) if (merged[k] !== undefined && merged[k] !== "") lines.push(`${k}=${merged[k]}`);
  for (const k of Object.keys(merged)) if (!order.includes(k) && merged[k]) lines.push(`${k}=${merged[k]}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  for (const [k, v] of Object.entries(updates)) { if (v) process.env[k] = v; else delete process.env[k]; }
}

/** GET — has an API key been configured? (Hosted: the server manages it.) */
export async function getSetupStatus(host) {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase();
  let activeProvider = null;
  if (explicit === "anthropic" || explicit === "openai") activeProvider = explicit;
  else if (hasAnthropic) activeProvider = "anthropic";
  else if (hasOpenAI) activeProvider = "openai";
  return {
    configured: HOSTED() ? true : !!activeProvider,
    serverManaged: HOSTED(),
    activeProvider: activeProvider || (HOSTED() ? "anthropic" : null),
    hasAnthropicKey: hasAnthropic,
    hasOpenAIKey: hasOpenAI,
    productName: PRODUCT,
    newsroom: host?.meta?.newsroom || null,
  };
}

/** Live-validate a key against the provider's /v1/models (zero-cost, caching-immune). */
async function validateKey(provider, key) {
  try {
    const res = provider === "anthropic"
      ? await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
      : await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true };
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, network: true, error: e.message };
  }
}

/** POST — validate + save provider + key to .env (laptop only). */
export async function postSetup(host, body) {
  if (HOSTED()) {
    return { ok: false, serverManaged: true, message: "When run online the AI key is managed by the server — nothing to set here." };
  }
  const { provider, apiKey } = body || {};
  // Reset path (remove the saved key) — backend support; safe no-op if unused.
  if (provider === null && apiKey === null) {
    writeEnvFile({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", AI_PROVIDER: "" });
    return { ok: true, reset: true };
  }
  if (!["anthropic", "openai"].includes(provider)) return { ok: false, message: "Pick Anthropic or OpenAI." };
  const key = (apiKey || "").trim();
  if (key.length < 10) return { ok: false, message: "Paste your API key into the key box." };
  if (provider === "anthropic" && !/^sk-ant-/.test(key)) return { ok: false, message: 'That doesn’t look like an Anthropic key — it should start with "sk-ant-".' };
  if (provider === "openai" && !/^sk-/.test(key)) return { ok: false, message: 'That doesn’t look like an OpenAI key — it should start with "sk-".' };

  // Reject a bad key before saving, so a typo doesn't silently 401 later.
  const v = await validateKey(provider, key);
  if (v.rejected) {
    return { ok: false, message: `That key was rejected by ${provider === "anthropic" ? "Anthropic" : "OpenAI"}. Check you copied the whole key.` };
  }

  const updates = { AI_PROVIDER: provider };
  if (provider === "anthropic") updates.ANTHROPIC_API_KEY = key; else updates.OPENAI_API_KEY = key;
  writeEnvFile(updates);
  await host.log.run({ op: "setup", provider, success: true, verified: !!v.ok });
  return {
    ok: true,
    provider,
    verified: !!v.ok,
    warning: v.network ? "Saved — but we couldn’t reach the provider to confirm it (no internet?). It’ll be used when you run something." : null,
  };
}

// ── The dashboard ─────────────────────────────────────────────────────────────

async function loadAll(host) {
  // Hand-entered metric rows + numbers pulled by performance connectors are
  // merged into one list; report.js folds them identically (matched by reporter).
  const [reporters, entries, manualMetrics, autoMetrics] = await Promise.all([
    listReporters(host), listEntries(host), listMetrics(host), listAutoMetrics(host),
  ]);
  return { reporters, entries, metrics: [...manualMetrics, ...autoMetrics] };
}

/** GET — the manager accountability dashboard, computed for every period at once. */
export async function getReport(host) {
  return buildAllPeriods(await loadAll(host), new Date(), host?.ctx?.newsroomId || "local");
}

/** GET — full activity log (every add, parse, brief, error). */
export async function getActivity(host) {
  const t = `${host.tablePrefix}activity`;
  const res = await host.db
    .query(t, `SELECT * FROM ${t} WHERE newsroom_id = $1 ORDER BY n`)
    .catch(() => ({ rows: [] }));
  return { activity: res.rows || [] };
}

// ── AI accountability brief ─────────────────────────────────────────────────

/** POST — an editor's brief: who's on track, who's behind, standout posts. */
export async function postBrief(host) {
  const startedAt = Date.now();
  const d = buildDashboard(await loadAll(host), new Date(), host?.ctx?.newsroomId || "local", "week");
  if (d.empty) throw new Error("Nothing to brief on yet — add reporters and log some output first.");

  // Ground the brief in the shared cross-node newsroom profile (host.profile,
  // runtime >= v0.14.0): location/audience/about so the editor's brief fits this
  // newsroom's real beat and readership, not generic advice.
  const p = host.profile ? await host.profile.get() : null;
  const newsroomContext = p && (p.country || p.audience || p.about)
    ? `NEWSROOM CONTEXT:\n` +
      (p.country ? `- Country/region: ${p.country}\n` : "") +
      (p.audience ? `- Audience: ${p.audience}\n` : "") +
      (p.about ? `- About: ${p.about}\n` : "") +
      `\n`
    : "";

  const roster = d.reporters
    .map((r) => {
      const tgt = r.periodTarget != null ? ` (target ~${r.periodTarget} this week, ${r.periodItems} so far → ${r.targetStatus})` : "";
      const ch = Object.entries(r.byChannel).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "no output";
      const perf = r.posts ? `; ${r.posts} tracked posts, reach ${r.reach}, eng-rate ${r.engagementRate ?? "—"}%` : "";
      return `- ${r.name}${r.onRoster ? "" : " (not on roster)"}: ${r.periodItems} items this week${tgt}; channels: ${ch}; last active ${r.lastActive || "never"}${perf}`;
    })
    .join("\n");

  const standouts = d.standouts.slice(0, 5)
    .map((s) => `- "${s.title}" by ${s.reporter_name} (${s.channel}): reach ${s.reach}, engagement ${s.engagement}, rate ${s.rate}%`)
    .join("\n") || "(no performance numbers entered yet)";

  const ctx =
    `WINDOW: this week starts ${d.windowStart}, today is ${d.today}.\n` +
    `TOTALS: ${d.topline.reporters} reporters, ${d.topline.activeThisPeriod} active this week, ` +
    `${d.topline.itemsToday} items today, ${d.topline.itemsThisPeriod} this week.\n` +
    `CHANNEL MIX (this period): ${Object.entries(d.channelTotals).map(([k, n]) => `${k} ${n}`).join(", ")}.\n\n` +
    `BY REPORTER:\n${roster}\n\nSTANDOUT POSTS BY ENGAGEMENT:\n${standouts}`;

  const prompt =
    `You are briefing the editor/newsroom manager who uses this dashboard to hold reporters accountable to their output targets across Facebook, the website, TikTok and WhatsApp.\n\n${newsroomContext}${ctx}\n\n` +
    `Write a decisive, fair brief. Exact section headers, each prefixed "## ":\n` +
    `## On track\n## Falling behind\n## What's landing\n## Do this week\n\n` +
    `2-4 tight sentences or "- " bullets per section. Name specific reporters and channels from the data. ` +
    `"What's landing" = patterns in the standout posts (which reporters/channels actually perform, not just volume). ` +
    `Be direct but constructive — this drives a real management conversation. No preamble. Under 320 words.`;

  const { text, usedFallback, provider, model } = await host.ai.chat(prompt, { maxTokens: 1000 });
  await host.log.run({
    op: "brief", provider, model,
    duration_ms: Date.now() - startedAt, used_fallback: !!usedFallback,
    prompt, response: text, success: true,
  });
  return { brief: text, usedFallback: !!usedFallback };
}
