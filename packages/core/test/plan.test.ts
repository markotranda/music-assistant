import { describe, expect, it } from "vitest";
import type { RankedTrack } from "../src/index";
import { buildDesired, indexOnDisk, planSync, splitFileName, targetFileName } from "../src/index";

const ranked = (...titles: string[]): RankedTrack[] =>
  titles.map((title, i) => ({
    title,
    norm: title.toLowerCase().replace(/[^a-z0-9]/g, ""),
    plays: 1000 - i,
  }));

describe("buildDesired", () => {
  it("ranks picks 1..N and appends pinned extras with continuing ranks", () => {
    const desired = buildDesired(ranked("Paint It, Black", "Gimme Shelter"), [
      { title: "Ruby Tuesday", norm: "rubytuesday" },
    ]);
    expect(desired).toEqual([
      { rank: 1, title: "Paint It, Black", norm: "paintitblack", pinned: false },
      { rank: 2, title: "Gimme Shelter", norm: "gimmeshelter", pinned: false },
      { rank: 3, title: "Ruby Tuesday", norm: "rubytuesday", pinned: true },
    ]);
  });

  it("drops pinned tracks the selection already covers", () => {
    const desired = buildDesired(ranked("Paint It, Black"), [
      { title: "Paint It Black", norm: "paintitblack" },
    ]);
    expect(desired).toHaveLength(1);
    expect(desired[0]?.pinned).toBe(false);
  });
});

describe("splitFileName / indexOnDisk", () => {
  it("splits name and extension at the last dot", () => {
    expect(splitFileName("S.M.F.mp3")).toEqual({ base: "S.M.F", extension: ".mp3" });
    expect(splitFileName("noext")).toEqual({ base: "noext", extension: "" });
  });

  it("strips rank prefixes and keeps the first file per normalized title", () => {
    const onDisk = indexOnDisk([
      { fileName: "01 - Paint It, Black.mp3" },
      { fileName: "02 - Paint It Black.flac" },
      { fileName: "03 - Gimme Shelter.m4a" },
    ]);
    expect(onDisk).toHaveLength(2);
    expect(onDisk[0]).toEqual({
      norm: "paintitblack",
      fileName: "01 - Paint It, Black.mp3",
      title: "Paint It, Black",
      extension: ".mp3",
    });
    expect(onDisk[1]?.extension).toBe(".m4a");
  });
});

describe("planSync", () => {
  it("acquires everything on a fresh band", () => {
    const desired = buildDesired(ranked("Paint It, Black", "Gimme Shelter"), []);
    const plan = planSync(desired, indexOnDisk([]));
    expect(plan.acquire).toHaveLength(2);
    expect(plan.retire).toHaveLength(0);
    expect(plan.renames).toHaveLength(0);
  });

  it("is a no-op when disk already matches the plan", () => {
    const desired = buildDesired(ranked("Paint It, Black"), []);
    const onDisk = indexOnDisk([{ fileName: "01 - Paint It, Black.mp3" }]);
    const plan = planSync(desired, onDisk);
    expect(plan).toEqual({ acquire: [], retire: [], renames: [] });
  });

  it("two-phase renames when ranks shuffle, preserving extensions", () => {
    const desired = buildDesired(ranked("Gimme Shelter", "Paint It, Black"), []);
    const onDisk = indexOnDisk([
      { fileName: "01 - Paint It, Black.mp3" },
      { fileName: "02 - Gimme Shelter.flac" },
    ]);
    const plan = planSync(desired, onDisk);
    expect(plan.acquire).toHaveLength(0);
    expect(plan.retire).toHaveLength(0);
    expect(plan.renames).toEqual([
      {
        from: "02 - Gimme Shelter.flac",
        viaTemp: "~tmp~01 - Gimme Shelter.flac",
        to: "01 - Gimme Shelter.flac",
      },
      {
        from: "01 - Paint It, Black.mp3",
        viaTemp: "~tmp~02 - Paint It, Black.mp3",
        to: "02 - Paint It, Black.mp3",
      },
    ]);
    // Every rename goes through ~tmp~ first (legacy two-phase discipline).
    for (const r of plan.renames) {
      expect(r.viaTemp.startsWith("~tmp~")).toBe(true);
    }
  });

  it("retires surplus files instead of deleting them", () => {
    const desired = buildDesired(ranked("Paint It, Black"), []);
    const onDisk = indexOnDisk([
      { fileName: "01 - Paint It, Black.mp3" },
      { fileName: "02 - Some Deep Cut.mp3" },
    ]);
    const plan = planSync(desired, onDisk);
    expect(plan.acquire).toHaveLength(0);
    expect(plan.retire.map((f) => f.fileName)).toEqual(["02 - Some Deep Cut.mp3"]);
  });

  it("keeps pinned tracks through a re-plan", () => {
    const picks = ranked("Paint It, Black");
    const desired = buildDesired(picks, [{ title: "Ruby Tuesday", norm: "rubytuesday" }]);
    const onDisk = indexOnDisk([
      { fileName: "01 - Paint It, Black.mp3" },
      { fileName: "02 - Ruby Tuesday.mp3" },
    ]);
    const plan = planSync(desired, onDisk);
    expect(plan).toEqual({ acquire: [], retire: [], renames: [] });
    expect(desired[1]?.pinned).toBe(true);
  });

  it("builds safe target names with 2-digit rank padding", () => {
    expect(targetFileName({ rank: 7, title: "AC/DC", norm: "acdc", pinned: false }, ".mp3")).toBe(
      "07 - AC-DC.mp3",
    );
    expect(targetFileName({ rank: 123, title: "Song", norm: "song", pinned: false }, ".flac")).toBe(
      "123 - Song.flac",
    );
  });
});
