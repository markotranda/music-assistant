import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DownloadRequest, YtDlpApi } from "@ma/integrations";
import { createCollectionFs } from "@ma/integrations";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  claimNextJob,
  enqueueJobRow,
  getTrackByNorm,
  insertArtist,
  listJobs,
  listPlanRows,
  requeueRunningJobs,
  upsertTrack,
} from "../src/db/repositories";
import { events } from "../src/db/schema";
import type { AppDeps } from "../src/deps";
import { createJobHandlers } from "../src/jobs/handlers";
import { createWorker } from "../src/jobs/worker";
import { trackBand } from "../src/services/bands";
import { verifyBand } from "../src/services/verify";
import { fakeDeps, syntheticRanked } from "./fakes";

const sampleMp3 = fileURLToPath(
  new URL("../../../packages/integrations/test/fixtures/sample.mp3", import.meta.url),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("job worker", () => {
  it("runs jobs, marks them done, and records handler errors with backoff", async () => {
    const deps = fakeDeps();
    let calls = 0;
    const worker = createWorker(
      deps,
      {
        flaky: async () => {
          calls += 1;
          if (calls < 2) throw new Error("upstream 503");
        },
      },
      { maxAttempts: 3, backoffMs: 250 },
    );
    enqueueJobRow(deps.db, "flaky", { x: 1 });

    await worker.drain(); // attempt 1 fails -> re-queued with backoff
    let job = listJobs(deps.db)[0];
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.error).toContain("upstream 503");

    await sleep(350); // must exceed backoffMs so the retry is claimable
    await worker.drain(); // attempt 2 succeeds
    job = listJobs(deps.db)[0];
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(job.finishedAt).not.toBeNull();
  });

  it("fails jobs permanently after maxAttempts, keeping the real error", async () => {
    const deps = fakeDeps();
    const worker = createWorker(
      deps,
      {
        broken: async () => {
          throw new Error("no audio produced after 6 attempts");
        },
      },
      { maxAttempts: 2, backoffMs: 1 },
    );
    enqueueJobRow(deps.db, "broken", {});

    await worker.drain();
    await sleep(5);
    await worker.drain();

    const job = listJobs(deps.db)[0];
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    expect(job.error).toContain("no audio produced");
  });

  it("fails unknown job types immediately and re-queues orphaned jobs on boot", async () => {
    const deps = fakeDeps();
    enqueueJobRow(deps.db, "mystery", {});

    const worker = createWorker(deps, {}, {});
    await worker.drain();
    expect(listJobs(deps.db)[0].status).toBe("failed");
    expect(listJobs(deps.db)[0].error).toContain("no handler registered");

    // Simulate a crash mid-job: `running` rows re-queue at startup.
    enqueueJobRow(deps.db, "mystery", { a: 1 });
    claimNextJob(deps.db);
    expect(requeueRunningJobs(deps.db)).toBe(1);
    expect(listJobs(deps.db, { status: "pending" })).toHaveLength(1);
  });

  it("dedupes identical pending jobs (re-syncs must not pile up downloads)", async () => {
    const deps = fakeDeps();
    expect(enqueueJobRow(deps.db, "download", { norm: "a" })).not.toBeNull();
    expect(enqueueJobRow(deps.db, "download", { norm: "a" })).toBeNull();
    expect(enqueueJobRow(deps.db, "download", { norm: "b" })).not.toBeNull();
  });
});

