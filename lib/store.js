/**
 * lib/store.js — data access for Progress Tracker, against the host interface.
 *
 * Every function here speaks only `host.db` (never fs / pg / express), so the
 * SAME code runs on a laptop (the runtime's JSON "SQL" engine) and online
 * (per-newsroom Postgres). To stay inside what the lite engine understands:
 *
 *   • INSERT lists `newsroom_id` FIRST, then params $2..$N in column order.
 *     ($1 = newsroom_id is bound by the host; callers pass only the rest.)
 *   • Reads are plain `SELECT * ... WHERE newsroom_id = $1` — no JOINs, no
 *     GROUP BY. All shaping/aggregation happens in JS (lib/report.js).
 *
 * `id` and `ingested_at` are filled by the store (bigserial / DEFAULT now()
 * online; stamped by the lite host locally) — never inserted here.
 */

import { randomBytes } from "node:crypto";

const REPORTERS = "node_progress_reporters";
const ENTRIES   = "node_progress_entries";
const METRICS   = "node_progress_metrics";

export const CHANNELS = ["facebook", "website", "tiktok", "whatsapp", "other"];

// ── Self-serve submit links ──────────────────────────────────────────────────
// Each reporter gets a random secret at creation. The shareable link carries an
// opaque token = base64url("<newsroom_id>:<secret>"). The submit route decodes it
// to learn which newsroom to scope to (no login), then matches the reporter by
// secret. The newsroom_id isn't sensitive; the random secret is what authorises.
export function newSubmitToken() {
  return randomBytes(18).toString("base64url");
}
export function encodeSubmitToken(newsroomId, secret) {
  if (!secret) return null;
  return Buffer.from(`${newsroomId}:${secret}`).toString("base64url");
}
export function decodeSubmitToken(token) {
  try {
    const s = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const i = s.indexOf(":");
    if (i < 1) return null;
    return { newsroomId: s.slice(0, i), secret: s.slice(i + 1) };
  } catch { return null; }
}
export async function findReporterByToken(host, secret) {
  if (!secret) return null;
  const rs = await listReporters(host);
  return rs.find((r) => r.submit_token && r.submit_token === secret) || null;
}

/** Match an inbound email's sender to a reporter by their roster email. */
export async function findReporterByEmail(host, email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return null;
  const rs = await listReporters(host);
  return rs.find((r) => (r.email || "").trim().toLowerCase() === want) || null;
}

// ── Inbound email intake ─────────────────────────────────────────────────────
// The newsroom gets ONE inbound address; reporters email their day to it. The
// address carries the same kind of opaque token as a submit link
// (base64url("<newsroom_id>:<secret>")) so the ungated webhook can scope itself
// to the right newsroom and reject spoofed tokens. The secret is generated once
// per newsroom and kept in host.store (works lite + hosted).
export async function getInboundConfig(host) {
  let cfg = await host.store.get("inbound", "email").catch(() => null);
  if (!cfg || !cfg.secret) {
    cfg = { secret: newSubmitToken() };
    await host.store.put("inbound", "email", cfg);
  }
  return cfg;
}

