/**
 * lib/report.js — turn the flat reporters/entries/metrics rows into the manager
 * accountability dashboard. Pure JS, no IO: the handlers load the rows via the
 * host and hand them here, so this runs identically on a laptop and online.
 *
 * Why aggregate here and not in SQL? The lite host's JSON engine only does
 * `WHERE newsroom_id = $1` — no GROUP BY, no JOIN. Doing it in JS keeps one code
 * path for both worlds (see lib/store.js).
 *
 * Time periods: the editor wants to see output for Today / This week / This
 * month / This year / All time. `buildAllPeriods` computes one dashboard per
 * period in a single pass-friendly call (getReport returns them all, so the
 * front-end switches instantly with no re-fetch). `buildDashboard` builds one
 * period (default "week", which keeps postBrief working as before).
 */

import { CHANNELS, reporterKey, encodeSubmitToken } from "./store.js";

const dayStr = (d) => d.toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const qtyOf = (e) => { const n = parseInt(e.qty, 10); return Number.isFinite(n) ? n : 1; };

// The selectable periods, in display order. `key` is what the client sends back.
export const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

function emptyChannels() {
  const o = {};
  for (const c of CHANNELS) o[c] = 0;
  return o;
}

/**
 * The window for a period as { start, days }: `start` is the inclusive first day
 * (YYYY-MM-DD, or null for all-time); `days` is how many days the window spans
 * up to today (used to scale a daily target into a period target).
 */
function periodWindow(key, now) {
  const todayStr = dayStr(now);
  if (key === "all") return { start: null, days: null, today: todayStr };
  if (key === "today") return { start: todayStr, days: 1, today: todayStr };
  if (key === "week") {
    const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
    return { start: dayStr(new Date(now.getTime() - dow * 86400000)), days: dow + 1, today: todayStr };
  }
  if (key === "month") {
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    return { start, days: now.getUTCDate(), today: todayStr };
  }
  // year
  const start = `${now.getUTCFullYear()}-01-01`;
  const startMs = Date.UTC(now.getUTCFullYear(), 0, 1);
  const days = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - startMs) / 86400000) + 1;
  return { start, days, today: todayStr };
}

const inWindow = (date, win) =>
  !!date && date <= win.today && (win.start === null || date >= win.start);

/** A timeline sized to the period: daily bars for short windows, monthly for long. */
function buildTimeline(key, entries, now) {
  const monthly = key === "year" || key === "all";
  if (monthly) {
    const bars = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      bars.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, items: 0 });
    }
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    for (const e of entries) {
      const m = String(e.entry_date || "").slice(0, 7);
      const i = idx.get(m);
      if (i !== undefined) bars[i].items += qtyOf(e);
    }
    return { granularity: "month", bars };
  }
  const span = key === "month" ? 30 : 14;
  const bars = [];
  for (let i = span - 1; i >= 0; i--) bars.push({ date: dayStr(new Date(now.getTime() - i * 86400000)), items: 0 });
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  for (const e of entries) {
    const i = idx.get(e.entry_date);
    if (i !== undefined) bars[i].items += qtyOf(e);
  }
  return { granularity: "day", bars };
}

/**
 * Build the dashboard model for ONE period.
 * @param period one of PERIODS[].key (default "week").
 */