/** Real collection fs on temp dirs + a fake yt-dlp that "downloads" sample.mp3. */
function downloadDeps(opts: { failDownload?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-dl-"));
  const base = fakeDeps({ ranked: syntheticRanked(30) });
  const collection = createCollectionFs({
    collectionDir: join(root, "collection"),
    retiredDir: join(root, "retired"),
  });
  const requests: DownloadRequest[] = [];
  const ytdlp: YtDlpApi = {
    download: async (req) => {
      requests.push(req);
      if (opts.failDownload) {
        return {
          ok: false,
          attempts: [
            { query: "ytsearch1:x", playerClient: null, code: 1, summary: "HTTP Error 403" },
          ],
          error: "no audio produced after 1 attempts (last: HTTP Error 403)",
        };
      }
      mkdirSync(dirname(req.destBase), { recursive: true });
      copyFileSync(sampleMp3, `${req.destBase}.mp3`);
      return { ok: true, filePath: `${req.destBase}.mp3`, attempts: [] };
    },
  } as YtDlpApi;
  return { deps: { ...base, collection, ytdlp } as AppDeps, requests, collection };
}

describe("plan_all job handler", () => {
  it("syncs every tracked band and records the honest summary", async () => {
    const deps = fakeDeps();
    await trackBand(deps, { name: "Terror", score: 1 });
    await trackBand(deps, { name: "Madball", score: 2 });
    enqueueJobRow(deps.db, "plan_all", {});

    const worker = createWorker(deps, createJobHandlers(deps), { maxAttempts: 1, backoffMs: 1 });
    await worker.drain();

    expect(listJobs(deps.db, { status: "done" }).filter((j) => j.type === "plan_all")).toHaveLength(
      1,
    );

    const evt = deps.db.select().from(events).where(eq(events.kind, "plan_all")).all()[0];
    const payload = JSON.parse(evt?.payloadJson ?? "{}") as { bands: number; errors: unknown[] };
    expect(payload.bands).toBe(2);
    expect(payload.errors).toEqual([]);
  });

  it("fails with the real reason when every band fails to sync", async () => {
    const deps = fakeDeps({ ranked: [] });
    insertArtist(deps.db, { name: "Terror", mbid: "mbid-terror", score: 1, quota: 5 });
    enqueueJobRow(deps.db, "plan_all", {});

    const worker = createWorker(deps, createJobHandlers(deps), { maxAttempts: 1, backoffMs: 1 });
    await worker.drain();

    const failed = listJobs(deps.db, { status: "failed" }).filter((j) => j.type === "plan_all");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("every band failed to sync");
    expect(failed[0]?.error).toContain("no usable ranked tracks");
  });
});

describe("download job handler", () => {
  it("acquires, canonically retags, verifies the tags, and records hash/duration", async () => {
    const { deps, requests } = downloadDeps();
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const worker = createWorker(deps, createJobHandlers(deps), { maxAttempts: 1, backoffMs: 1 });
    await worker.drain();

    // The fake yt-dlp got the legacy-style request.
    expect(requests[0]?.band).toBe("Terror");
    expect(requests[0]?.title).toBe("Song 01");
    expect(requests[0]?.destBase).toContain("01 - Song 01");

    const rows = listPlanRows(deps.db, artist.id);
    expect(rows.every((r) => r.status === "OWNED")).toBe(true);

    const track = getTrackByNorm(deps.db, artist.id, "song01");
    expect(track?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(track?.durationS).toBe(1);
    expect(track?.status).toBe("OWNED");

    expect(listJobs(deps.db, { status: "done" })).toHaveLength(7);
  });

  it("is idempotent: tracks already on disk are not re-downloaded", async () => {
    const { deps, requests, collection } = downloadDeps();
    await trackBand(deps, { name: "Terror", score: 1 });
    // Simulate a previous successful run for one track.
    mkdirSync(collection.bandDir("Terror"), { recursive: true });
    copyFileSync(sampleMp3, join(collection.bandDir("Terror"), "01 - Song 01.mp3"));

    const worker = createWorker(deps, createJobHandlers(deps), { maxAttempts: 1, backoffMs: 1 });
    await worker.drain();

    expect(requests).toHaveLength(6); // 7 planned, 1 already on disk
  });

  it("fails jobs with the real yt-dlp reason and marks plan rows FAILED", async () => {
    const { deps } = downloadDeps({ failDownload: true });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const worker = createWorker(deps, createJobHandlers(deps), { maxAttempts: 1, backoffMs: 1 });
    await worker.drain();

    const failed = listJobs(deps.db, { status: "failed" });
    expect(failed).toHaveLength(7);
    expect(failed[0]?.error).toContain("403");

    expect(listPlanRows(deps.db, artist.id).every((r) => r.status === "FAILED")).toBe(true);
  });
});

describe("deep verify", () => {
  it("catches renamed, replaced, missing, corrupt, and surplus files (legacy verified counts only)", async () => {
    const { deps, collection } = downloadDeps();
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const bandDir = collection.bandDir("Terror");
    mkdirSync(bandDir, { recursive: true });

    // song01: valid file but content hash differs from the recorded one -> replaced
    copyFileSync(sampleMp3, join(bandDir, "01 - Song 01.mp3"));
    upsertTrack(deps.db, {
      artistId: artist.id,
      title: "Song 01",
      norm: "song01",
      rank: 1,
      pinned: false,
      status: "OWNED",
      filePath: join(bandDir, "01 - Song 01.mp3"),
      ext: ".mp3",
      durationS: 1,
      hash: "deadbeef",
    });

    // song02: missing (no file)
    // song03: wrong rank prefix -> renamed
    copyFileSync(sampleMp3, join(bandDir, "05 - Song 03.mp3"));
    // song04: not audio -> corrupt
    writeFileSync(join(bandDir, "04 - Song 04.mp3"), "not audio");
    // song05-07: clean copies
    for (const n of ["05", "06", "07"]) {
      copyFileSync(sampleMp3, join(bandDir, `${n} - Song ${n}.mp3`));
    }
    // uninvited guest -> surplus
    copyFileSync(sampleMp3, join(bandDir, "99 - Junk.mp3"));

    const report = await verifyBand(deps, artist.id);
    expect(report.ok).toBe(false);
    const kinds = report.issues.map((i) => i.type).sort();
    expect(kinds).toEqual(["corrupt", "missing", "renamed", "replaced", "surplus"]);

    const byType = Object.fromEntries(report.issues.map((i) => [i.type, i]));
    expect(byType.replaced?.norm).toBe("song01");
    expect(byType.replaced?.detail).toContain("hash changed");
    expect(byType.missing?.norm).toBe("song02");
    expect(byType.renamed?.fileName).toBe("05 - Song 03.mp3");
    expect(byType.renamed?.expected).toBe("03 - Song 03.mp3");
    expect(byType.corrupt?.norm).toBe("song04");
    expect(byType.surplus?.fileName).toBe("99 - Junk.mp3");
  });

  it("reports clean when plan equals folder", async () => {
    const { deps, collection } = downloadDeps();
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const bandDir = collection.bandDir("Terror");
    mkdirSync(bandDir, { recursive: true });
    for (let n = 1; n <= 7; n += 1) {
      copyFileSync(
        sampleMp3,
        join(bandDir, `${String(n).padStart(2, "0")} - Song ${String(n).padStart(2, "0")}.mp3`),
      );
    }
    const report = await verifyBand(deps, artist.id);
    expect(report).toMatchObject({ ok: true, issues: [], planCount: 7, onDiskCount: 7 });
  });
});
