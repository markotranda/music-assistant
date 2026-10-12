import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { countScrobbles, listCandidates, listPlanRows, setSetting } from "../src/db/repositories";
import { artists, events, jobs } from "../src/db/schema";
import { runDueSchedules } from "../src/jobs/scheduler";
import { trackBand } from "../src/services/bands";
import {
  approveCandidate,
  createCandidateIfNew,
  ignoreArtist,
  listCandidateViews,
  rejectCandidate,
} from "../src/services/candidates";
import { buildDigest } from "../src/services/digest";
import { runDiscovery } from "../src/services/discovery";
import { runReleaseRadar } from "../src/services/releases";
import { ingestScrobbles, scrobbleStats } from "../src/services/scrobbles";
import { readProfile, recomputeTasteProfile, scoringProfile } from "../src/services/taste";
import { fakeDeps, syntheticRanked } from "./fakes";

const scrobbles = [
  {
    artist: "Terror",
    title: "Overcome",
    album: "Keepers of the Faith",
    playedAt: "2026-10-01T10:00:00.000Z",
  },
  { artist: "Terror", title: "Spit My Rage", album: null, playedAt: "2026-10-01T11:00:00.000Z" },
  {
    artist: "Death",
    title: "Crystal Mountain",
    album: "Symbolic",
    playedAt: "2026-10-02T10:00:00.000Z",
  },
];

describe("scrobble ingestion", () => {
  it("imports the full history once, ignoring duplicates across pages", async () => {
    const deps = fakeDeps({
      scrobbles,
      scrobblePages: 3, // every page serves the same rows -> dedupe is under test
      tags: { Terror: ["hardcore", "punk"], Death: ["death metal"] },
    });

    const result = await ingestScrobbles(deps, { full: true });
    expect(result).toMatchObject({ imported: 3, scanned: 9, total: 3, full: true });
    expect(countScrobbles(deps.db)).toBe(3);

    // Re-running the same import adds nothing.
    const again = await ingestScrobbles(deps, { full: true });
    expect(again.imported).toBe(0);
    expect(countScrobbles(deps.db)).toBe(3);
  });

  it("refuses to run without a configured Last.fm username", async () => {
    const deps = fakeDeps();
    setSetting(deps.db, "integrations", {
      lastfmApiKey: "test-key",
      lastfmUsername: "",
      musicbrainzUserAgent: "test",
      deezerEnabled: true,
    });
    await expect(ingestScrobbles(deps)).rejects.toThrow(/username not configured/i);
  });

  it("recomputes the taste profile after import", async () => {
    const deps = fakeDeps({
      scrobbles,
      tags: { Terror: ["hardcore", "punk"], Death: ["death metal"] },
    });
    await ingestScrobbles(deps, { full: true });

    const profile = readProfile(deps);
    // 2 Terror plays vs 1 Death play -> hardcore leads the genre weights.
    expect(profile.genreWeights.hardcore).toBe(1);
    expect(profile.genreWeights.punk).toBe(1);
    expect(profile.genreWeights["death metal"]).toBe(0.5);
    expect(profile.updatedAt).not.toBeNull();

    const stats = scrobbleStats(deps);
    expect(stats.total).toBe(3);
    expect(stats.topArtists[0]).toEqual({ artistName: "Terror", plays: 2 });
    expect(stats.lastPlayedAt).toBe("2026-10-02T10:00:00.000Z");
  });

  it("degrades tag lookups with a logged reason, never silently", async () => {
    const deps = fakeDeps({ scrobbles });
    deps.lastfm.getTopTags = async () => {
      throw new Error("tags down");
    };
    await ingestScrobbles(deps, { full: true });
    const logged = deps.db.select().from(events).all();
    expect(logged.some((e) => e.kind === "taste_tags_degraded")).toBe(true);
    expect(
      logged.some((e) => e.kind === "taste_tags_degraded" && e.payloadJson.includes("tags down")),
    ).toBe(true);
  });
});

describe("taste profile", () => {
  it("weights tracked-band scores alongside plays", async () => {
    const deps = fakeDeps({ scrobbles, tags: { Terror: ["hardcore"] } });
    await ingestScrobbles(deps, { full: true });
    await trackBand(deps, { name: "Terror", score: 3 }); // +150 weight
    await recomputeTasteProfile(deps);

    const profile = readProfile(deps);
    // Terror: 2 plays + 3*50 = 152; Death: 1 play. Affinity normalized to 1.
    const scoring = scoringProfile(deps);
    expect(scoring.bandAffinity.terror).toBe(1);
    expect(scoring.bandAffinity.death).toBeCloseTo(1 / 152, 5);
    expect(profile.genreWeights.hardcore).toBe(1);
  });
});

