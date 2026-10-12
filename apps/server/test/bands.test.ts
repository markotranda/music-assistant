import { getQuota } from "@ma/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getArtistByMbid, listPlanRows } from "../src/db/repositories";
import { events, jobs } from "../src/db/schema";
import {
  pinAlbum,
  pinTrack,
  removeTrack,
  setScore,
  syncBand,
  trackBand,
  untrack,
} from "../src/services/bands";
import { type FakeDeps, fakeDeps, syntheticRanked } from "./fakes";

function jobCount(deps: FakeDeps, type: string): number {
  return deps.db.select().from(jobs).where(eq(jobs.type, type)).all().length;
}

describe("trackBand", () => {
  let deps: FakeDeps;

  beforeEach(() => {
    deps = fakeDeps({ ranked: syntheticRanked(30) });
  });

  it("resolves, computes quota via core, and writes ranked plan rows 1..N", async () => {
    const { artist, catalog, sync } = await trackBand(deps, { name: "Terror", score: 2 });

    expect(artist.mbid).toBe("mbid-terror");
    expect(catalog).toEqual({ albums: 10, catalog: 139, method: "test" });
    // score 2 quota = round(1.15 * sqrt(139)) = 14
    expect(artist.quota).toBe(getQuota(2, 139));
    expect(artist.quota).toBe(14);

    const rows = listPlanRows(deps.db, artist.id);
    expect(rows).toHaveLength(14);
    expect(rows.map((r) => r.rank)).toEqual([...Array(14).keys()].map((i) => i + 1));
    expect(rows[0]?.normTitle).toBe("song01");
    expect(rows.every((r) => !r.pinned)).toBe(true);

    // Everything missing on disk -> acquire + download jobs.
    expect(sync.acquire).toHaveLength(14);
    expect(jobCount(deps, "download")).toBe(14);
  });

  it("rejects unresolvable names and duplicate tracking", async () => {
    await expect(
      trackBand(
        { ...deps, musicbrainz: { ...deps.musicbrainz, resolveArtist: async () => null } },
        { name: "Nobody" },
      ),
    ).rejects.toMatchObject({ status: 404 });

    await trackBand(deps, { name: "Terror" });
    await expect(trackBand(deps, { name: "Terror" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects invalid scores", async () => {
    await expect(
      trackBand(deps, { name: "Terror", score: 5 as unknown as number }),
    ).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe("syncBand", () => {
  it("previews without side effects and applies exactly what it previewed", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Band", score: 1 });
    const before = listPlanRows(deps.db, artist.id);
    // score 1 quota = 7: desired = Song 01..Song 07 at ranks 1..7.
    expect(before.map((r) => r.normTitle)).toEqual([
      "song01",
      "song02",
      "song03",
      "song04",
      "song05",
      "song06",
      "song07",
    ]);

    deps.fs.files.set(
      "Band",
      new Set([
        "07 - Song 01.mp3", // wrong rank -> rename
        "06 - Song 02.mp3", // wrong rank -> rename
        "03 - Song 03.mp3",
        "04 - Song 04.mp3",
        "05 - Song 05.mp3",
        "06 - Song 06.mp3",
        "99 - Junk Track.mp3", // surplus -> retire
        // Song 07 missing -> acquire
      ]),
    );
    deps.db.delete(jobs).run();

    const preview = await syncBand(deps, artist.id, { apply: false });
    expect(preview.applied).toBe(false);
    expect(preview.retire).toEqual([{ fileName: "99 - Junk Track.mp3" }]);
    expect(preview.acquire.map((d) => d.norm)).toEqual(["song07"]);
    expect(preview.renames).toEqual([
      { from: "07 - Song 01.mp3", to: "01 - Song 01.mp3" },
      { from: "06 - Song 02.mp3", to: "02 - Song 02.mp3" },
    ]);
    // preview must not touch anything:
    expect(deps.fs.files.get("Band")?.size).toBe(7);
    expect(listPlanRows(deps.db, artist.id)).toEqual(before);
    expect(jobCount(deps, "download")).toBe(0);

    const applied = await syncBand(deps, artist.id, { apply: true });
    expect(applied.renames).toEqual(preview.renames);
    expect(applied.acquire).toEqual(preview.acquire);
    // exactly what was previewed happened:
    expect(deps.fs.retired.get("Band")).toEqual(["99 - Junk Track.mp3"]);
    expect(jobCount(deps, "download")).toBe(1);
    expect([...(deps.fs.files.get("Band") ?? [])].sort()).toEqual([
      "01 - Song 01.mp3",
      "02 - Song 02.mp3",
      "03 - Song 03.mp3",
      "04 - Song 04.mp3",
      "05 - Song 05.mp3",
      "06 - Song 06.mp3",
    ]);
  });

  it("retires surplus on a score downgrade and keeps the plan equal to the folder", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Band", score: 3 });
    // score 3 quota = 24 -> Song 01..Song 24 at ranks 1..24; simulate full disk.
    const rows = listPlanRows(deps.db, artist.id);
    expect(rows).toHaveLength(24);
    deps.fs.files.set(
      "Band",
      new Set(
        rows.map(
          (r) => `${String(r.rank).padStart(2, "0")} - Song ${String(r.rank).padStart(2, "0")}.mp3`,
        ),
      ),
    );
    // The initial sync queued 24 download jobs against the empty folder; clear
    // them so this test proves the downgrade itself queues nothing.
    deps.db.delete(jobs).run();

    const { sync } = await setScore(deps, artist.id, 1);
    // score 1 quota = 7 (0.65*sqrt(139) = 7.66 -> 8, capped at 7).
    expect(sync.desired).toHaveLength(7);
    expect(sync.retire).toHaveLength(17);
    expect(deps.fs.files.get("Band")?.size).toBe(7);
    expect(listPlanRows(deps.db, artist.id)).toHaveLength(7);
    // No downloads: everything needed is already on disk.
    expect(jobCount(deps, "download")).toBe(0);
  });
});

describe("pinned tracks", () => {
  it("survives re-plans and dedupes against selection", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Band", score: 2 });

    const pinned = pinTrack(deps, artist.id, "Ruby Tuesday");
    expect(pinned.rank).toBe(15); // after the 14 selected rows

    // Pinning a title the selection covers is a no-op.
    const dup = pinTrack(deps, artist.id, "Song 01");
    expect(dup.norm).toBe("song01");
    expect(dup.pinned).toBe(undefined);

    const { sync } = await setScore(deps, artist.id, 3);
    const ruby = sync.desired.find((d) => d.norm === "rubytuesday");
    expect(ruby?.pinned).toBe(true);
    expect(sync.desired.at(-1)?.pinned).toBe(true); // pinned sorts after picks

    const rows = listPlanRows(deps.db, artist.id);
    expect(rows.find((r) => r.normTitle === "rubytuesday")?.source).toBe("pinned");
    expect(rows.find((r) => r.normTitle === "rubytuesday")?.pinned).toBe(true);
  });

  it("pins whole albums, skipping titles already planned", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      album: {
        found: true,
        album: "Keepers of the Faith",
        date: "2010-09-14",
        tracks: ["Song 01", "Your Enemies Are Mine", "Stick Tight"],
      },
    });
    const { artist } = await trackBand(deps, { name: "Band", score: 1 });
    const result = await pinAlbum(deps, artist.id, "Keepers of the Faith");

    expect(result.skipped).toEqual(["Song 01"]);
    expect(result.pinned.map((p) => p.title)).toEqual(["Your Enemies Are Mine", "Stick Tight"]);

    // Album miss lists what IS available.
    const missDeps = {
      ...deps,
      musicbrainz: {
        ...deps.musicbrainz,
        getAlbumTracks: async () => ({ found: false as const, available: ["Album A (2001)"] }),
      },
    };
    await expect(pinAlbum(missDeps, artist.id, "Missing Album")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("removes a track and retires its file", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30), files: { Band: ["01 - Song 01.mp3"] } });
    const { artist } = await trackBand(deps, { name: "Band", score: 1 });
    pinTrack(deps, artist.id, "Ruby Tuesday");

    const result = removeTrack(deps, artist.id, "song01");
    expect(result.retired).toBe(true);
    expect(deps.fs.retired.get("Band")).toEqual(["01 - Song 01.mp3"]);
    expect(listPlanRows(deps.db, artist.id).some((r) => r.normTitle === "song01")).toBe(false);
  });
});

