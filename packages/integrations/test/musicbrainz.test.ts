import { describe, expect, it } from "vitest";
import type { HttpJson } from "../src/index";
import { createMusicBrainz } from "../src/index";
import { fixtures } from "./fixtures";

/** Routes request URLs to recorded fixtures (no network in tests). */
function fixtureHttp(): HttpJson {
  return async (url) => {
    if (url.includes("artist?query=artist:%22Terror%22")) return fixtures.mbArtistSearchTerror;
    if (url.includes("artist?query=artist:%22Turbonegro%22")) return { artists: [] };
    if (url.includes("artist?query=Turbonegro")) return fixtures.mbArtistSearchTurbonegro;
    if (url.includes("release-group?artist=")) return fixtures.mbReleaseGroupsTerror;
    if (url.includes("release?release-group=")) return fixtures.mbAlbumReleases;
    if (url.includes("release?artist=")) return fixtures.mbReleasesTerror;
    if (url.includes("release/")) return fixtures.mbAlbumReleaseFull;
    throw new Error(`unexpected url: ${url}`);
  };
}

const mb = createMusicBrainz({ userAgent: "test", http: fixtureHttp() });

describe("musicbrainz.resolveArtist", () => {
  it("resolves an exact hit with disambiguation and alternatives", async () => {
    const hit = await mb.resolveArtist("Terror");
    expect(hit?.mbid).toBe("697eba1a-bf52-46b1-a19f-4d7190b63e5c");
    expect(hit?.name).toBe("Terror");
    expect(hit?.country).toBe("US");
    expect(hit?.disambiguation).toBe("USA hardcore punk band");
    expect(hit?.pinned).toBe(false);
    expect(hit?.alternatives.map((a) => a.name)).toEqual([
      "Terror",
      "Rotterdam Terror Corps",
      "Terror Danjah",
      "Sheer Terror",
      "Extreme Noise Terror",
    ]);
  });

  it("falls back to a plain query for alias filing (Turbonegro -> Turboneger)", async () => {
    const hit = await mb.resolveArtist("Turbonegro");
    expect(hit?.mbid).toBe(
      (fixtures.mbArtistSearchTurbonegro as { artists: { id: string }[] }).artists[0]?.id,
    );
    expect(hit?.name).toBe("Turboneger");
  });

  it("honors pinned MBIDs without any HTTP call", async () => {
    const hit = await mb.resolveArtist("Whatever", {
      pinnedMbid: "796c0a6f-e830-43b0-934e-4c958e694e4c",
    });
    expect(hit?.mbid).toBe("796c0a6f-e830-43b0-934e-4c958e694e4c");
    expect(hit?.disambiguation).toBe("PINNED");
    expect(hit?.pinned).toBe(true);
  });

  it("returns null when nothing matches", async () => {
    const emptyMb = createMusicBrainz({
      userAgent: "test",
      http: async () => ({ artists: [] }),
    });
    await expect(emptyMb.resolveArtist("zzz-unmapped")).resolves.toBeNull();
  });
});

describe("musicbrainz.getCatalogSize", () => {
  it("computes studio albums × sampled avg tracks (fixture-backed)", async () => {
    const catalog = await mb.getCatalogSize("697eba1a-bf52-46b1-a19f-4d7190b63e5c");
    expect(catalog).toEqual({
      albums: 10,
      catalog: 139,
      method: "mb(avg 13.9 x 10, n=7)",
    });
  });

  it("paginates instead of truncating at 100 (legacy flaw)", async () => {
    const pageOf = (offset: number, total: number) => ({
      "release-group-count": total,
      "release-group-offset": offset,
      "release-groups": Array.from({ length: Math.min(100, total - offset) }, (_, i) => ({
        id: `g${offset + i}`,
        title: `Album ${offset + i}`,
        "secondary-types": [],
      })),
    });
    const calls: string[] = [];
    const pagedMb = createMusicBrainz({
      userAgent: "test",
      http: async (url) => {
        calls.push(url);
        if (url.includes("release-group")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          return pageOf(offset, 250);
        }
        return { releases: [], "release-count": 0 };
      },
    });
    const catalog = await pagedMb.getCatalogSize("any");
    expect(catalog.albums).toBe(250);
    // 250 studio groups at est 11/alb (no release track counts in this mock).
    expect(catalog.catalog).toBe(2750);
    // 3 release-group pages + 1 releases page (whose inc=media+release-groups
    // query param also contains the substring "release-group").
    expect(calls.filter((u) => u.includes("release-group?artist="))).toHaveLength(3);
  });
});

describe("musicbrainz.getAlbumTracks", () => {
  it("returns the album track list", async () => {
    const album = await mb.getAlbumTracks(
      "697eba1a-bf52-46b1-a19f-4d7190b63e5c",
      "Keepers of the Faith",
    );
    expect(album).toMatchObject({ found: true, album: "Keepers of the Faith", date: "2010-09-14" });
    if (album.found) {
      expect(album.tracks).toHaveLength(13);
      expect(album.tracks[0]).toBe("Your Enemies Are Mine");
    }
  });

  it("lists what IS available on a miss", async () => {
    const album = await mb.getAlbumTracks("697eba1a-bf52-46b1-a19f-4d7190b63e5c", "No Such Album");
    expect(album.found).toBe(false);
    if (!album.found) {
      expect(album.available.length).toBe(10); // studio-only, sorted by date
      expect(album.available[0]).toMatch(/Lowest of the Low \(2003\)/);
    }
  });
});
