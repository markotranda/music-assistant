import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  insertScrobbles,
  listCandidates,
  listPlanRows,
  replaceArtistTags,
  setSetting,
  upsertTrack,
} from "../src/db/repositories";
import { events, tracks } from "../src/db/schema";
import { runDueSchedules } from "../src/jobs/scheduler";
import { syncBand, trackBand } from "../src/services/bands";
import { runDiscovery } from "../src/services/discovery";
import { applyPrune, pruneReport, simulate, syncTrackPlayData } from "../src/services/policy";
import { runReleaseRadar } from "../src/services/releases";
import { fakeDeps, syntheticRanked } from "./fakes";

const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

function ownedTrack(
  deps: ReturnType<typeof fakeDeps>,
  artistId: number,
  input: { title: string; norm: string; acquiredAt?: string },
): number {
  const id = upsertTrack(deps.db, {
    artistId,
    title: input.title,
    norm: input.norm,
    rank: 1,
    pinned: false,
    status: "OWNED",
    filePath: `Terror/${input.title}.mp3`,
    ext: "mp3",
    durationS: 180,
    hash: `hash-${input.norm}`,
    sizeBytes: 1_000_000,
  });
  if (input.acquiredAt) {
    deps.db.update(tracks).set({ acquiredAt: input.acquiredAt }).where(eq(tracks.id, id)).run();
  }
  return id;
}

describe("policy gates on candidates", () => {
  it("rejects below-threshold candidates at creation with the reason logged", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: { Terror: [{ name: "Comeback Kid", mbid: null, match: 0.9 }] },
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    setSetting(deps.db, "policy", {
      approvalMode: "manual",
      tasteFitThreshold: 95,
      autoApproveFit: 85,
      bandHardMaxTracks: 40,
      genreSoftCapShare: 0.5,
      monthlyAcquisitionBudgetTracks: 40,
      maxTotalTracks: 5000,
      maxTotalGb: 50,
      decayMonths: 12,
      rotationEnabled: true,
      pruneReportEnabled: true,
      autoPruneEnabled: false,
    });

    const result = await runDiscovery(deps);
    expect(result.created).toBe(0);
    expect(result.gated).toBe(1);
    expect(listCandidates(deps.db)).toHaveLength(0);

    const gated = deps.db
      .select()
      .from(events)
      .all()
      .filter((e) => e.kind === "candidate_gated");
    expect(gated).toHaveLength(1);
    expect(gated[0].payloadJson).toContain("taste-fit 90 < threshold 95");
  });

  it("gates releases for bands already at their hard planned cap", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    await trackBand(deps, { name: "Terror", score: 1 }); // quota 7 planned
    setSetting(deps.db, "policy", {
      approvalMode: "manual",
      tasteFitThreshold: 70,
      autoApproveFit: 85,
      bandHardMaxTracks: 3,
      genreSoftCapShare: 0.5,
      monthlyAcquisitionBudgetTracks: 40,
      maxTotalTracks: 5000,
      maxTotalGb: 50,
      decayMonths: 12,
      rotationEnabled: true,
      pruneReportEnabled: true,
      autoPruneEnabled: false,
    });
    deps.musicbrainz.getRecentReleaseGroups = async () => [
      {
        id: "rg-1",
        title: "New Record",
        firstReleaseDate: yesterday,
        primaryType: "Album",
        secondaryTypes: [],
      },
    ];

    const result = await runReleaseRadar(deps);
    expect(result.created).toBe(0);
    expect(result.gated).toBe(1);
    expect(listCandidates(deps.db)).toHaveLength(0);
  });

  it("soft-penalizes over-represented genres in the score and the reason", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: { Terror: [{ name: "Comeback Kid", mbid: null, match: 0.9 }] },
      tags: { "Comeback Kid": ["hardcore"] },
    });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    // Terror owns 100% of the planned library under "hardcore" (> 0.5 soft cap).
    replaceArtistTags(deps.db, artist.id, ["hardcore"]);

    await runDiscovery(deps);
    const [candidate] = listCandidates(deps.db);
    expect(candidate.tasteFit).toBe(75); // 90 - 15 genre balance
    expect(candidate.reason).toContain("−15 genre balance");
    expect(candidate.status).toBe("pending"); // soft gate never blocks
  });
});

