/**
 * lib/report.js — turn the flat reporters/entries/metrics rows into the manager
 * accountability dashboard. Pure JS, no IO: the handlers load the rows via the
 * host and hand them here, so this runs identically on a laptop and online.
 *
 * Why aggregate here and not in SQL? The lite host's JSON engine only does
 * `WHERE newsroom_id = $1` — no GROUP BY, no JOIN. Doing it in JS keeps one code
 * path for both worlds (see lib/store.js).
 */

import { CHANNELS, reporterKey, encodeSubmitToken } from "./store.js";

const dayStr = (d) => d.toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const qtyOf = (e) => { const n = parseInt(e.qty, 10); return Number.isFinite(n) ? n : 1; };

function emptyChannels() {
  const o = {};
  for (const c of CHANNELS) o[c] = 0;
  return o;
}

export function buildDashboard({ reporters = [], entries = [], metrics = [] } = {}, now = new Date(), newsroomId = "local") {
  const todayStr = dayStr(now);
  const weekAgo = dayStr(new Date(now.getTime() - 6 * 86400000));   // 7-day window incl. today
  const empty = !reporters.length && !entries.length && !metrics.length;

  // ── One bucket per reporter, seeded from the roster, then folded with output.
  const buckets = new Map();
  const bucket = (name, key) => {
    const k = key || reporterKey(name);
    if (!buckets.has(k)) {
      buckets.set(k, {
        reporter_key: k, name: name || k, beat: null, daily_target: null,
        active: true, onRoster: false, submit_token: null,
        items: 0, entryCount: 0, today: 0, week: 0, lastActive: null,
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
    b.items += q;
    b.entryCount += 1;
    b.byChannel[ch] += q;
    if (e.entry_date === todayStr) b.today += q;
    if (e.entry_date && e.entry_date >= weekAgo) b.week += q;
    if (!b.lastActive || (e.entry_date && e.entry_date > b.lastActive)) b.lastActive = e.entry_date || b.lastActive;
    b.recent.push({
      entry_date: e.entry_date || null, channel: ch, item_type: e.item_type || "post",
      title: e.title || null, url: e.url || null, qty: q, source: e.source || "manual",
    });
  }

  // ── Fold in performance metrics (matched to a reporter by name).
  for (const m of metrics) {
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
    b.recent = b.recent.slice(0, 6);
    const rate = b.reach > 0 ? +((b.engagement / b.reach) * 100).toFixed(2) : null;
    let targetStatus = "none";
    if (b.daily_target != null) targetStatus = b.today >= b.daily_target ? "met" : "under";
    const { submit_token, ...rest } = b;   // don't leak the raw secret; expose only the encoded link token
    return { ...rest, engagementRate: rate, targetStatus, submitToken: encodeSubmitToken(newsroomId, submit_token) };
  });

  // Roster first, then by this-week output (busiest at the top).
  reportersOut.sort((a, c) =>
    (Number(c.onRoster) - Number(a.onRoster)) || (c.week - a.week) || a.name.localeCompare(c.name));

  // ── Topline + overall breakdowns.
  const channelTotals = emptyChannels();
  for (const b of reportersOut) for (const c of CHANNELS) channelTotals[c] += b.byChannel[c];

  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const d = dayStr(new Date(now.getTime() - i * 86400000));
    timeline.push({ date: d, items: 0 });
  }
  const tIndex = new Map(timeline.map((t, i) => [t.date, i]));
  for (const e of entries) {
    const i = tIndex.get(e.entry_date);
    if (i !== undefined) timeline[i].items += qtyOf(e);
  }

  // Flat, newest-first activity feed across the whole team.
  const feed = entries
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
    .slice(0, 80);

  const standouts = metrics
    .map((m) => ({
      reporter_name: m.reporter_name || "—", channel: m.channel || "other",
      title: m.post_title || m.post_url || "(untitled post)", url: m.post_url || null,
      reach: num(m.reach), engagement: num(m.engagement),
      rate: num(m.reach) > 0 ? +((num(m.engagement) / num(m.reach)) * 100).toFixed(2) : 0,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 8);

  const topline = {
    reporters: reporters.length,
    activeThisWeek: reportersOut.filter((b) => b.week > 0).length,
    itemsToday: reportersOut.reduce((s, b) => s + b.today, 0),
    itemsThisWeek: reportersOut.reduce((s, b) => s + b.week, 0),
    totalItems: reportersOut.reduce((s, b) => s + b.items, 0),
    totalReach: reportersOut.reduce((s, b) => s + b.reach, 0),
    totalEngagement: reportersOut.reduce((s, b) => s + b.engagement, 0),
    trackedPosts: metrics.length,
  };

  return { empty, today: todayStr, weekStart: weekAgo, topline, channelTotals, reporters: reportersOut, timeline, standouts, feed };
}
