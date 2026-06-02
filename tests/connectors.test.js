/**
 * tests/connectors.test.js — the performance-connector framework + the Facebook
 * connector, exercised with a mock fetch and an in-memory host. No network, no
 * Postgres, no API key — proves the plumbing end-to-end before it touches the box.
 *
 *   node --test tests/connectors.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as facebook from "../lib/connectors/facebook.js";
import { saveConnectorConfig, runSync, listAutoMetrics, describeConnectors } from "../lib/connectors/index.js";

// ── A tiny host that mimics the runtime: host.store + the host.db.query that
//    listEntries() uses. Entries are returned for the *_entries table.
function makeHost(entries = []) {
  const collections = new Map(); // name → Map(key → value)
  const col = (c) => { if (!collections.has(c)) collections.set(c, new Map()); return collections.get(c); };
  return {
    _collections: collections,
    db: { query: async (table) => ({ rows: table.endsWith("entries") ? entries : [] }) },
    store: {
      list: async (c) => [...col(c).entries()].map(([key, value]) => ({ key, value })),
      get: async (c, k) => (col(c).has(k) ? col(c).get(k) : null),
      put: async (c, k, v) => { col(c).set(k, v); },
      delete: async (c, k) => { col(c).delete(k); },
    },
    log: { run: async () => {}, error: async () => {} },
  };
}

// ── A mock Graph API. Two posts; one matches a logged entry by permalink.
function makeFetch({ failPosts = false } = {}) {
  return async (url) => {
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    const err = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
    if (/\/posts\?/.test(url)) {
      if (failPosts) return err(400, "Invalid OAuth access token.");
      return ok({
        data: [
          { id: "111_222", message: "Budget protest live updates", permalink_url: "https://www.facebook.com/111/posts/222",
            shares: { count: 4 }, comments: { summary: { total_count: 9 } }, reactions: { summary: { total_count: 30 } } },
          { id: "111_999", message: "Unrelated page post", permalink_url: "https://www.facebook.com/111/posts/999",
            shares: { count: 1 }, comments: { summary: { total_count: 0 } }, reactions: { summary: { total_count: 5 } } },
        ],
      });
    }
    if (/\/insights\//.test(url)) {
      return ok({ data: [{ name: "post_impressions_unique", values: [{ value: 1200 }] }] });
    }
    return err(404, "not found");
  };
}

const CONFIG = { pageId: "111", accessToken: "tok-secret", apiVersion: "v21.0" };
const ENTRIES = [
  // Thandi logged the budget post with its permalink → should match post 111_222.
  { reporter_name: "Thandi Banda", channel: "facebook", url: "https://facebook.com/111/posts/222/", title: "Budget protest" },
  // A website entry that must never be touched by the Facebook connector.
  { reporter_name: "Sipho Dube", channel: "website", url: "https://news.co/budget", title: "Budget story" },
];

test("facebook.sync: matches a post to the reporter who logged its link", async () => {
  const out = await facebook.sync({ config: CONFIG, entries: ENTRIES, fetchImpl: makeFetch() });
  assert.equal(out.fetched, 2);
  assert.equal(out.matched, 1);
  assert.equal(out.unmatched, 1);
  assert.equal(out.metrics.length, 1);
  const m = out.metrics[0];
  assert.equal(m.reporter_name, "Thandi Banda");
  assert.equal(m.channel, "facebook");
  assert.equal(m.engagement, 43);   // 30 reactions + 9 comments + 4 shares
  assert.equal(m.likes, 30);
  assert.equal(m.reach, 1200);      // from the insights call
  assert.equal(m.post_key, "111_222");
});

test("runSync: writes attributed metrics to the store and is idempotent", async () => {
  const host = makeHost(ENTRIES);
  await saveConnectorConfig(host, "facebook", CONFIG);

  const first = await runSync(host, "facebook", { fetchImpl: makeFetch() });
  assert.equal(first.written, 1);
  assert.equal(first.error, null);

  let stored = await listAutoMetrics(host);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].reporter_name, "Thandi Banda");
  assert.equal(stored[0].source, "facebook");

  // Re-sync: same post key → overwrite, not a duplicate row.
  await runSync(host, "facebook", { fetchImpl: makeFetch() });
  stored = await listAutoMetrics(host);
  assert.equal(stored.length, 1, "re-sync must not pile up duplicate metrics");
});

test("describeConnectors: masks the secret token, reports configured state", async () => {
  const host = makeHost(ENTRIES);
  await saveConnectorConfig(host, "facebook", CONFIG);
  const [fb] = await describeConnectors(host);
  assert.equal(fb.id, "facebook");
  assert.equal(fb.configured, true);
  const tokenField = fb.configFields.find((f) => f.key === "accessToken");
  assert.equal(tokenField.value, "********", "the token must never be returned to the client");
  const pageField = fb.configFields.find((f) => f.key === "pageId");
  assert.equal(pageField.value, "111", "non-secret fields echo back so the form can show them");
});

test("saveConnectorConfig: a blank/masked secret keeps the stored token", async () => {
  const host = makeHost(ENTRIES);
  await saveConnectorConfig(host, "facebook", CONFIG);
  // Manager re-saves changing only the pageId, leaving the token field as the mask.
  await saveConnectorConfig(host, "facebook", { pageId: "222", accessToken: "********" });
  const state = await host.store.get("connectors", "facebook");
  assert.equal(state.config.pageId, "222");
  assert.equal(state.config.accessToken, "tok-secret", "the masked token must not overwrite the real one");
});

test("validate: rejects missing page id / token", () => {
  assert.equal(facebook.validate({ pageId: "1", accessToken: "t" }).ok, true);
  assert.equal(facebook.validate({ pageId: "", accessToken: "t" }).ok, false);
  assert.equal(facebook.validate({ pageId: "1" }).ok, false);
});

test("runSync: a Graph error is recorded on last_sync and surfaced", async () => {
  const host = makeHost(ENTRIES);
  await saveConnectorConfig(host, "facebook", CONFIG);
  await assert.rejects(
    () => runSync(host, "facebook", { fetchImpl: makeFetch({ failPosts: true }) }),
    /Invalid OAuth/,
  );
  const state = await host.store.get("connectors", "facebook");
  assert.match(state.last_sync.error, /Invalid OAuth/);
  assert.equal(state.last_sync.written, 0);
});
