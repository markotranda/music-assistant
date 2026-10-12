import { describe, expect, it } from "vitest";
import type { HttpJson } from "../src/index";
import { createDeezer, createLastfm } from "../src/index";
import { fixtures } from "./fixtures";

describe("lastfm", () => {
  const http: HttpJson = async (url) => {
    if (url.includes("method=artist.gettoptracks")) return fixtures.lastfmToptracksTerror;
    if (url.includes("method=artist.getSimilar")) return fixtures.lastfmSimilarTerror;
    throw new Error(`unexpected url: ${url}`);
  };
  const lastfm = createLastfm({ apiKey: "k", http });

  it("returns popularity-ranked tracks with numeric playcounts", async () => {
    const tracks = await lastfm.getTopTracks("Terror");
    expect(tracks).toHaveLength(60);
    expect(tracks[0]).toEqual({ name: "Overcome", plays: 414556 });
    expect(tracks.every((t) => Number.isFinite(t.plays))).toBe(true);
  });

  it("returns similar artists with match scores", async () => {
    const similar = await lastfm.getSimilarArtists("Terror");
    expect(similar[0]?.name).toBe("Madball");
    expect(similar[0]?.match).toBe(1);
    expect(similar.every((a) => typeof a.name === "string")).toBe(true);
  });
});

describe("deezer", () => {
  const http: HttpJson = async (url) => {
    if (url.includes("search/artist")) return fixtures.deezerSearchTerror;
    if (url.includes("/top?")) return fixtures.deezerTopTerror;
    throw new Error(`unexpected url: ${url}`);
  };
  const deezer = createDeezer({ http });

  it("returns top track titles for the best match", async () => {
    const titles = await deezer.getTopTrackTitles("Terror");
    const fixtureCount = (fixtures.deezerTopTerror as { data: unknown[] }).data.length;
    expect(titles).toHaveLength(fixtureCount);
    expect(titles.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  });

  it("returns empty when no artist matches", async () => {
    const empty = createDeezer({ http: async () => ({ data: [] }) });
    await expect(empty.getTopTrackTitles("nobody")).resolves.toEqual([]);
  });
});
