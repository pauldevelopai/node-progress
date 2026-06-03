/**
 * Progress Tracker — the Node's LOCAL entry point.
 *
 * The whole boot for a laptop install. Everything interesting lives in lib/
 * (store, report, parse-report, handlers, routes) and public/ (the dashboard).
 * The runtime handles routing, the standard /api/* surface, and serving; we add
 * the write routes (roster / entries / daily-report / metrics) on top.
 *
 * Branding is newsroom-driven: set NEWSROOM in the environment to label the
 * dashboard (e.g. NEWSROOM="MakanDay"). Once set it's remembered in the Node's
 * meta, so it sticks across restarts even without the env var.
 */

import "dotenv/config";
import { createLiteHost, createServer } from "@developai/grounded-node-runtime";
import * as handlers from "./lib/handlers.js";
import { mountProgressRoutes } from "./lib/routes.js";
import { maybeSendBeacon } from "./lib/beacon.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const SLUG = "progress";
const PRODUCT = "Progress Tracker";

const host = createLiteHost({
  appSlug: SLUG,
  nodeVersion: pkg.version,
  newsroom: process.env.NEWSROOM,   // undefined → falls back to saved meta, then null
});

const newsroom = host.meta?.newsroom;

const app = createServer({
  slug: SLUG,
  host,
  handlers,
  displayName: newsroom ? `${newsroom} ${PRODUCT}` : PRODUCT,
  nodeVersion: pkg.version,
});

// The write routes — mounted on the returned express app so they sit alongside
// the runtime's standard routes. getHost is a function so the same routes work
// hosted (per-request host); locally it's the one fixed host.
mountProgressRoutes(app, () => host);

// Identified local-install telemetry — ON by default; opt out with
// GROUNDED_TELEMETRY=off. Fire-and-forget: never blocks or breaks the app.
// Sends only an install id, version, OS, the newsroom name, and activity
// counts — never reporter names or report text.
maybeSendBeacon({ host, slug: SLUG }).catch(() => {});
