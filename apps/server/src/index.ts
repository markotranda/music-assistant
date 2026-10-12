import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/index.js";
import { seedSettings } from "./db/seed.js";
import { createDeps } from "./deps.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { startScheduler } from "./jobs/scheduler.js";
import { createWorker } from "./jobs/worker.js";

// Local dev convenience: load .env if present (Docker injects env directly).
// Settings in the DB remain the source of truth after first seeding.
for (const candidate of [".env", "../../.env"]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.MA_DATA_DIR ?? "./data";

const db = createDb({
  dbPath: join(dataDir, "music-assistant.db"),
  migrationsFolder: process.env.MA_MIGRATIONS_DIR ?? "./drizzle",
});
seedSettings(db, process.env);

const deps = createDeps(db, process.env);
const app = createApp(deps);

// Durable job worker: downloads survive restarts, orphaned jobs re-queue.
const worker = createWorker(deps, createJobHandlers(deps));
worker.start();

// Recurring trends jobs (scrobble sync, release radar, discovery) — due-based.
startScheduler(deps);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`music-assistant listening on http://localhost:${info.port}`);
  console.log(`database ready (${join(dataDir, "music-assistant.db")})`);
});
