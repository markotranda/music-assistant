import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeAudio, retagFile } from "../src/index";

const sampleSrc = fileURLToPath(new URL("./fixtures/sample.mp3", import.meta.url));

function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-tag-"));
  const dest = join(dir, "01 - Keepers of the Faith.mp3");
  copyFileSync(sampleSrc, dest);
  return dest;
}

describe("retagFile + probeAudio", () => {
  it("writes canonical tags and the read-back proves they stuck", async () => {
    const file = freshCopy();
    const before = await probeAudio(file);
    expect(before).not.toBeNull();

    retagFile(file, {
      artist: "Terror",
      title: "Keepers of the Faith",
      albumArtist: "Terror",
      trackNumber: 5,
    });

    const after = await probeAudio(file);
    expect(after?.title).toBe("Keepers of the Faith");
    expect(after?.artist).toBe("Terror");
    expect(after?.albumArtist).toBe("Terror");
    expect(after?.trackNumber).toBe(5);
    // Retagging rewrote the file -> the content hash moved.
    expect(after?.hash).not.toBe(before?.hash);
    expect(after?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.durationS).toBe(1);
  });

  it("probes report size and hash deterministically", async () => {
    const file = freshCopy();
    const a = await probeAudio(file);
    const b = await probeAudio(file);
    expect(a?.sizeBytes).toBeGreaterThan(0);
    expect(a?.hash).toBe(b?.hash);
  });
});

describe("probeAudio failure contract", () => {
  it("returns null for empty, corrupt, and missing files (verify reports these)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-probe-"));
    const empty = join(dir, "empty.mp3");
    const garbage = join(dir, "garbage.mp3");
    writeFileSync(empty, "");
    writeFileSync(garbage, "this is not audio at all");

    await expect(probeAudio(empty)).resolves.toBeNull();
    await expect(probeAudio(garbage)).resolves.toBeNull();
    await expect(probeAudio(join(dir, "missing.mp3"))).resolves.toBeNull();
  });
});