describe("approval modes", () => {
  it("hybrid auto-approves high-fit candidates at score 1, queues the rest", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: {
        Terror: [
          { name: "Comeback Kid", mbid: null, match: 0.9 }, // fit 90 -> auto
          { name: "Mid Band", mbid: null, match: 0.78 }, // fit 78 -> queued
        ],
      },
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    setSetting(deps.db, "policy", {
      approvalMode: "hybrid",
      tasteFitThreshold: 70,
      autoApproveFit: 85,
      bandHardMaxTracks: 40,
      genreSoftCapShare: 0.5,
      monthlyAcquisitionBudgetTracks: 40,
      maxTotalTracks: 5000,
      maxTotalGb: 50,
      decayMonths: 12,
      rotationEnabled: true,
      pruneReportEnabled: true,
      autoPruneEnabled: false,
    });

    await runDiscovery(deps);

    const rows = listCandidates(deps.db);
    expect(rows).toHaveLength(2);
    const auto = rows.find((r) => r.payloadJson.includes("Comeback Kid"));
    const manual = rows.find((r) => r.payloadJson.includes("Mid Band"));
    expect(auto?.status).toBe("approved");
    expect(manual?.status).toBe("pending");

    // Auto-approved related artists land at score 1 (casual quota).
    const { listArtists } = await import("../src/db/repositories");
    const tracked = listArtists(deps.db).find((a) => a.name === "Comeback Kid");
    expect(tracked?.score).toBe(1);
  });
});

describe("acquisition budgets", () => {
  it("hard-blocks downloads past the global track budget with a logged reason", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    setSetting(deps.db, "policy", {
      approvalMode: "manual",
      tasteFitThreshold: 70,
      autoApproveFit: 85,
      bandHardMaxTracks: 40,
      genreSoftCapShare: 0.5,
      monthlyAcquisitionBudgetTracks: 40,
      maxTotalTracks: 7,
      maxTotalGb: 50,
      decayMonths: 12,
      rotationEnabled: true,
      pruneReportEnabled: true,
      autoPruneEnabled: false,
    });
    // Five tracks already owned -> only 2 slots of headroom remain.
    for (let i = 1; i <= 5; i++) {
      ownedTrack(deps, artist.id, { title: `Owned ${i}`, norm: `owned${i}` });
    }

    // Drop the jobs enqueued at track time so only this sync's batch counts.
    const { jobs } = await import("../src/db/schema");
    deps.db.delete(jobs).run();
    await syncBand(deps, artist.id, { apply: true });

    const downloads = deps.db
      .select()
      .from(jobs)
      .all()
      .filter((j) => j.type === "download" && j.status === "pending");
    expect(downloads).toHaveLength(2);

    const blocked = deps.db
      .select()
      .from(events)
      .all()
      .filter((e) => e.kind === "acquisition_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payloadJson).toContain("global track budget reached (5/7 owned)");
  });
});

describe("decay, prune and rotation", () => {
  it("fills play data from scrobbles and proposes idle tracks with reasons", async () => {
    const deps = fakeDeps({
      files: { Terror: ["01 - Old Song.mp3", "02 - Fresh.mp3"] },
    });
    // Insert the artist directly: trackBand's reconcile would retire the
    // seeded files as off-plan (they are — this test is about decay, not sync).
    const { insertArtist } = await import("../src/db/repositories");
    const artistId = insertArtist(deps.db, {
      name: "Terror",
      mbid: "mbid-terror",
      score: 1,
      catalogSize: 139,
      quota: 7,
    });
    ownedTrack(deps, artistId, {
      title: "Old Song",
      norm: "oldsong",
      acquiredAt: "2024-01-01T00:00:00.000Z",
    });
    ownedTrack(deps, artistId, {
      title: "Fresh",
      norm: "fresh",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    });

    // "Fresh" was played this month; "Old Song" only 2 years ago.
    insertScrobbles(deps.db, [
      {
        artistName: "Terror",
        title: "Fresh",
        album: null,
        playedAt: new Date().toISOString(),
      },
      {
        artistName: "Terror",
        title: "Old Song",
        album: null,
        playedAt: "2024-02-01T00:00:00.000Z",
      },
      {
        artistName: "Terror",
        title: "Old Song",
        album: null,
        playedAt: "2024-01-15T00:00:00.000Z",
      },
    ]);

    const updated = syncTrackPlayData(deps);
    expect(updated).toBe(2);
    const { getTrackByNorm } = await import("../src/db/repositories");
    expect(getTrackByNorm(deps.db, artistId, "oldsong")).toMatchObject({
      playCount: 2,
      lastPlayed: "2024-02-01T00:00:00.000Z",
    });

    const report = pruneReport(deps);
    expect(report.proposals.map((p) => p.norm)).toEqual(["oldsong"]);
    expect(report.proposals[0].reason).toContain("last played");
    expect(report.summary).toContain("1 track idle over 12 months");

    // Apply: the file retires to _retired (fake fs) and the plan row drops.
    const pin = await import("../src/services/bands");
    pin.pinTrack(deps, artistId, "Old Song"); // ensure a plan row to drop
    const result = applyPrune(deps, { norms: ["oldsong"] });
    expect(result.retired).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(deps.collection.retired.get("Terror")).toContain("01 - Old Song.mp3");
    expect(listPlanRows(deps.db, artistId).some((p) => p.normTitle === "oldsong")).toBe(false);
  });

  it("rotates rank prefixes by own plays with collision-free renames", async () => {
    const deps = fakeDeps({
      ranked: [
        { name: "Global Hit", plays: 1000 },
        { name: "My Jam", plays: 100 },
      ],
      catalog: { albums: 2, catalog: 2, method: "test" },
      files: { Terror: ["01 - Global Hit.mp3", "02 - My Jam.mp3"] },
    });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const jamId = ownedTrack(deps, artist.id, { title: "My Jam", norm: "myjam" });
    const hitId = ownedTrack(deps, artist.id, { title: "Global Hit", norm: "globalhit" });

    // My Jam is your most-played track: 200 plays * 5 = 1000 boost -> rank 1.
    const { updateTrackPlayData } = await import("../src/db/repositories");
    updateTrackPlayData(deps.db, jamId, {
      playCount: 200,
      lastPlayed: "2026-10-01T00:00:00.000Z",
    });
    updateTrackPlayData(deps.db, hitId, {
      playCount: 1,
      lastPlayed: "2024-01-01T00:00:00.000Z",
    });

    const result = await syncBand(deps, artist.id, {
      apply: true,
      rankBlend: "own_plays",
    });

    const desired = result.desired;
    expect(desired[0]).toMatchObject({ norm: "myjam", rank: 1 });
    expect(desired[1]).toMatchObject({ norm: "globalhit", rank: 2 });
    expect(result.renames).toHaveLength(2);
    expect(result.renames.map((r) => r.to).sort()).toEqual([
      "01 - My Jam.mp3",
      "02 - Global Hit.mp3",
    ]);
  });
});

