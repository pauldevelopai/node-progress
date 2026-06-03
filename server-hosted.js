/**
 * server-hosted.js — the ONLINE (multi-tenant) entry for Progress Tracker.
 *
 * The runtime's createHostedServer provides everything shared: tracker-cookie
 * auth, a per-request newsroom-scoped Postgres host, the standard /api/* route
 * map, the activity log + key/value store tables, and the injected GROUNDED
 * chrome (/nodes/chrome.js) + "run it locally" footer. We add this Node's data
 * tables (ensureSchema) and its write routes (mountRoutes). index.js is the
 * laptop mirror of this.
 *
 * Env (box .env, never committed): JWT_SECRET (matches the tracker's),
 * ANTHROPIC_API_KEY (shared), DATABASE_URL or PG*. Optional: PORT, MODEL.
 */

import dotenv from "dotenv";
dotenv.config({ override: true }); // the box's .env wins over any stale pm2 env
// Tell the handlers the AI key is server-managed (skip the local .env setup flow).
process.env.GROUNDED_HOSTED = "1";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHostedServer } from "@developai/grounded-node-runtime";
import * as handlers from "./lib/handlers.js";
import { ensureSchema } from "./lib/schema.js";
import { mountProgressRoutes } from "./lib/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

await createHostedServer({
  slug: "progress",
  productName: "Progress Tracker",
  handlers,
  ensureSchema,
  // Write routes; hostFor(req) gives a per-request, newsroom-scoped host.
  mountRoutes: (app, { hostFor }) => mountProgressRoutes(app, hostFor),
  nodeVersion: pkg.version,
  staticDir: join(__dirname, "public"),
});
