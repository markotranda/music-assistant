import { describe, expect, it } from "vitest";
import { buildTasteProfile, computeTasteFit, decadeOf } from "../src/taste";

describe("buildTasteProfile", () => {
  it("normalizes band affinity and folds artist weights into genre tags", () => {
    const profile = buildTasteProfile({
      artistWeights: { Terror: 100, Death: 50, "T-Error": 1 },
      artistTags: {
        Terror: ["Hardcore", " hardcore ", "punk"],
        Death: ["death metal", "Metal"],
        "T-Error": ["rap"],
      },
      decadeWeights: { "1990s": 40, "2000s": 20 },
    });

    expect(profile.bandAffinity).toEqual({ Terror: 1, Death: 0.5, "T-Error": 0.01 });
    // Tags accumulate their artists' affinity; all normalized by the max (1.0).
    expect(profile.genreWeights.hardcore).toBeCloseTo(1, 10);
    expect(profile.genreWeights.punk).toBeCloseTo(1, 10);
    expect(profile.genreWeights.metal).toBeCloseTo(0.5, 10);
    expect(profile.genreWeights["death metal"]).toBeCloseTo(0.5, 10);
    expect(profile.genreWeights.rap).toBeCloseTo(0.01, 10);
    expect(profile.eraWeights).toEqual({ "1990s": 1, "2000s": 0.5 });
  });

  it("returns empty maps when there is no signal", () => {
    expect(buildTasteProfile({ artistWeights: {}, artistTags: {}, decadeWeights: {} })).toEqual({
      bandAffinity: {},
      genreWeights: {},
      eraWeights: {},
    });
  });
});

describe("decadeOf", () => {
  it("parses year-like prefixes and rejects garbage", () => {
    expect(decadeOf("1987-04-02")).toBe("1980s");
    expect(decadeOf("2001")).toBe("2000s");
    expect(decadeOf("unknown")).toBeNull();
  });
});

describe("computeTasteFit", () => {
  const profile = buildTasteProfile({
    artistWeights: { Terror: 100, Death: 40 },
    artistTags: {
      Terror: ["hardcore", "punk"],
      Death: ["death metal"],
    },
    decadeWeights: { "2020s": 80, "1990s": 20 },
  });

  it("scores a related artist on similarity x seed affinity, explaining the points", () => {
    const fit = computeTasteFit(profile, {
      kind: "related",
      artistName: "Comeback Kid",
      similarTo: { name: "Terror", match: 0.9 },
      tags: ["hardcore", "punk"],
    });

    // affinity: 45 * 0.9 * (0.4 + 0.6 * 1.0) = 40.5 (max 45)
    // genre: 35 * min(1, 1 + 0.6667) = 35 (max 35)
    // no release date -> era excluded. total = 75.5 / 80 = 94.
    expect(fit.score).toBe(94);
    expect(fit.parts.map((p) => p.label)).toEqual([
      "similar to Terror (90% match)",
      "genre overlap (hardcore, punk)",
    ]);
    expect(fit.parts.every((p) => p.points >= 0 && p.points <= p.max)).toBe(true);
  });

  it("scores a new release of a loved band by its own affinity", () => {
    const fit = computeTasteFit(profile, {
      kind: "new_release",
      artistName: "Terror",
      tags: ["hardcore"],
      releaseDate: "2026-05-01",
    });

    // affinity 45 * 1 = 45; genre 35 * 1 = 35; era 20 * (2020s -> 1) = 20 -> 100.
    expect(fit.score).toBe(100);
    expect(fit.parts.find((p) => p.label === "in your rotation (100% affinity)")?.points).toBe(45);
    expect(fit.parts.find((p) => p.label === "2020s release")?.points).toBe(20);
  });

  it("keeps unrelated unknowns low and deterministic", () => {
    const fit = computeTasteFit(profile, {
      kind: "related",
      artistName: "Random Act",
      similarTo: { name: "Unknown Seed", match: 0.2 },
      tags: ["polka"],
    });
    // affinity 45 * 0.2 * (0.4 + 0.6 * 0.5) = 6.3; genre 0. total 6.3/80 = 7.875 -> 8.
    expect(fit.score).toBe(8);
    expect(fit.parts.map((p) => p.points)).toEqual([6, 0]);
  });

  it("excludes genre and era parts when the profile has no signal for them", () => {
    const fresh = buildTasteProfile({
      artistWeights: { Terror: 100 },
      artistTags: {},
      decadeWeights: {},
    });
    const fit = computeTasteFit(fresh, {
      kind: "related",
      artistName: "Comeback Kid",
      similarTo: { name: "Terror", match: 0.9 },
      tags: ["hardcore"],
      releaseDate: "2026-05-01",
    });
    // Only the affinity part applies: 45 * 0.9 * 1.0 = 40.5 of 45 -> 90.
    expect(fit.score).toBe(90);
    expect(fit.parts.map((p) => p.label)).toEqual(["similar to Terror (90% match)"]);
  });

  it("scores 0 when nothing applies", () => {
    expect(computeTasteFit(profile, { kind: "related", artistName: "X" }).score).toBe(0);
  });
});
