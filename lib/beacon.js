/**
 * lib/beacon.js — identified local-install telemetry (ON by default, opt-out).
 *
 * On startup the Node POSTs a tiny heartbeat to the GROUNDED tracker so Paul can
 * see download / local-install activity in the Nodes admin — the same view that
 * shows the hosted newsrooms. A newsroom opts OUT by setting GROUNDED_TELEMETRY=off
 * in their .env. The terminal prints a one-line notice when it's sharing.
 *
 * What it sends, and ONLY this:
 *   install_id        the sticky host_id the runtime already generates locally
 *   node_slug, node_version, runtime_version
 *   newsroom          the name set via NEWSROOM (identified — chosen model)
 *   os                coarse platform string (e.g. "darwin arm64 node v20.11")
 *   counts            # reporters / # entries / # briefs / # errors (integers)
 *   last_activity_at  timestamp of the most recent activity entry
 *
 * It NEVER sends reporter names, story titles, URLs, report text, prompts,
 * responses, or API keys. Fire-and-forget with a short timeout: any failure is
 * swallowed so the beacon can never delay or break the app.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_URL = "https://grounded.developai.co.za/api/nodes/beacon";

// ON by default. Disabled only if the newsroom explicitly opts out.
function telemetryEnabled() {
  const v = String(process.env.GROUNDED_TELEMETRY ?? "").toLowerCase().trim();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

const readJson = (file, fallback) => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback; }
  catch { return fallback; }
};

export async function maybeSendBeacon({ host, slug = "progress", dataDir = "data/processed" } = {}) {
  if (!telemetryEnabled()) return { sent: false, reason: "telemetry disabled (GROUNDED_TELEMETRY=off)" };
  // Transparency: tell the newsroom what's shared and how to turn it off.
  console.log("  Sharing anonymous usage with Develop AI (newsroom name, version, OS, counts — never reporter names or report text). Opt out: set GROUNDED_TELEMETRY=off in .env");
  try {
    const meta = host?.meta || {};
    if (!meta.host_id) return { sent: false, reason: "no install id" };

    // Local storage layout (lite host): each table is a JSON file under
    // data/processed/<prefix><table>.json; the activity log is the same.
    const prefix = `node_${slug.replace(/-/g, "_")}_`;
    const f = (name) => join(process.cwd(), dataDir, `${prefix}${name}.json`);
    const activity  = readJson(f("activity"), []);
    const errors    = readJson(f("errors"), []);
    const reporters = readJson(f("reporters"), []);
    const entries   = readJson(f("entries"), []);

    const isRun = (e, op) => e && e.kind === "run" && e.op === op;
    const counts = {
      reporters: Array.isArray(reporters) ? reporters.length : 0,
      entries: Array.isArray(entries) ? entries.length : 0,
      briefs: activity.filter((e) => isRun(e, "brief")).length,
      errors: Array.isArray(errors) ? errors.length : 0,
    };
    const last = Array.isArray(activity) && activity.length ? activity[activity.length - 1] : null;

    const payload = {
      install_id: meta.host_id,
      node_slug: slug,
      newsroom: meta.newsroom || null,
      node_version: meta.node_version || null,
      runtime_version: meta.runtime_version || null,
      os: meta.platform || null,
      counts,
      last_activity_at: (last && last.ts) || meta.last_boot || null,
    };

    const url = process.env.GROUNDED_TELEMETRY_URL || DEFAULT_URL;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