/** Stable per-reporter key from a display name (so daily reports match the roster). */
export function reporterKey(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Map any free-text channel word to one of our canonical channels. */
export function normChannel(s) {
  const v = String(s || "").toLowerCase().trim();
  if (/face|fb\b/.test(v)) return "facebook";
  if (/tik|tok/.test(v)) return "tiktok";
  if (/whats|wa\b/.test(v)) return "whatsapp";
  if (/web|site|article|story|online|cms/.test(v)) return "website";
  return CHANNELS.includes(v) ? v : "other";
}

const nn = (v) => (v === undefined ? null : v); // undefined → null (lite & pg safe)
const today = () => new Date().toISOString().slice(0, 10);

// ── Reporters ────────────────────────────────────────────────────────────────

export async function listReporters(host) {
  const res = await host.db.query(
    REPORTERS, `SELECT * FROM ${REPORTERS} WHERE newsroom_id = $1`
  ).catch(() => ({ rows: [] }));
  return res.rows || [];
}

export async function addReporter(host, { name, email, whatsapp, beat, daily_target } = {}) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("A reporter needs a name.");
  const key = reporterKey(clean);

  // One row per reporter_key — adding the same name again updates nothing here
  // (kept simple); the roster is small and managed by hand.
  const existing = (await listReporters(host)).find((r) => r.reporter_key === key);
  if (existing) return { ok: true, reporter: existing, existed: true };

  const target = daily_target === "" || daily_target == null ? null : parseInt(daily_target, 10);
  const submit_token = newSubmitToken();
  await host.db.query(
    REPORTERS,
    `INSERT INTO ${REPORTERS}
       (newsroom_id, reporter_key, name, email, whatsapp, beat, daily_target, active, submit_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [key, clean, nn(email), nn(whatsapp), nn(beat), Number.isFinite(target) ? target : null, true, submit_token]
  );
  return { ok: true, reporter: { reporter_key: key, name: clean, submit_token }, existed: false };
}

// ── Entries (a piece of output a reporter logged) ─────────────────────────────

export async function listEntries(host) {
  const res = await host.db.query(
    ENTRIES, `SELECT * FROM ${ENTRIES} WHERE newsroom_id = $1`
  ).catch(() => ({ rows: [] }));
  return res.rows || [];
}

/** Normalise one item into the entry column shape (used by manual + parsed paths). */
function entryFields(item = {}, fallback = {}) {
  const name = String(item.reporter_name || fallback.reporter_name || "").trim();
  return {
    reporter_key: name ? reporterKey(name) : null,
    reporter_name: name || null,
    entry_date: String(item.entry_date || fallback.entry_date || today()).slice(0, 10),
    channel: normChannel(item.channel),
    item_type: nn(item.item_type) || "post",
    title: nn(item.title),
    url: nn(item.url),
    qty: Number.isFinite(parseInt(item.qty, 10)) ? parseInt(item.qty, 10) : 1,
    notes: nn(item.notes),
    source: nn(item.source || fallback.source) || "manual",
    raw_text: nn(item.raw_text || fallback.raw_text),
  };
}

async function insertEntry(q, f) {
  await q(
    ENTRIES,
    `INSERT INTO ${ENTRIES}
       (newsroom_id, reporter_key, reporter_name, entry_date, channel, item_type,
        title, url, qty, notes, source, raw_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [f.reporter_key, f.reporter_name, f.entry_date, f.channel, f.item_type,
     f.title, f.url, f.qty, f.notes, f.source, f.raw_text]
  );
}

/** Add a single manually-logged entry. */
export async function addEntry(host, body = {}) {
  const f = entryFields(body);
  if (!f.reporter_name) throw new Error("Pick which reporter this is for.");
  await insertEntry((t, s, p) => host.db.query(t, s, p), f);
  return { ok: true, entry: f };
}

/** Add many entries at once (the parsed-daily-report path). */
export async function addEntries(host, items, fallback = {}) {
  const list = (Array.isArray(items) ? items : []).map((it) => entryFields(it, fallback));
  const usable = list.filter((f) => f.reporter_name);
  if (!usable.length) return { ok: true, added: 0, entries: [] };
  await host.db.tx(async (scoped) => {
    for (const f of usable) await insertEntry(scoped.query, f);
  });
  return { ok: true, added: usable.length, entries: usable };
}

// ── Metrics (real-world post performance, entered by hand for now) ────────────

export async function listMetrics(host) {
  const res = await host.db.query(
    METRICS, `SELECT * FROM ${METRICS} WHERE newsroom_id = $1`
  ).catch(() => ({ rows: [] }));
  return res.rows || [];
}

export async function addMetric(host, body = {}) {
  const name = String(body.reporter_name || "").trim();
  if (!name) throw new Error("Pick which reporter this post belongs to.");
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const f = {
    reporter_name: name,
    channel: normChannel(body.channel),
    post_url: nn(body.post_url),
    post_title: nn(body.post_title),
    reach: num(body.reach),
    engagement: num(body.engagement),
    likes: num(body.likes),
    comments: num(body.comments),
    shares: num(body.shares),
    views: num(body.views),
    measured_on: String(body.measured_on || today()).slice(0, 10),
    source: nn(body.source) || "manual",
  };
  await host.db.query(
    METRICS,
    `INSERT INTO ${METRICS}
       (newsroom_id, reporter_name, channel, post_url, post_title, reach, engagement,
        likes, comments, shares, views, measured_on, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [f.reporter_name, f.channel, f.post_url, f.post_title, f.reach, f.engagement,
     f.likes, f.comments, f.shares, f.views, f.measured_on, f.source]
  );
  return { ok: true, metric: f };
}
