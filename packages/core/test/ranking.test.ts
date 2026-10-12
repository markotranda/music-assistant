import { describe, expect, it } from "vitest";
import { rankTracks } from "../src/index";

describe("rankTracks", () => {
  it("filters alt versions, dedupes on normalized titles, and cleans display titles", () => {
    const ranked = rankTracks([
      { name: "Paint It, Black", plays: 100 },
      { name: "Paint It Black (Live)", plays: 90 },
      { name: "Paint It, Black - 2019 Remaster", plays: 80 },
      { name: "Gimme Shelter (2019 Remaster)", plays: 70 },
      { name: "Sympathy for the Devil (Demo)", plays: 60 },
      { name: "Jumpin' Jack Flash", plays: 50 },
    ]);

    // Legacy Clean-Title only strips " - suffix" labels; parentheticals stay in
    // the display title (they are stripped only for the norm key).
    expect(ranked).toEqual([
      { title: "Paint It, Black", norm: "paintitblack", plays: 100 },
      { title: "Gimme Shelter (2019 Remaster)", norm: "gimmeshelter", plays: 70 },
      { title: "Jumpin' Jack Flash", norm: "jumpinjackflash", plays: 50 },
    ]);
  });

  it("keeps surviving titles and drops entries that normalize to nothing", () => {
    expect(rankTracks([{ name: "1969 - Demo Version", plays: 1 }])).toEqual([
      { title: "1969", norm: "1969", plays: 1 },
    ]);
    // Everything is stripped: no alnum characters left -> no dedup key -> dropped.
    expect(rankTracks([{ name: "(!!!) - Single Version", plays: 1 }])).toEqual([]);
  });

  it("keeps the highest-ranked entry when duplicates appear", () => {
    const ranked = rankTracks([
      { name: "Ace of Spades", plays: 500 },
      { name: "Ace of Spades (1980)", plays: 100 },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.plays).toBe(500);
  });
});
