import { describe, expect, it } from "vitest";
import { buildPlacements, type PlacementAlbumInput } from "../src/index";

/**
 * Golden cases for the legacy album rule: "a song is attributed to its earliest
 * official studio release, and the track number is that album's position."
 */

const firstRecord: PlacementAlbumInput = {
  title: "First Record",
  year: 2001,
  releaseGroupMbid: "rg-1",
  media: [
    {
      position: 1,
      trackCount: 2,
      tracks: [
        { position: 1, title: "Alpha", recordingMbid: "rec-alpha" },
        { position: 2, title: "Beta", recordingMbid: "rec-beta" },
      ],
    },
  ],
};

const secondRecord: PlacementAlbumInput = {
  title: "Second Record",
  year: 2003,
  releaseGroupMbid: "rg-2",
  media: [
    {
      position: 1,
      trackCount: 1,
      tracks: [{ position: 1, title: "Alpha (re-recording)", recordingMbid: "rec-alpha-2" }],
    },
    {
      position: 2,
      trackCount: 1,
      tracks: [{ position: 1, title: "Gamma", recordingMbid: "rec-gamma" }],
    },
  ],
};

describe("buildPlacements", () => {
  it("attributes a song to its earliest studio album with that album's positions", () => {
    const out = buildPlacements([firstRecord]);
    expect(out).toEqual([
      {
        normTitle: "alpha",
        album: "First Record",
        year: 2001,
        trackNo: 1,
        discNo: 1,
        trackTotal: 2,
        recordingMbid: "rec-alpha",
        releaseGroupMbid: "rg-1",
      },
      {
        normTitle: "beta",
        album: "First Record",
        year: 2001,
        trackNo: 2,
        discNo: 1,
        trackTotal: 2,
        recordingMbid: "rec-beta",
        releaseGroupMbid: "rg-1",
      },
    ]);
  });

  it("keeps the earliest mention when a title appears on two albums", () => {
    const clash: PlacementAlbumInput = {
      ...secondRecord,
      media: [
        {
          position: 1,
          trackCount: 1,
          tracks: [{ position: 3, title: "Beta", recordingMbid: "rec-beta-live-ish" }],
        },
      ],
    };
    const out = buildPlacements([firstRecord, clash]);
    expect(out.find((p) => p.normTitle === "beta")?.album).toBe("First Record");
    expect(out.find((p) => p.normTitle === "beta")?.trackNo).toBe(2);
  });

  it("numbers discs per medium and totals tracks across them", () => {
    const out = buildPlacements([secondRecord]);
    expect(out.find((p) => p.normTitle === "gamma")).toMatchObject({
      album: "Second Record",
      discNo: 2,
      trackNo: 1,
      trackTotal: 2,
    });
  });

  it("falls back to media order when the release declares no disc number", () => {
    const undeclared: PlacementAlbumInput = {
      title: "Odd Release",
      year: null,
      releaseGroupMbid: "rg-3",
      media: [
        {
          position: null,
          trackCount: 0,
          tracks: [{ position: null, title: "Solo", recordingMbid: null }],
        },
      ],
    };
    const out = buildPlacements([undeclared]);
    expect(out[0]).toMatchObject({
      normTitle: "solo",
      album: "Odd Release",
      year: null,
      trackNo: null,
      discNo: 1,
      trackTotal: 1,
      recordingMbid: null,
    });
  });

  it("skips untitled tracks instead of inventing placements", () => {
    const out = buildPlacements([
      {
        title: "Ghosts",
        year: 1999,
        releaseGroupMbid: "rg-4",
        media: [
          {
            position: 1,
            trackCount: 1,
            tracks: [{ position: 1, title: "  ", recordingMbid: null }],
          },
        ],
      },
    ]);
    expect(out).toEqual([]);
  });
});