describe("untrack", () => {
  it("retires every file and removes the rows", async () => {
    const deps = fakeDeps({
      ranked: syntheticRanked(30),
      files: { Band: ["01 - Song 01.mp3", "02 - Song 02.mp3"] },
    });
    const { artist } = await trackBand(deps, { name: "Band", score: 1 });

    const result = untrack(deps, artist.id);
    expect(result.retired).toBe(2);
    expect(deps.fs.files.get("Band")?.size).toBe(0);
    expect(getArtistByMbid(deps.db, artist.mbid)).toBeUndefined();
    expect(listPlanRows(deps.db, artist.id)).toHaveLength(0);
  });
});

describe("merged-artist whitelist", () => {
  it("filters merged Last.fm noise using the whitelist and logs degradation", async () => {
    const deps = fakeDeps({
      ranked: [
        { name: "Real Song", plays: 500 },
        { name: "Other Act Hit", plays: 400 },
      ],
      resolved: { pinned: true, mbid: "pinned-mbid" },
      deezerTitles: ["Real Song"],
      deezerThrows: true, // degradation path: whitelist falls back to own files
      files: { Band: ["01 - Real Song.mp3"] },
    });
    // pinnedMbid triggers whitelist; deezer throws -> own files whitelist only.
    const { artist, sync } = await trackBand(deps, { name: "Band", score: 1 });

    expect(artist.pinnedMbid).toBe("pinned-mbid");
    expect(sync.desired.map((d) => d.norm)).toEqual(["realsong"]);
    const logged = deps.db
      .select()
      .from(events)
      .all()
      .some((e) => e.kind === "whitelist_degraded");
    expect(logged).toBe(true);
  });
});
