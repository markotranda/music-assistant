import { describe, expect, it } from "vitest";
import type { HttpJson } from "../src/index";
import { createMusicBrainz } from "../src/index";

/**
 * The studio-album walk: earliest official studio release wins, the canonical
 * release of a group is its earliest official one, and the track number is the
 * album's own position. Built from the recorded ws/2 response shapes
 * (see fixtures/mb-album-release-full.json for the real payload).
 */
const scenario: HttpJson = async (url) => {
  if (url.includes("release-group?artist=")) {
    return {
      "release-group-count": 3,
      "release-groups": [
        {
          id: "rg-live",
          title: "Live From The Dungeon",
          "first-release-date": "1998-01-01",
          "primary-type": "Album",
          "secondary-types": ["Live"],
        },
        {
          id: "rg-1",
          title: "First Record",
          "first-release-date": "2001-05-01",
          "primary-type": "Album",
          "secondary-types": [],
        },
        {
          id: "rg-2",
          title: "Second Record",
          "first-release-date": "2003-09-10",
          "primary-type": "Album",
          "secondary-types": [],
        },
      ],
    };
  }
  if (url.includes("release?release-group=rg-1")) {
    return {
      releases: [
        {
          id: "rel-remaster",
          title: "First Record (Remastered)",
          date: "2010-01-01",
          status: "Official",
          media: [
            {
              position: 1,
              "track-count": 2,
              tracks: [
                { position: 1, title: "Alpha", recording: { id: "rec-alpha-2010" } },
                { position: 2, title: "Beta", recording: { id: "rec-beta" } },
              ],
            },
          ],
        },
        {
          id: "rel-orig",
          title: "First Record",
          date: "2001-05-01",
          status: "Official",
          media: [
            {
              position: 1,
              "track-count": 2,
              tracks: [
                { position: 1, title: "Alpha", recording: { id: "rec-alpha" } },
                { position: 2, title: "Beta", recording: { id: "rec-beta" } },
              ],
            },
          ],
        },
      ],
    };
  }
  if (url.includes("release?release-group=rg-2")) {
    return {
      releases: [
        {
          id: "rel-2",
          title: "Second Record",
          date: "2003-09-10",
          status: "Official",
          media: [
            {
              position: 1,
              "track-count": 1,
              tracks: [{ position: 3, title: "Alpha", recording: { id: "rec-alpha-2" } }],
            },
            {
              position: 2,
              "track-count": 1,
              tracks: [{ position: 1, title: "Gamma", recording: { id: "rec-gamma" } }],
            },
          ],
        },
      ],
    };
  }
  throw new Error(`unexpected url: ${url}`);
};

describe("musicbrainz.syncPlacements", () => {
  it("walks studio albums earliest-first and places songs on the earliest release", async () => {
    const mb = createMusicBrainz({ userAgent: "test", http: scenario });
    const placements = await mb.syncPlacements("mbid-x");

    // The live album never produces placements.
    expect(placements.every((p) => p.releaseGroupMbid !== "rg-live")).toBe(true);

    // Alpha appears on all three studio artifacts; earliest studio album wins,
    // and its ORIGINAL release (not the remaster) supplies the recording id.
    const alpha = placements.find((p) => p.normTitle === "alpha");
    expect(alpha).toMatchObject({
      album: "First Record",
      year: 2001,
      trackNo: 1,
      discNo: 1,
      trackTotal: 2,
      recordingMbid: "rec-alpha",
      releaseGroupMbid: "rg-1",
    });

    // Gamma is only on the second record — disc 2 of a 2-disc, 2-track album.
    expect(placements.find((p) => p.normTitle === "gamma")).toMatchObject({
      album: "Second Record",
      year: 2003,
      trackNo: 1,
      discNo: 2,
      trackTotal: 2,
      recordingMbid: "rec-gamma",
    });
  });
});
