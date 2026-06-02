/**
 * tests/inbound.test.js — the email self-report intake (provider-agnostic
 * payload parsing + sender→reporter matching + AI-parse ingest), with a mock
 * host (stubbed host.ai) and no network.
 *
 *   node --test tests/inbound.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInbound, extractEmail, tokenFromAddress, ingestInboundEmail } from "../lib/inbound.js";

// Mock host: in-memory entries store + a stubbed AI that "parses" a fixed reply.
function makeHost(reporters = []) {
  const entries = [];
  return {
    _entries: entries,
    ctx: { newsroomId: "local" },
    db: {
      query: async (table, sql, params) => {
        if (table.endsWith("reporters")) return { rows: reporters };
        if (table.endsWith("entries") && /^\s*insert/i.test(sql)) {
          const cols = sql.match(/\(([^)]+)\)\s+VALUES/i)[1].split(",").map((c) => c.trim());
          const row = {}; cols.forEach((c, i) => { row[c] = i === 0 ? "local" : params[i - 1]; });
          entries.push(row); return { rows: [], rowCount: 1 };
        }
        if (table.endsWith("entries")) return { rows: entries };
        return { rows: [] };
      },
      tx: async (fn) => fn({ query: async (t, s, p) => makeHost.__noop }),
    },
    ai: {
      chat: async () => ({
        text: JSON.stringify({ reporter: null, date: null, items: [
          { channel: "facebook", item_type: "post", title: "budget protest", url: null, qty: 2 },
          { channel: "website", item_type: "story", title: "council vote", url: "https://news.co/vote", qty: 1 },
        ] }),
        provider: "anthropic", model: "mock",
      }),
    },
    log: { run: async () => {}, error: async () => {} },
  };
}
// Make host.db.tx share the same insert path as query.
function makeHostTx(reporters) {
  const host = makeHost(reporters);
  host.db.tx = async (fn) => fn({ query: host.db.query });
  return host;
}

test("extractEmail handles 'Name <addr>' and bare addresses", () => {
  assert.equal(extractEmail("Thandi Banda <thandi@news.co>"), "thandi@news.co");
  assert.equal(extractEmail("THANDI@NEWS.CO"), "thandi@news.co");
  assert.equal(extractEmail("not an email"), null);
});

test("tokenFromAddress reads both plus-addressing and subdomain schemes", () => {
  assert.equal(tokenFromAddress("reports+ABC123@in.example.com"), "ABC123");
  assert.equal(tokenFromAddress("ABC123@in.example.com"), "ABC123");
  assert.equal(tokenFromAddress("Mailer <reports+XYZ@d.com>"), "XYZ");
});

test("normalizeInbound copes with SendGrid/Mailgun/Postmark field names", () => {
  const sg = normalizeInbound({ from: "Thandi <thandi@news.co>", to: "reports+TOK@in.d.com", subject: "Day", text: "did stuff" });
  assert.equal(sg.fromEmail, "thandi@news.co");
  assert.equal(sg.token, "TOK");
  assert.equal(sg.text, "did stuff");

  const mg = normalizeInbound({ sender: "thandi@news.co", recipient: "reports+TOK@in.d.com", subject: "x", "body-plain": "mg body" });
  assert.equal(mg.fromEmail, "thandi@news.co");
  assert.equal(mg.text, "mg body");

  const pm = normalizeInbound({ From: "thandi@news.co", To: "reports+TOK@in.d.com", TextBody: "pm body" });
  assert.equal(pm.text, "pm body");

  const explicit = normalizeInbound({ from: "a@b.co", token: "EXP" }, { token: "QRY" });
  assert.equal(explicit.token, "EXP", "an explicit body token wins over the address/query");
});

test("ingestInboundEmail: matches sender to a reporter and saves parsed entries", async () => {
  const host = makeHostTx([{ name: "Thandi Banda", reporter_key: "thandi banda", email: "thandi@news.co" }]);
  const out = await ingestInboundEmail(host, { fromEmail: "thandi@news.co", subject: "My day", text: "posted 2 FB + a website story" });
  assert.equal(out.ok, true);
  assert.equal(out.reporter, "Thandi Banda");
  assert.equal(out.added, 2);
  assert.equal(host._entries.length, 2);
  assert.equal(host._entries[0].reporter_name, "Thandi Banda");
  assert.equal(host._entries[0].source, "email");
});

test("ingestInboundEmail: unknown sender is rejected, nothing saved", async () => {
  const host = makeHostTx([{ name: "Thandi Banda", reporter_key: "thandi banda", email: "thandi@news.co" }]);
  const out = await ingestInboundEmail(host, { fromEmail: "stranger@elsewhere.com", text: "hello" });
  assert.equal(out.ok, false);
  assert.equal(out.error, "unknown_sender");
  assert.equal(host._entries.length, 0);
});

test("ingestInboundEmail: no sender / empty message handled", async () => {
  const host = makeHostTx([{ name: "Thandi Banda", email: "thandi@news.co" }]);
  assert.equal((await ingestInboundEmail(host, { fromEmail: null })).error, "no_sender");
  assert.equal((await ingestInboundEmail(host, { fromEmail: "thandi@news.co", subject: "", text: "" })).error, "empty");
});
