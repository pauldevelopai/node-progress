/**
 * lib/routes.js — Progress Tracker's non-standard /api/* endpoints (the writes:
 * roster, logging output, parsing a daily report, recording performance).
 * Mounted after the runtime's standard routes.
 *
 *   Local  (index.js):         mountProgressRoutes(app, () => host)
 *   Hosted (server-hosted.js): mountProgressRoutes(app, hostFor)   // per request
 *
 * `getHost(req)` returns the host to use for THIS request — a fixed lite host
 * locally, or a per-request, newsroom-scoped Postgres host online. Everything
 * goes through the host interface, so it's multi-tenant online and file-based on
 * a laptop with the same code.
 */

import { addReporter, addEntry, addEntries, addMetric, decodeSubmitToken, findReporterByToken, encodeSubmitToken, getInboundConfig, listReporters } from "./store.js";
import { parseDailyReport } from "./parse-report.js";
import { describeConnectors, saveConnectorConfig, runSync, getConnector } from "./connectors/index.js";
import { normalizeInbound, ingestInboundEmail } from "./inbound.js";

export function mountProgressRoutes(app, getHost) {
  const wrap = (fn) => async (req, res) => {
    let host;
    try {
      host = getHost(req);
      res.json(await fn(req, host));
    } catch (err) {
      console.error("progress route error:", err.message);
      res.status(500).json({ ok: false, error: err.message || "progress error" });
      try { await host?.log?.error?.({ op: req.path, error: err, context: { method: req.method } }); }
      catch { /* swallow */ }
    }
  };

  // ─── Roster ───────────────────────────────────────────────────
  app.post("/api/reporters", wrap(async (req, host) => {
    const result = await addReporter(host, req.body || {});
    if (result.ok && !result.existed) await host.log.run({ op: "reporter_add", name: result.reporter.name });
    return result;
  }));

  // ─── Log output by hand ───────────────────────────────────────
  app.post("/api/entries", wrap(async (req, host) => {
    const result = await addEntry(host, req.body || {});
    if (result.ok) await host.log.run({ op: "entry_add", source: result.entry.source, channel: result.entry.channel });
    return result;
  }));

  // ─── Parse a free-text daily report, then save the entries ─────
  // body: { text, reporterName?, entryDate?, save? }  — save defaults to true.
  app.post("/api/daily-report", wrap(async (req, host) => {
    const { text, reporterName, entryDate, save = true } = req.body || {};
    await host.log.run({ op: "daily_report_parse_start", has_reporter: !!reporterName });
    const parsed = await parseDailyReport(host, { text, reporterName, entryDate });
    if (!parsed.ok) return parsed;

    let added = 0;
    if (save && parsed.items.length) {
      const out = await addEntries(host, parsed.items, {
        reporter_name: parsed.reporter, entry_date: parsed.date,
        source: "paste", raw_text: String(text || "").slice(0, 4000),
      });
      added = out.added;
    }
    await host.log.run({
      op: "daily_report_parse_done", provider: parsed.provider, model: parsed.model,
      story_count: parsed.items.length, success: true,
    });
    return { ok: true, reporter: parsed.reporter, date: parsed.date, items: parsed.items, added };
  }));

  // ─── Record real-world post performance (entered by hand) ──────
  app.post("/api/metrics", wrap(async (req, host) => {
    const result = await addMetric(host, req.body || {});
    if (result.ok) await host.log.run({ op: "metric_add", channel: result.metric.channel });
    return result;
  }));

  // ─── Performance connectors (pull metrics automatically) ──────
  // List every connector with its (secret-masked) settings + last-sync status.
  app.get("/api/connectors", wrap(async (_req, host) => ({
    ok: true, connectors: await describeConnectors(host),
  })));

  // Save a connector's settings (token kept server-side, never echoed back).
  app.post("/api/connectors/:id/config", wrap(async (req, host) => {
    if (!getConnector(req.params.id)) throw new Error(`Unknown connector: ${req.params.id}`);
    const result = await saveConnectorConfig(host, req.params.id, req.body?.config || {});
    await host.log.run({ op: "connector_config", connector: req.params.id, configured: result.configured });
    return result;
  }));

  // Run a connector now → pull numbers, attribute to reporters, upsert metrics.
  app.post("/api/connectors/:id/sync", wrap(async (req, host) => {
    const last_sync = await runSync(host, req.params.id);
    await host.log.run({
      op: "connector_sync", connector: req.params.id,
      fetched: last_sync.fetched, matched: last_sync.matched, written: last_sync.written,
    });
    return { ok: true, last_sync };
  }));

  // ─── Email intake settings (the newsroom's inbound address) ────
  app.get("/api/inbound", wrap(async (_req, host) => {
    const cfg = await getInboundConfig(host);
    const token = encodeSubmitToken(host?.ctx?.newsroomId || "local", cfg.secret);
    const domain = process.env.INBOUND_EMAIL_DOMAIN || null;       // e.g. "in.grounded.developai.co.za"
    const enabled = !!process.env.INBOUND_EMAIL_SECRET;            // the webhook is live only when a secret is set
    const address = domain ? `reports+${token}@${domain}` : null; // what reporters email
    const reporters = (await listReporters(host)).map((r) => ({ name: r.name, email: r.email || null }));
    return { ok: true, enabled, domain, token, address, reporters };
  }));

  // ─── Reporter self-serve submission (NO login) ────────────────
  // These live OUTSIDE /api on purpose, so the runtime's tracker-cookie auth gate
  // (mounted on /api) doesn't bounce a reporter who has only a submit link. The
  // token carries the newsroom_id, so we scope the host to it by setting req.user
  // before getHost(req) — then match the reporter by the token's secret. Locally
  // getHost ignores req (single lite host), so the same code works both ways.
  const hostForToken = (req, token) => {
    const decoded = decodeSubmitToken(token);
    if (!decoded) return { decoded: null };
    req.user = { id: decoded.newsroomId, email: null }; // scopes the hosted pg host
    return { decoded, host: getHost(req) };
  };

  // Validate a link + greet the reporter by name.
  app.get("/submit/whoami", async (req, res) => {
    try {
      const { decoded, host } = hostForToken(req, req.query?.t);
      if (!decoded) return res.status(400).json({ ok: false, error: "bad_link" });
      const reporter = await findReporterByToken(host, decoded.secret);
      if (!reporter) return res.status(404).json({ ok: false, error: "unknown_link" });
      res.json({ ok: true, reporter: reporter.name, newsroom: host?.meta?.newsroom || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || "error" });
    }
  });

  // Accept a reporter's end-of-day message → AI parse → save entries.
  app.post("/submit/ingest", async (req, res) => {
    let host;
    try {
      const { token, text } = req.body || {};
      const t = hostForToken(req, token);
      if (!t.decoded) return res.status(400).json({ ok: false, error: "bad_link" });
      host = t.host;
      const reporter = await findReporterByToken(host, t.decoded.secret);
      if (!reporter) return res.status(404).json({ ok: false, error: "unknown_link" });

      await host.log.run({ op: "self_submit_start", reporter: reporter.name });
      const parsed = await parseDailyReport(host, { text, reporterName: reporter.name });
      if (!parsed.ok) return res.json({ ...parsed, reporter: reporter.name });

      const out = await addEntries(host, parsed.items, {
        reporter_name: reporter.name, entry_date: parsed.date,
        source: "self-submit", raw_text: String(text || "").slice(0, 4000),
      });
      await host.log.run({ op: "self_submit_done", reporter: reporter.name, story_count: out.added, success: true });
      res.json({ ok: true, reporter: reporter.name, date: parsed.date, items: parsed.items, added: out.added });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || "submit failed" });
      try { await host?.log?.error?.({ op: "self_submit", error: e }); } catch { /* swallow */ }
    }
  });

  // ─── Inbound email webhook (NO login) ─────────────────────────
  // A mail service POSTs reporter emails here. Two layers of protection, because
  // it's public: (1) a shared INBOUND_EMAIL_SECRET that the mail route must
  // present (header `x-grounded-inbound-secret`, `?k=`, or a `secret` field) —
  // and if that env var isn't set the endpoint is OFF (503) by default; (2) the
  // per-newsroom token in the recipient address, whose secret must match the one
  // stored for that newsroom (stops one newsroom's address being used to write
  // into another). Then the sender is matched to a reporter by their email.
  app.post("/inbound/email", async (req, res) => {
    let host;
    try {
      const secret = process.env.INBOUND_EMAIL_SECRET;
      if (!secret) return res.status(503).json({ ok: false, error: "inbound_disabled" });
      const presented = req.get("x-grounded-inbound-secret") || req.query?.k || req.body?.secret;
      if (presented !== secret) return res.status(401).json({ ok: false, error: "unauthorized" });

      const payload = normalizeInbound(req.body || {}, req.query || {});
      const decoded = decodeSubmitToken(payload.token);
      if (!decoded) return res.status(400).json({ ok: false, error: "bad_address" });

      req.user = { id: decoded.newsroomId, email: null }; // scope the hosted pg host
      host = getHost(req);
      const cfg = await getInboundConfig(host);
      if (!cfg || cfg.secret !== decoded.secret) return res.status(403).json({ ok: false, error: "bad_token" });

      await host.log.run({ op: "inbound_email_start" });
      const result = await ingestInboundEmail(host, payload);
      await host.log.run({
        op: "inbound_email_done", matched: !!result.ok,
        added: result.added || 0, reason: result.ok ? null : result.error,
      });
      // 200 even on a non-match, so the mail provider doesn't retry-storm.
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || "inbound failed" });
      try { await host?.log?.error?.({ op: "inbound_email", error: e }); } catch { /* swallow */ }
    }
  });
}
