/**
 * lib/connectors/facebook.js — pull post performance from a Facebook Page.
 *
 * Uses the Graph API with a long-lived Page access token the manager pastes in
 * (read_insights + pages_read_engagement). It fetches the Page's recent posts,
 * matches each one to an entry a reporter logged (by permalink ↔ the URL on a
 * facebook entry), and for the matched posts reads reach (post_impressions_unique)
 * + reactions/comments/shares. Only attributable posts become metrics.
 *
 * No SDK — plain `fetch` (Node 20+ global; injectable as fetchImpl for tests).
 * The framework (lib/connectors/index.js) handles storage, idempotency and the
 * last_sync summary; this module only knows how to talk to Facebook.
 */

export const id = "facebook";
export const label = "Facebook Page Insights";
export const channel = "facebook";
export const description =
  "Pull reach, reactions, comments and shares for your Facebook Page's recent posts, " +
  "matched to the entries your reporters logged. Works best when reporters log the post's permalink.";
export const docsUrl = "https://developers.facebook.com/docs/pages-api/getting-started";

export const configFields = [
  { key: "pageId", label: "Facebook Page ID", type: "text", required: true,
    placeholder: "e.g. 1234567890", hint: "The numeric id (or username) of your Page." },
  { key: "accessToken", label: "Long-lived Page access token", type: "password", required: true, secret: true,
    hint: "A Page token with read_insights + pages_read_engagement. Stays on the server; never shown again." },
  { key: "apiVersion", label: "Graph API version (optional)", type: "text", required: false,
    placeholder: "v21.0" },
];

export function validate(config) {
  if (!config?.pageId) return { ok: false, error: "Enter your Facebook Page ID." };
  if (!config?.accessToken) return { ok: false, error: "Paste a long-lived Page access token." };
  return { ok: true };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Normalise a URL for loose comparison: host+path, lowercased, no scheme/www/trailing-slash/query. */
function normUrl(u) {
  const raw = String(u || "").trim();
  if (!raw) return "";
  try {
    const x = new URL(raw);
    return (x.host + x.pathname).toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\?.*$/, "").replace(/\/+$/, "");
  }
}

/** Comparison keys for a Graph post: its normalised permalink + its numeric story id. */
function postKeys(post) {
  const keys = new Set();
  if (post.permalink_url) keys.add(normUrl(post.permalink_url));
  const tail = String(post.id || "").split("_").pop(); // {pageId}_{storyId} → storyId
  if (tail && tail.length > 3) keys.add(tail.toLowerCase());
  return [...keys].filter(Boolean);
}

/** Find which facebook entry (and thus reporter) a post belongs to, or null. */
function matchEntry(post, fbEntries) {
  const keys = postKeys(post);
  if (!keys.length) return null;
  for (const e of fbEntries) {
    const eu = normUrl(e.url);
    if (!eu) continue;
    for (const k of keys) {
      if (eu === k || eu.includes(k) || k.includes(eu)) return e;
    }
  }
  return null;
}

const numOr = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

export async function sync({ config, entries, fetchImpl } = {}) {
  const fetch = fetchImpl || globalThis.fetch;
  if (typeof fetch !== "function") throw new Error("No fetch available in this runtime.");

  const v = /^v\d+\.\d+$/.test(config.apiVersion || "") ? config.apiVersion : "v21.0";
  const base = `https://graph.facebook.com/${v}`;
  const token = config.accessToken;
  const enc = encodeURIComponent;

  const fbEntries = (entries || []).filter((e) => e.channel === "facebook" && e.url);

  // 1) Recent Page posts, with engagement summaries inline.
  const fields = "id,message,permalink_url,created_time,shares,comments.summary(true),reactions.summary(true)";
  const postsUrl = `${base}/${enc(config.pageId)}/posts?fields=${enc(fields)}&limit=50&access_token=${enc(token)}`;
  const res = await fetch(postsUrl);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    throw new Error(`Facebook: ${body?.error?.message || `request failed (${res.status})`}`);
  }
  const posts = Array.isArray(body?.data) ? body.data : [];

  // 2) For each post that matches a logged entry, record its numbers (and reach).
  const metrics = [];
  let matched = 0;
  for (const post of posts) {
    const entry = matchEntry(post, fbEntries);
    if (!entry) continue;
    matched++;

    let reach = null;
    try {
      const insUrl = `${base}/${enc(post.id)}/insights/post_impressions_unique?access_token=${enc(token)}`;
      const ir = await fetch(insUrl);
      const ib = await ir.json().catch(() => null);
      if (ir.ok && !ib?.error) reach = ib?.data?.[0]?.values?.[0]?.value ?? null;
    } catch { /* reach is best-effort; leave null */ }

    const reactions = numOr(post.reactions?.summary?.total_count);
    const comments = numOr(post.comments?.summary?.total_count);
    const shares = numOr(post.shares?.count);

    metrics.push({
      post_key: String(post.id),
      reporter_name: entry.reporter_name || entry.name || null,
      channel: "facebook",
      post_url: post.permalink_url || entry.url || null,
      post_title: (post.message || "").trim().slice(0, 120) || entry.title || "(Facebook post)",
      reach: reach == null ? null : numOr(reach, null),
      engagement: reactions + comments + shares,
      likes: reactions,
      comments,
      shares,
      views: null,
      measured_on: today(),
    });
  }

  return { fetched: posts.length, matched, unmatched: posts.length - matched, metrics };
}
