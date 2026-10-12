import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { createDb } from "../src/db";
import {
  getArtistByMbid,
  getSetting,
  insertArtist,
  listArtists,
  setSetting,
} from "../src/db/repositories";
import { DEFAULT_POLICY, seedSettings } from "../src/db/seed";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function freshDb(): Db {
  return createDb({ dbPath: ":memory:", migrationsFolder });
}

describe("database", () => {
  let db: Db;

  beforeEach(() => {
    db = freshDb();
  });

  it("applies migrations and seeds settings once", () => {
    seedSettings(db, { LASTFM_API_KEY: "test-key" });
    seedSettings(db, { LASTFM_API_KEY: "test-key" }); // idempotent

    const integrations = getSetting<{ lastfmApiKey: string }>(db, "integrations");
    expect(integrations?.lastfmApiKey).toBe("test-key");

    const policy = getSetting<typeof DEFAULT_POLICY>(db, "policy");
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it("never overwrites settings that already exist", () => {
    seedSettings(db, {});
    setSetting(db, "policy", { ...DEFAULT_POLICY, tasteFitThreshold: 42 });

    seedSettings(db, {}); // must not clobber the edited value
    expect(getSetting<typeof DEFAULT_POLICY>(db, "policy")?.tasteFitThreshold).toBe(42);
  });

  it("round-trips artists", () => {
    const id = insertArtist(db, {
      mbid: "65f4f0c5-1a3e-4a0f-9c67-0e3f2b1a9d11",
      name: "Metallica",
      score: 3,
      catalogSize: 95,
      quota: 19,
    });
    expect(id).toBeGreaterThan(0);

    expect(getArtistByMbid(db, "65f4f0c5-1a3e-4a0f-9c67-0e3f2b1a9d11")?.name).toBe("Metallica");
    expect(listArtists(db)).toHaveLength(1);
    expect(getArtistByMbid(db, "unknown")).toBeUndefined();
  });
});
