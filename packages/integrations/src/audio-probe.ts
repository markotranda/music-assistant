import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFile } from "music-metadata";

/**
 * Audio file probe: size + content hash + duration + tags. Used to verify that
 * canonical retagging actually stuck, and by the deep-verify job to detect
 * replaced/corrupt files (the legacy verify only compared row counts).
 */

export type AudioProbe = {
  filePath: string;
  sizeBytes: number;
  /** SHA-256 of the file contents. */
  hash: string;
  durationS: number | null;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
};

/**
 * Returns null for unreadable/empty/unparseable files — callers treat that as
 * "corrupt" and report it; nothing is swallowed without a meaning.
 */
export async function probeAudio(filePath: string): Promise<AudioProbe | null> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  try {
    const meta = await parseFile(filePath);
    const f = meta.format;
    // Random bytes don't make music-metadata throw — they just yield an empty
    // format. No container/codec/duration means no recognizable audio stream.
    if (!f.container && !f.codec && f.duration === undefined) return null;
    return {
      filePath,
      sizeBytes: bytes.length,
      hash: createHash("sha256").update(bytes).digest("hex"),
      durationS: f.duration ? Math.round(f.duration) : null,
      title: meta.common.title ?? null,
      artist: meta.common.artist ?? null,
      albumArtist: meta.common.albumartist ?? null,
      trackNumber: meta.common.track?.no ?? null,
    };
  } catch {
    return null;
  }
}
