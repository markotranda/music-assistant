import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectionFs } from "@ma/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { getArtistByMbid, getTrackByNorm, listPlanRows, listTracks } from "../src/db/repositories";
import { events, jobs } from "../src/db/schema";
import type { AppDeps } from "../src/deps";
import { latestMigrateReport, runMigration } from "../src/services/migrate";
import { fakeDeps } from "./fakes";

// Real files on disk — hashing and the collection adapter run for real here.
const temps: string[] = [];

function migrationDeps(files: Record<string, string[]>): ReturnType<typeof fakeDeps> {
  const root = mkdtempSync(join(tmpdir(), "ma-migrate-"));
  temps.push(root);
  const collectionDir = join(root, "collection");
  for (const [band, names] of Object.entries(files)) {
    mkdirSync(join(collectionDir, band), { recursive: true });
    for (const n of names) {
      const abs = join(collectionDir, band, n);
      writeFileSync(abs, `audio-bytes-${n}`);
      // Old mtime: the import must use it as the acquisition date.
      const old = new Date("2024-01-15T00:00:00.000Z");
      utimesSync(abs, old, old);
    }
  }
  const collection = createCollectionFs({ collectionDir, retiredDir: join(root, "retired") });
  return { ...fakeDeps(), collection } as unknown as ReturnType<typeof fakeDeps>;
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

const BANDS_CSV = `"Band","Score","MBID","StudioAlbums","Catalog","Quota","Disambig"
"Terror","1","mbid-terror","10","69","5",""
"Death","2","mbid-death","7","174","15",""`;

const PLAN_CSV = `"Band","Score","Rank","Title","Norm","Status","Source","Ext","Pinned"
"Terror","1","1","Best Song","bestsong","OWNED","Z:\\stale\\path.mp3",".mp3","False"
"Terror","1","2","Lost Song","lostsong","OWNED","","","True"
"Death","2","1","Leprosy","leprosy","DOWNLOAD","","","False"`;

describe("runMigration", () => {
  it("imports bands with quota checksums and plan rows against the real collection", async () => {
    const deps = migrationDeps({
      Terror: ["01 - Best Song.mp3", "99 - Off Plan.mp3"],
      Death: ["01 - Leprosy.mp3"],
      Ghost: ["01 - Phantom.mp3"],
    });

    const report = await runMigration(deps, { bandsCsv: BANDS_CSV, planCsv: PLAN_CSV });

    expect(report.bands.imported).toBe(2);
    expect(report.bands.quotaDiffs).toEqual([]); // legacy Quota matched our formula
    expect(report.plan).toEqual({
      imported: 3,
      alreadyImported: 0,
      owned: 2,
      planned: 1,
      pinned: 1,
    });
    expect(report.files.matched).toBe(2);
    expect(report.files.unmatched.sort()).toEqual([
      "Ghost/01 - Phantom.mp3",
      "Terror/99 - Off Plan.mp3",
    ]);
    expect(report.files.unknownBandDirs).toEqual(["Ghost"]);
    expect(report.summary).toContain("imported 2 band(s) and 3 plan row(s)");

    // Bands carry the recomputed quota; tracks carry real hashes and sizes.
    const terror = getArtistByMbid(deps.db, "mbid-terror");
    expect(terror).toMatchObject({ name: "Terror", score: 1, catalogSize: 69, quota: 5 });

    const owned = getTrackByNorm(deps.db, terror?.id ?? 0, "bestsong");
    expect(owned).toMatchObject({
      status: "OWNED",
      sizeBytes: "audio-bytes-01 - Best Song.mp3".length,
      ext: ".mp3",
      // Acquisition date comes from the file's mtime, not the import date.
      acquiredAt: "2024-01-15T00:00:00.000Z",
    });
    expect(owned?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(owned?.filePath).toContain("01 - Best Song.mp3");

    // Reality wins: "Lost Song" claims OWNED but has no file -> PLANNED, no track;
    // "Leprosy" claims DOWNLOAD but its file exists -> OWNED.
    expect(getTrackByNorm(deps.db, terror?.id ?? 0, "lostsong")).toBeUndefined();
    const death = getArtistByMbid(deps.db, "mbid-death");
    expect(getTrackByNorm(deps.db, death?.id ?? 0, "leprosy")).toMatchObject({ status: "OWNED" });
    const deathPlan = listPlanRows(deps.db, death?.id ?? 0);
    expect(deathPlan[0]).toMatchObject({ normTitle: "leprosy", status: "OWNED" });
    const terrorPlan = listPlanRows(deps.db, terror?.id ?? 0);
    expect(terrorPlan.find((p) => p.normTitle === "lostsong")?.status).toBe("PLANNED");

    // Report is durable + retrievable.
    const event = deps.db
      .select()
      .from(events)
      .all()
      .filter((e) => e.kind === "migrate_completed");
    expect(event).toHaveLength(1);
    expect(latestMigrateReport(deps)?.summary).toBe(report.summary);
  });

  it("never writes to the collection — unmatched files stay in place", async () => {
    const deps = migrationDeps({ Terror: ["01 - Best Song.mp3", "99 - Off Plan.mp3"] });
    await runMigration(deps, { bandsCsv: BANDS_CSV, planCsv: PLAN_CSV });
    // Both files still list in the band folder; retire map untouched.
    expect(
      deps.collection
        .listBandFiles("Terror")
        .map((f) => f.fileName)
        .sort(),
    ).toEqual(["01 - Best Song.mp3", "99 - Off Plan.mp3"]);
  });

  it("is safe to run twice: second run skips existing artists and rows", async () => {
    const deps = migrationDeps({ Terror: ["01 - Best Song.mp3"], Death: ["01 - Leprosy.mp3"] });
    await runMigration(deps, { bandsCsv: BANDS_CSV, planCsv: PLAN_CSV });
    const again = await runMigration(deps, { bandsCsv: BANDS_CSV, planCsv: PLAN_CSV });

    expect(again.bands.imported).toBe(0);
    expect(again.bands.skipped.sort()).toEqual(["Death", "Terror"]);
    expect(again.plan.alreadyImported).toBe(3);
    expect(listTracks(deps.db)).toHaveLength(2); // no duplicates
  });

  it("imports a bands-only file set as fresh plans (no plan.csv)", async () => {
    const deps = migrationDeps({});
    const report = await runMigration(deps, { bandsCsv: BANDS_CSV });

    expect(report.bands.imported).toBe(2);
    expect(report.plan).toEqual({
      imported: 0,
      alreadyImported: 0,
      owned: 0,
      planned: 0,
      pinned: 0,
    });
    const terror = getArtistByMbid(deps.db, "mbid-terror");
    expect(terror).toMatchObject({ score: 1, quota: 5 });
    expect(listPlanRows(deps.db, terror?.id ?? 0)).toHaveLength(0); // planned fresh later
    expect(report.summary).toContain("imported 2 band(s) and 0 plan row(s)");
  });

  it("flags legacy quota mismatches instead of trusting either side", async () => {
    const deps = migrationDeps({});
    const badQuota = BANDS_CSV.replace('"69","5"', '"69","4"');
    const report = await runMigration(deps, { bandsCsv: badQuota, planCsv: PLAN_CSV });

    expect(report.bands.quotaDiffs).toEqual([{ band: "Terror", legacyQuota: 4, computedQuota: 5 }]);
    expect(report.problems.some((p) => p.includes("quota mismatch for 'Terror'"))).toBe(true);
  });

  it("reports plan rows for unknown bands and duplicate norms instead of guessing", async () => {
    const deps = migrationDeps({});
    const report = await runMigration(deps, {
      bandsCsv: BANDS_CSV,
      planCsv:
        `"Band","Score","Rank","Title","Norm","Status","Source","Ext","Pinned"\n` +
        `"Nobody","1","1","Ghost Song","ghostsong","OWNED","","","False"\n` +
        `"Terror","1","1","Best Song","bestsong","OWNED","","","False"\n` +
        `"Terror","1","2","Best Song (live)","bestsong","OWNED","","","False"`,
    });

    expect(report.plan.imported).toBe(1); // only the first Terror row
    expect(report.problems.some((p) => p.includes("'Nobody' have no bands.csv entry"))).toBe(true);
    expect(report.problems.some((p) => p.includes("duplicate plan row for 'Terror'"))).toBe(true);
  });
});

describe("migrate API", () => {
  it("queues the job and serves the report", async () => {
    const deps = migrationDeps({ Terror: ["01 - Best Song.mp3"], Death: ["01 - Leprosy.mp3"] });
    const app = createApp(deps as unknown as AppDeps);

    const before = await (await app.request("/api/migrate/report")).json();
    expect(before.report).toBeNull();

    const res = await app.request("/api/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bandsCsv: BANDS_CSV, planCsv: PLAN_CSV }),
    });
    expect(res.status).toBe(202);
    const queued = await res.json();
    expect(typeof queued.jobId).toBe("number");
    expect(
      deps.db
        .select()
        .from(jobs)
        .all()
        .some((j) => j.type === "migrate" && j.status === "pending"),
    ).toBe(true);

    // Until the worker runs the job there is no report; after it, there is.
    await runMigration(deps, { bandsCsv: BANDS_CSV, planCsv: PLAN_CSV });
    const after = await (await app.request("/api/migrate/report")).json();
    expect(after.report.summary).toContain("imported 2 band(s)");
  });
});