describe("discovery feed", () => {
  it("creates related candidates with scores and reasons; dedupes and skips tracked acts", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: {
        Terror: [
          { name: "Comeback Kid", mbid: null, match: 0.9 },
          { name: "Death", mbid: null, match: 0.5 }, // already tracked below
        ],
      },
      tags: {
        Terror: ["hardcore", "punk"],
        "Comeback Kid": ["hardcore", "punk"],
        Death: ["death metal"],
      },
      scrobbles,
    });
    await trackBand(deps, { name: "Terror", score: 2 });
    await trackBand(deps, { name: "Death", score: 1 });
    await recomputeTasteProfile(deps);

    const first = await runDiscovery(deps);
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(1); // Death is tracked

    const candidates = listCandidateViews(deps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ type: "related", tasteFit: expect.any(Number) });
    expect(candidates[0].reason).toContain("similar to Terror");
    expect(candidates[0].payload).toMatchObject({ name: "Comeback Kid" });

    // Second run: everything already exists.
    const second = await runDiscovery(deps);
    expect(second.created).toBe(0);
    expect(listCandidateViews(deps)).toHaveLength(1);
  });

  it("honors the never-suggest blocklist", async () => {
    const deps = fakeDeps({
      similar: { Terror: [{ name: "Bad Act", mbid: null, match: 0.9 }] },
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    ignoreArtist(deps, "bad act");

    const result = await runDiscovery(deps);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("surfaces WHY when every seed fails", async () => {
    const deps = fakeDeps();
    await trackBand(deps, { name: "Terror", score: 1 });
    deps.lastfm.getSimilarArtists = async () => {
      throw new Error("lastfm down");
    };
    await expect(runDiscovery(deps)).rejects.toThrow(/lastfm down/);
  });
});

describe("release radar", () => {
  it("turns recent release-groups into candidates, once per release", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    deps.musicbrainz.getRecentReleaseGroups = async () => [
      {
        id: "rg-1",
        title: "New Record",
        firstReleaseDate: yesterday,
        primaryType: "Album",
        secondaryTypes: [],
      },
    ];

    const first = await runReleaseRadar(deps);
    expect(first).toMatchObject({ created: 1, found: 1, artistsChecked: 1 });

    const candidates = listCandidateViews(deps);
    expect(candidates[0]).toMatchObject({
      type: "new_release",
      reason: `Terror released New Record (${yesterday})`,
    });
    expect(candidates[0].payload).toMatchObject({
      artistName: "Terror",
      rgMbid: "rg-1",
    });
    expect(listCandidates(deps.db)[0].artistId).toBe(artist.id);

    const second = await runReleaseRadar(deps);
    expect(second.created).toBe(0); // deduped by release-group MBID
    expect(listCandidateViews(deps)).toHaveLength(1);
  });
});

describe("candidate lifecycle", () => {
  async function relatedCandidate() {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: { Terror: [{ name: "Comeback Kid", mbid: null, match: 0.9 }] },
      tags: { Terror: ["hardcore"], "Comeback Kid": ["hardcore"] },
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    await runDiscovery(deps);
    return { deps, id: listCandidates(deps.db)[0].id };
  }

  it("approves a related artist as a tracked band with the chosen score", async () => {
    const { deps, id } = await relatedCandidate();
    const result = await approveCandidate(deps, id, 3);

    expect(result.candidate.status).toBe("approved");
    expect(result.trackedArtistId).toBeGreaterThan(0);
    const allArtists = deps.db.select().from(artists).all();
    const tracked = allArtists.find((a) => a.name === "Comeback Kid");
    expect(tracked?.score).toBe(3);

    // Approved candidates are never suggested again.
    expect(
      createCandidateIfNew(deps, {
        type: "related",
        key: "comebackkid",
        artistId: null,
        payload: {},
        tasteFit: 0,
        reason: null,
      }),
    ).toBeNull();

    await expect(approveCandidate(deps, id, 1)).rejects.toThrow(/already approved/);
  });

  it("approves a new release by pinning the album into the plan", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      recentGroups: {
        "mbid-terror": [
          {
            id: "rg-1",
            title: "Test Album",
            firstReleaseDate: yesterday,
            primaryType: "Album",
            secondaryTypes: [],
          },
        ],
      },
    });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });
    await runReleaseRadar(deps);
    const id = listCandidates(deps.db)[0].id;

    const result = await approveCandidate(deps, id, 1);
    expect(result.pinned).toHaveLength(2); // fake album has 2 tracks
    const norms = listPlanRows(deps.db, artist.id).map((r) => r.normTitle);
    expect(norms).toContain("albumtrack1");
    expect(norms).toContain("albumtrack2");
  });

  it("rejects and blocklists artists on request", async () => {
    const { deps, id } = await relatedCandidate();
    const rejected = rejectCandidate(deps, id);
    expect(rejected.status).toBe("rejected");

    const ignore = ignoreArtist(deps, "Comeback Kid");
    expect(ignore.ignored).toContain("Comeback Kid");
    expect(ignore.rejected).toBe(0); // already rejected above
  });
});

