import { describe, expect, it } from "vitest";
import { selectTracks } from "../src/index";
import { selectionFixture, syntheticRanked } from "./fixtures";

describe("selectTracks — legacy golden parity", () => {
  it.each(selectionFixture.cases.map((c) => [c.name, c] as const))(
    "matches legacy selection for %s",
    (_name, golden) => {
      const ranked = syntheticRanked(golden.count);
      const picks = selectTracks(ranked, golden.quota, golden.score);
      expect(picks.map((p) => p.norm)).toEqual(golden.picks);
    },
  );
});

describe("selectTracks — edge cases", () => {
  it("returns nothing for empty input or a non-positive quota", () => {
    expect(selectTracks([], 5, 2)).toEqual([]);
    expect(selectTracks(syntheticRanked(10), 0, 3)).toEqual([]);
  });

  it("score 3 mixes hits with spaced-out deep cuts", () => {
    const picks = selectTracks(syntheticRanked(30), 8, 3);
    expect(picks).toHaveLength(8);
    // 65% of 8 = 5.2 -> 5 head, 3 deep; deep cuts are spread, not adjacent.
    expect(picks.slice(0, 5).map((p) => p.norm)).toEqual([
      "song01",
      "song02",
      "song03",
      "song04",
      "song05",
    ]);
    expect(picks.slice(5).map((p) => p.norm)).toEqual(["song06", "song10", "song14"]);
  });
});
