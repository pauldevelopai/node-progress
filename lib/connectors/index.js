/**
 * lib/connectors/index.js — the pluggable performance-connector framework.
 *
 * A connector pulls real-world post performance from a platform (Facebook,
 * later TikTok / GA4 …) so the manager doesn't have to type numbers by hand.
 * Everything goes through the host interface, so the SAME code runs on a laptop
 * (host.store = JSON files) and online (host.store = per-newsroom Postgres).
 *
 * Two design choices that keep this lite-and-hosted safe:
 *
 *  1. **Config lives in host.store** (collection "connectors", key = connector id):
 *       { enabled, config: {…platform creds…}, last_sync: {…} }
 *     The platform token is sensitive; it lives only here and is NEVER returned
 *     to the browser (describeConnectors masks secret fields) or written to the
 *     activity log.
 *
 *  2. **Pulled numbers go to host.store too** (collection "auto_metrics",
 *     key = `${connectorId}:${postKey}`), not the metrics TABLE. The lite JSON
 *     engine can't UPDATE or selectively DELETE, so re-syncing the same post
 *     would otherwise pile up duplicate rows. A keyed store.put() is naturally
 *     idempotent: the second sync overwrites the first. The dashboard merges
 *     these auto-metrics with the hand-entered metric rows at read time
 *     (see handlers.loadAll → report.js), so report.js stays unchanged.
 *
 * Attribution: a connector returns metrics already tagged with a reporter_name,
 * which it works out by matching the platform post to an entry the reporter
 * logged (e.g. a Facebook permalink ↔ the URL on a facebook entry). Posts that
 * match no logged entry are counted in last_sync (fetched vs matched) but not
 * recorded — every stored metric is attributable to a real reporter.
 */

import * as facebook from "./facebook.js";
import { listEntries } from "../store.js";

const REGISTRY = Object.freeze({ [facebook.id]: facebook });

const CONFIG_COLLECTION = "connectors";    // key = connector id  → { enabled, config, last_sync }
const METRICS_COLLECTION = "auto_metrics";  // key = `${id}:${postKey}` → metric row (merged into the dashboard)

const now = () => new Date();

export function getConnector(id) {
  return REGISTRY[id] || null;
}

/** The connector's stored state, with safe defaults if it was never configured. */
async function getConnectorState(host, id) {
  const v = await host.store.get(CONFIG_COLLECTION, id).catch(() => null);
  return v && typeof v === "object" ? v : { enabled: false, config: {}, last_sync: null };
}

/** True once every required field has a value. */
function isConfigured(def, config) {
  return !!config && def.configFields.filter((f) => f.required).every((f) => config[f.key]);
}

/**
 * Public view of every connector — for the settings UI. Secret field values are
 * masked to a placeholder so a saved token is shown as "set" but never leaks.
 */
export async function describeConnectors(host) {
  const out = [];
  for (const def of Object.values(REGISTRY)) {
    const st = await getConnectorState(host, def.id);
    const cfg = st.config || {};
    out.push({
      id: def.id,
      label: def.label,
      channel: def.channel,
      description: def.description || "",
      docsUrl: def.docsUrl || null,
      configFields: def.configFields.map((f) => ({
        key: f.key, label: f.label, type: f.type || "text",
        required: !!f.required, placeholder: f.placeholder || "", hint: f.hint || "",
        secret: !!f.secret,
        // secret → show only whether it's set; non-secret → echo the value back
        value: f.secret ? (cfg[f.key] ? "********" : "") : (cfg[f.key] ?? ""),
      })),
      configured: isConfigured(def, cfg),
      enabled: !!st.enabled,
      last_sync: st.last_sync || null,
    });
  }
  return out;
}

/**
 * Merge an incoming config from the UI with what's stored, then persist. Secret
 * fields left blank (or still showing the "********" mask) keep their saved
 * value, so the manager can re-save other fields without re-pasting the token.
 */
export async function saveConnectorConfig(host, id, incoming = {}) {
  const def = getConnector(id);
  if (!def) throw new Error(`Unknown connector: ${id}`);
  const st = await getConnectorState(host, id);
  const config = { ...(st.config || {}) };
  for (const f of def.configFields) {
    const val = incoming[f.key];
    if (f.secret && (val == null || val === "" || val === "********")) continue; // keep stored secret
    if (val !== undefined) config[f.key] = typeof val === "string" ? val.trim() : val;
  }
  const v = def.validate ? def.validate(config) : { ok: true };
  if (!v.ok) throw new Error(v.error || "Invalid connector settings.");
  await host.store.put(CONFIG_COLLECTION, id, { ...st, enabled: true, config });
  return { ok: true, connector: id, configured: isConfigured(def, config) };
}

/**
 * Run a connector now: pull its platform numbers, attribute each to a reporter,
 * and upsert the results into the auto_metrics store. Returns the last_sync
 * summary (also persisted onto the connector state).
 */
export async function runSync(host, id, { fetchImpl } = {}) {
  const def = getConnector(id);
  if (!def) throw new Error(`Unknown connector: ${id}`);
  const st = await getConnectorState(host, id);
  if (!isConfigured(def, st.config)) throw new Error("Add the connector's settings first.");

  const entries = await listEntries(host);
  let last_sync;
  try {
    const result = await def.sync({
      config: st.config,
      entries,
      fetchImpl: fetchImpl || globalThis.fetch,
    });
    const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
    let written = 0;
    for (const m of metrics) {
      const postKey = m.post_key || m.post_url;
      if (!postKey) continue;
      await host.store.put(METRICS_COLLECTION, `${id}:${postKey}`, {
        ...m, source: id, connector: id, synced_at: now().toISOString(),
      });
      written++;
    }
    last_sync = {
      at: now().toISOString(),
      fetched: result?.fetched ?? 0,
      matched: result?.matched ?? written,
      unmatched: result?.unmatched ?? 0,
      written,
      error: null,
    };
  } catch (err) {
    last_sync = { at: now().toISOString(), fetched: 0, matched: 0, unmatched: 0, written: 0, error: err.message || "sync failed" };
    await host.store.put(CONFIG_COLLECTION, id, { ...st, last_sync });
    throw err;
  }
  await host.store.put(CONFIG_COLLECTION, id, { ...st, last_sync });
  return last_sync;
}

/** Every auto-pulled metric, in the same shape report.js expects from a metric row. */
export async function listAutoMetrics(host) {
  const rows = await host.store.list(METRICS_COLLECTION).catch(() => []);
  return (rows || []).map((r) => r.value).filter(Boolean);
}
