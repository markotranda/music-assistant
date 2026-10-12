import { describe, expect, it } from "vitest";
import { pickArtist } from "../src/index";

describe("pickArtist", () => {
  it("prefers the exact name match over the search's first hit", () => {
    // Live pitfall: searching "Terror" ranks "T-Error" first.
    const hits = [
      { id: 1, name: "T-Error", nb_fan: 900000 },
      { id: 2, name: "Terror", nb_fan: 50000 },
      { id: 3, name: "Terror", nb_fan: 120000 },
    ];
    expect(pickArtist(hits, "Terror")?.id).toBe(3); // exact + most fans
    expect(pickArtist(hits, "tErRoR")?.id).toBe(3); // case-insensitive
  });

  it("falls back to the most popular candidate when no name matches exactly", () => {
    const hits = [
      { id: 1, name: "T-Error", nb_fan: 10 },
      { id: 2, name: "Terror Corps", nb_fan: 99 },
    ];
    expect(pickArtist(hits, "Terror")?.id).toBe(2);
  });

  it("returns undefined for no hits", () => {
    expect(pickArtist([], "Terror")).toBeUndefined();
  });
});