describe("policy API", () => {
  it("serves the policy state, prune report and simulator", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    ownedTrack(deps, artist.id, {
      title: "Old Song",
      norm: "oldsong",
      acquiredAt: "2024-01-01T00:00:00.000Z",
    });
    replaceArtistTags(deps.db, artist.id, ["hardcore"]);
    const app = createApp(deps);

    const overview = await (await app.request("/api/policy")).json();
    expect(overview.budget.allowed).toBe(true);
    expect(overview.genreShares.hardcore).toBe(1);
    expect(overview.policy.bandHardMaxTracks).toBe(40);

    const report = await (await app.request("/api/policy/prune-report")).json();
    expect(report.proposals.map((p: { norm: string }) => p.norm)).toEqual(["oldsong"]);

    const sim = await (
      await app.request("/api/policy/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scoreChanges: { Terror: 3 } }),
      })
    ).json();
    // Terror 1 -> 3 at catalog 139: quota 7 -> 24 (legacy formula + banker's rounding).
    expect(sim.changes[0]).toMatchObject({
      artist: "Terror",
      quotaBefore: 7,
      quotaAfter: 24,
      deltaTracks: 17,
    });
    expect(sim.summary).toContain("7→24");
  });

  it("projects policy patches with the pure simulator", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    await trackBand(deps, { name: "Terror", score: 1 });
    const sim = simulate(deps, {
      scoreChanges: { terror: 2 },
      policyPatch: { bandHardMaxTracks: 10 },
    });
    expect(sim.changes[0]).toMatchObject({ artist: "Terror", scoreAfter: 2 });
    expect(sim.policy.bandHardMaxTracks).toBe(10);
  });

  it("round-trips the new policy settings fields", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request("/api/settings/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvalMode: "hybrid",
        autoApproveFit: 90,
        bandHardMaxTracks: 25,
        genreSoftCapShare: 0.3,
        autoPruneEnabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.policy).toMatchObject({
      approvalMode: "hybrid",
      autoApproveFit: 90,
      bandHardMaxTracks: 25,
      genreSoftCapShare: 0.3,
      autoPruneEnabled: true,
      tasteFitThreshold: 70, // untouched
    });
  });

  it("honors policy switches in the scheduler", () => {
    const deps = fakeDeps();
    const t0 = Date.parse("2026-10-12T00:00:00.000Z");
    setSetting(deps.db, "policy", {
      approvalMode: "manual",
      tasteFitThreshold: 70,
      autoApproveFit: 85,
      bandHardMaxTracks: 40,
      genreSoftCapShare: 0.5,
      monthlyAcquisitionBudgetTracks: 40,
      maxTotalTracks: 5000,
      maxTotalGb: 50,
      decayMonths: 12,
      rotationEnabled: false,
      pruneReportEnabled: false,
      autoPruneEnabled: false,
    });

    const first = runDueSchedules(deps, t0);
    expect(first).toEqual(["scrobble_sync", "release_radar", "discovery"]);
  });
});
