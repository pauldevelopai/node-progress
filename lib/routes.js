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

import { addReporter, addEntry, addEntries, addMetric, decodeSubmitToken, findReporterByToken } from "./store.js";
import { parseDailyReport } from "./parse-report.js";

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
}
