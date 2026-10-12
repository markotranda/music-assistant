import { join } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { createDb } from "./db/index.js";
import { seedSettings } from "./db/seed.js";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.MA_DATA_DIR ?? "./data";

const db = createDb({
  dbPath: join(dataDir, "music-assistant.db"),
  migrationsFolder: process.env.MA_MIGRATIONS_DIR ?? "./drizzle",
});
seedSettings(db, process.env);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`music-assistant listening on http://localhost:${info.port}`);
  console.log(`database ready (${join(dataDir, "music-assistant.db")})`);
});