describe("digest", () => {
  it("summarizes candidates, budgets and jobs with a headline", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: { Terror: [{ name: "Comeback Kid", mbid: null, match: 0.9 }] },
      tags: { Terror: ["hardcore"], "Comeback Kid": ["hardcore"] },
      scrobbles,
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    await runDiscovery(deps);

    const digest = buildDigest(deps);
    expect(digest.pendingCandidates).toBe(1);
    expect(digest.relatedArtists).toBe(1);
    expect(digest.newReleases).toBe(0);
    expect(digest.library.ownedTracks).toBe(0);
    expect(digest.headline).toContain("1 candidate");
    expect(digest.markdown).toContain("Music Assistant digest");
  });
});

describe("scheduler", () => {
  it("enqueues recurring trends jobs exactly once per cadence", () => {
    const deps = fakeDeps();
    const t0 = Date.parse("2026-10-12T00:00:00.000Z");

    const first = runDueSchedules(deps, t0);
    expect(first).toEqual([
      "scrobble_sync",
      "release_radar",
      "discovery",
      "prune_scan",
      "rotation_scan",
    ]);

    // Same hour: nothing due.
    expect(runDueSchedules(deps, t0 + 60 * 60 * 1000)).toEqual([]);

    // A day later: the daily jobs are due again, discovery (72h) is not.
    const nextDay = runDueSchedules(deps, t0 + 25 * 60 * 60 * 1000);
    expect(nextDay).toEqual(["scrobble_sync", "release_radar"]);

    // Three days out: discovery too.
    const threeDays = runDueSchedules(deps, t0 + 80 * 60 * 60 * 1000);
    expect(threeDays).toContain("discovery");
  });
});

describe("trends API", () => {
  it("lists candidates, approves with validation, and serves the digest", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      similar: { Terror: [{ name: "Comeback Kid", mbid: null, match: 0.9 }] },
      tags: { Terror: ["hardcore"], "Comeback Kid": ["hardcore"] },
    });
    await trackBand(deps, { name: "Terror", score: 1 });
    await runDiscovery(deps);
    const app = createApp(deps);

    const list = await (await app.request("/api/candidates")).json();
    expect(list.candidates).toHaveLength(1);
    expect(list.candidates[0].payload.name).toBe("Comeback Kid");

    // Invalid score is a typed 422.
    const bad = await app.request(`/api/candidates/${list.candidates[0].id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 5 }),
    });
    expect(bad.status).toBe(422);

    const ok = await app.request(`/api/candidates/${list.candidates[0].id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 2 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).candidate.status).toBe("approved");

    const digest = await (await app.request("/api/digest")).json();
    expect(digest.headline).toContain("0 candidates");

    // The taste view carries LIVE band affinity (genre/era come from the snapshot).
    // Comeback Kid was approved with score 2 (weight 100), Terror has score 1 (50).
    const taste = await (await app.request("/api/taste")).json();
    expect(taste.profile.bandAffinity).toMatchObject({ terror: 0.5, "comeback kid": 1 });

    const sync = await app.request("/api/scrobbles/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full: true }),
    });
    expect(sync.status).toBe(202);
    expect((await sync.json()).enqueued).toBe("scrobble_sync");
    const allJobs = deps.db.select().from(jobs).all();
    expect(allJobs.some((j) => j.type === "scrobble_sync")).toBe(true);
  });

  it("round-trips the trends settings group", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request("/api/settings/trends", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discoverySeeds: 3, ignoredArtists: ["Bad Act"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.trends).toMatchObject({
      discoverySeeds: 3,
      discoveryDepth: 5,
      radarLookbackDays: 30,
      ignoredArtists: ["Bad Act"],
    });
  });
});
