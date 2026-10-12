import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

/**
 * SQLite via Node's built-in node:sqlite — zero native modules, so the server
 * bundles to a single file and the Docker image needs no toolchain.
 */

export function createDb(opts: { dbPath: string; migrationsFolder: string }) {
  if (opts.dbPath !== ":memory:") {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }
  const client = new DatabaseSync(opts.dbPath);
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: opts.migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof createDb>;
