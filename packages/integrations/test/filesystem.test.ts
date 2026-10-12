import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCollectionFs } from "../src/index";

function freshFs() {
  const root = mkdtempSync(join(tmpdir(), "ma-fs-"));
  return createCollectionFs({
    collectionDir: join(root, "collection"),
    retiredDir: join(root, "retired"),
  });
}

describe("collection filesystem", () => {
  it("lists audio files and ignores everything else", () => {
    const fs = freshFs();
    mkdirSync(fs.bandDir("AC/DC"), { recursive: true });
    writeFileSync(join(fs.bandDir("AC/DC"), "01 - T.N.T.mp3"), "");
    writeFileSync(join(fs.bandDir("AC/DC"), "cover.jpg"), "");
    writeFileSync(join(fs.bandDir("AC/DC"), "notes.txt"), "");

    expect(fs.listBandFiles("AC/DC").map((f) => f.fileName)).toEqual(["01 - T.N.T.mp3"]);
    expect(fs.listBandFiles("Nobody")).toEqual([]);
  });

  it("applies renames in two phases through ~tmp~", () => {
    const fs = freshFs();
    mkdirSync(fs.bandDir("Band"), { recursive: true });
    writeFileSync(join(fs.bandDir("Band"), "01 - B.mp3"), "b");
    writeFileSync(join(fs.bandDir("Band"), "02 - A.mp3"), "a");

    // A shuffle where both names are each other's targets — collides without two phases.
    fs.applyRenames("Band", [
      { from: "01 - B.mp3", viaTemp: "~tmp~01 - A.mp3", to: "01 - A.mp3" },
      { from: "02 - A.mp3", viaTemp: "~tmp~02 - B.mp3", to: "02 - B.mp3" },
    ]);

    const files = fs
      .listBandFiles("Band")
      .map((f) => f.fileName)
      .sort();
    expect(files).toEqual(["01 - A.mp3", "02 - B.mp3"]);
    expect(readFileSync(join(fs.bandDir("Band"), "01 - A.mp3"), "utf8")).toBe("b");
  });

  it("retires files outside the collection instead of deleting", () => {
    const fs = freshFs();
    mkdirSync(fs.bandDir("Band"), { recursive: true });
    writeFileSync(join(fs.bandDir("Band"), "01 - Keep.mp3"), "keep");
    writeFileSync(join(fs.bandDir("Band"), "02 - Gone.mp3"), "gone");

    fs.retireFiles("Band", [{ fileName: "02 - Gone.mp3" }]);

    expect(fs.listBandFiles("Band").map((f) => f.fileName)).toEqual(["01 - Keep.mp3"]);
    const retireDir = fs.bandDir("Band").replace("collection", "retired");
    expect(readFileSync(join(retireDir, "02 - Gone.mp3"), "utf8")).toBe("gone");
  });
});