export function buildDashboard({ reporters = [], entries = [], metrics = [] } = {}, now = new Date(), newsroomId = "local", period = "week") {
  const win = periodWindow(period, now);
  const todayStr = win.today;
  const periodLabel = (PERIODS.find((p) => p.key === period) || {}).label || period;
  const empty = !reporters.length && !entries.length && !metrics.length;

  // ── One bucket per reporter, seeded from the roster, then folded with output
  //    that falls inside the period window.
  const buckets = new Map();
  const bucket = (name, key) => {
    const k = key || reporterKey(name);
    if (!buckets.has(k)) {
      buckets.set(k, {
        reporter_key: k, name: name || k, beat: null, daily_target: null,
        active: true, onRoster: false, submit_token: null,
        items: 0, entryCount: 0, today: 0, periodItems: 0, allItems: 0, lastActive: null,
        byChannel: emptyChannels(), recent: [],
        reach: 0, engagement: 0, posts: 0, topPost: null,
      });
    }
    return buckets.get(k);
  };

  for (const r of reporters) {
    const b = bucket(r.name, r.reporter_key);
    b.name = r.name || b.name;
    b.beat = r.beat || null;
    b.daily_target = r.daily_target == null ? null : num(r.daily_target);
    b.active = r.active !== false;
    b.onRoster = true;
    b.submit_token = r.submit_token || null;
  }

  for (const e of entries) {
    const b = bucket(e.reporter_name, e.reporter_key);
    const q = qtyOf(e);
    const ch = CHANNELS.includes(e.channel) ? e.channel : "other";
    b.allItems += q;
    if (e.entry_date === todayStr) b.today += q;
    if (!b.lastActive || (e.entry_date && e.entry_date > b.lastActive)) b.lastActive = e.entry_date || b.lastActive;
    if (!inWindow(e.entry_date, win)) continue;   // everything below is period-scoped
    b.periodItems += q;
    b.entryCount += 1;
    b.byChannel[ch] += q;
    b.recent.push({
      entry_date: e.entry_date || null, channel: ch, item_type: e.item_type || "post",
      title: e.title || null, url: e.url || null, qty: q, source: e.source || "manual",
    });
  }

  // ── Fold in performance metrics measured within the period (matched by name).
  for (const m of metrics) {
    if (!inWindow(m.measured_on, win)) continue;
    const b = bucket(m.reporter_name, reporterKey(m.reporter_name));
    const reach = num(m.reach), eng = num(m.engagement);
    b.reach += reach;
    b.engagement += eng;
    b.posts += 1;
    const rate = reach > 0 ? (eng / reach) * 100 : 0;
    if (!b.topPost || eng > b.topPost.engagement) {
      b.topPost = {
        title: m.post_title || m.post_url || "(untitled post)",
        url: m.post_url || null, channel: m.channel || "other",
        reach, engagement: eng, rate: +rate.toFixed(2),
      };
    }
  }

  const reportersOut = [...buckets.values()].map((b) => {
    b.recent.sort((a, c) => String(c.entry_date || "").localeCompare(String(a.entry_date || "")));
    b.recent = b.recent.slice(0, 8);
    const rate = b.reach > 0 ? +((b.engagement / b.reach) * 100).toFixed(2) : null;
    // Scale the daily target into a period target (skip for all-time).
    let periodTarget = null, targetStatus = "none";
    if (b.daily_target != null && period !== "all") {
      periodTarget = period === "today" ? b.daily_target : b.daily_target * (win.days || 1);
      targetStatus = b.periodItems >= periodTarget ? "met" : "under";
    }
    const { submit_token, ...rest } = b;   // don't leak the raw secret; expose only the encoded link token
    return { ...rest, engagementRate: rate, periodTarget, targetStatus, submitToken: encodeSubmitToken(newsroomId, submit_token) };
  });

  // Roster first, then by this-period output (busiest at the top).
  reportersOut.sort((a, c) =>
    (Number(c.onRoster) - Number(a.onRoster)) || (c.periodItems - a.periodItems) || a.name.localeCompare(c.name));

  // ── Topline + overall breakdowns (period-scoped).
  const channelTotals = emptyChannels();
  for (const b of reportersOut) for (const c of CHANNELS) channelTotals[c] += b.byChannel[c];

  const timeline = buildTimeline(period, entries, now);

  // Flat, newest-first activity feed for the period (drives per-reporter drill-down too).
  const feed = entries
    .filter((e) => inWindow(e.entry_date, win))
    .map((e) => ({
      entry_date: e.entry_date || null,
      reporter_name: e.reporter_name || "—",
      channel: CHANNELS.includes(e.channel) ? e.channel : "other",
      item_type: e.item_type || "post",
      title: e.title || null, url: e.url || null,
      qty: qtyOf(e), source: e.source || "manual",
      ts: e.ingested_at || e.entry_date || "",
    }))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(b.entry_date).localeCompare(String(a.entry_date)))
    .slice(0, 300);

  const standouts = metrics
    .filter((m) => inWindow(m.measured_on, win))
    .map((m) => ({
      reporter_name: m.reporter_name || "—", channel: m.channel || "other",
      title: m.post_title || m.post_url || "(untitled post)", url: m.post_url || null,
      reach: num(m.reach), engagement: num(m.engagement),
      rate: num(m.reach) > 0 ? +((num(m.engagement) / num(m.reach)) * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 12);

  const topline = {
    reporters: reporters.length,
    activeThisPeriod: reportersOut.filter((b) => b.periodItems > 0).length,
    itemsToday: reportersOut.reduce((s, b) => s + b.today, 0),
    itemsThisPeriod: reportersOut.reduce((s, b) => s + b.periodItems, 0),
    totalItems: reportersOut.reduce((s, b) => s + b.allItems, 0),
    totalReach: reportersOut.reduce((s, b) => s + b.reach, 0),
    totalEngagement: reportersOut.reduce((s, b) => s + b.engagement, 0),
    trackedPosts: standouts.length,
  };

  return {
    empty, period, periodLabel, today: todayStr, windowStart: win.start,
    topline, channelTotals, reporters: reportersOut, timeline, standouts, feed,
  };
}

/** Build every period's dashboard in one go — the shape getReport returns. */
export function buildAllPeriods(data = {}, now = new Date(), newsroomId = "local") {
  const periods = {};
  for (const p of PERIODS) periods[p.key] = buildDashboard(data, now, newsroomId, p.key);
  return {
    empty: periods.all.empty,
    periodKeys: PERIODS,
    defaultPeriod: "week",
    today: dayStr(now),
    periods,
  };
}
