import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";
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

describe("retagFile canonical set (legacy parity)", () => {
  const fullTags = {
    artist: "Terror",
    title: "Lowest of the Low",
    albumArtist: "Terror",
    album: "Lowest of the Low",
    year: 2003,
    trackNumber: 1,
    trackTotal: 11,
    discNumber: 1,
    mbids: {
      artist: "697eba1a-bf52-46b1-a19f-4d7190b63e5c",
      albumArtist: "697eba1a-bf52-46b1-a19f-4d7190b63e5c",
      releaseGroup: "rg-lowest",
      recording: "rec-lowest",
    },
    replayGain: { gainDb: -3.25, peakLinear: 0.91 },
  };

  it("writes album, year, album position, disc, MBIDs and ReplayGain", async () => {
    const file = freshCopy();
    retagFile(file, fullTags);

    const after = await probeAudio(file);
    expect(after?.album).toBe("Lowest of the Low");
    expect(after?.year).toBe(2003);
    expect(after?.trackNumber).toBe(1);
    expect(after?.trackTotal).toBe(11);
    expect(after?.discNumber).toBe(1);

    const meta = await parseFile(file);
    expect(meta.common.musicbrainz_artistid).toEqual(["697eba1a-bf52-46b1-a19f-4d7190b63e5c"]);
    expect(meta.common.musicbrainz_releasegroupid).toBe("rg-lowest");
    expect(meta.common.musicbrainz_recordingid).toBe("rec-lowest");
    // ReplayGain under the standard REPLAYGAIN_* descriptions.
    const native = JSON.stringify(meta.native);
    expect(native).toContain("REPLAYGAIN_TRACK_GAIN");
    expect(native).toContain("REPLAYGAIN_TRACK_PEAK");
  });

  it("re-writes replace the owned frames instead of stacking duplicates", async () => {
    const file = freshCopy();
    retagFile(file, fullTags);
    retagFile(file, {
      ...fullTags,
      album: "Corrected Album",
      mbids: { ...fullTags.mbids, recording: "rec-corrected" },
    });

    const meta = await parseFile(file);
    expect(meta.common.album).toBe("Corrected Album");
    expect(meta.common.musicbrainz_recordingid).toBe("rec-corrected");

    const native = JSON.stringify(meta.native);
    const count = (needle: string) => native.split(needle).length - 1;
    expect(count("MusicBrainz Album Artist Id")).toBe(1);
    expect(count("MusicBrainz Release Group Id")).toBe(1);
  });

  it("embeds the front cover from the lazy source", async () => {
    const file = freshCopy();
    let calls = 0;
    retagFile(file, fullTags, {
      cover: () => {
        calls += 1;
        return {
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          mime: "image/png",
        };
      },
    });
    expect(calls).toBe(1);

    const meta = await parseFile(file);
    expect(meta.common.picture).toHaveLength(1);
    expect(meta.common.picture?.[0]?.format).toBe("image/png");
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
