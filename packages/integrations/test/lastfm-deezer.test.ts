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

describe("lastfm scrobbles + tags", () => {
  const recentPage = {
    recenttracks: {
      track: [
        {
          name: "Overcome",
          artist: { "#text": "Terror", mbid: "" },
          album: { "#text": "Keepers of the Faith" },
          date: { uts: "1750000000", "#text": "15 Jun 2025, 12:26" },
        },
        {
          name: "Now Playing Song",
          artist: { "#text": "Terror" },
          album: { "#text": "…" },
          // no date -> skipped ("now playing")
        },
        {
          name: "Spiritual Beggars",
          artist: { name: "Terror" }, // newer shape without #text
          album: { "#text": "Rhythm of Life" },
          date: { uts: "1749990000" },
        },
      ],
      "@attr": { page: "1", total: "4212", totalPages: "22" },
    },
  };
  const http: HttpJson = async (url) => {
    if (url.includes("method=user.getRecentTracks")) {
      expect(url).toContain("user=markotranda");
      return recentPage;
    }
    if (url.includes("method=artist.getTopTags")) {
      return { toptags: { tag: [{ name: "hardcore" }, { name: "punk" }, { name: "metal" }] } };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  const lastfm = createLastfm({ apiKey: "k", http });

  it("maps a scrobble page to ISO timestamps and skips now-playing entries", async () => {
    const page = await lastfm.getUserRecentTracks("markotranda");
    expect(page.scrobbles).toHaveLength(2);
    expect(page.scrobbles[0]).toEqual({
      artist: "Terror",
      title: "Overcome",
      album: "Keepers of the Faith",
      playedAt: new Date(1750000000 * 1000).toISOString(),
    });
    expect(page.scrobbles[1].artist).toBe("Terror"); // both artist shapes
    expect(page.totalPages).toBe(22);
    expect(page.total).toBe(4212);
  });

  it("passes the incremental window and pagination through", async () => {
    const seen: string[] = [];
    const spy: HttpJson = async (url) => {
      seen.push(url);
      return recentPage;
    };
    const lf = createLastfm({ apiKey: "k", http: spy });
    await lf.getUserRecentTracks("markotranda", { from: 100, to: 200, page: 3, limit: 50 });
    expect(seen[0]).toContain("from=100");
    expect(seen[0]).toContain("to=200");
    expect(seen[0]).toContain("page=3");
    expect(seen[0]).toContain("limit=50");
  });

  it("returns top genre tags", async () => {
    await expect(lastfm.getTopTags("Terror")).resolves.toEqual(["hardcore", "punk", "metal"]);
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
