import { normTitle, safeName } from "./text.js";
import type { DesiredTrack, OnDiskTrack, RankedTrack, RenameAction, SyncPlan } from "./types.js";

/** Files are named `NN - Title.ext` where NN is the popularity rank. */
const RANK_PREFIX_RX = /^\d+\s-\s/;
const TEMP_PREFIX = "~tmp~";

export type PinnedPick = { title: string; norm: string };

/**
 * Builds the desired track list for a band: selected picks get ranks 1..N,
 * pinned extras follow with continuing ranks (legacy Sync-Band semantics).
 * A pinned track that the selection already covers is dropped (no dupes).
 */
export function buildDesired(picks: RankedTrack[], pinned: PinnedPick[]): DesiredTrack[] {
  const pickNorms = new Set(picks.map((p) => p.norm));
  const desired: DesiredTrack[] = [];
  let r = 0;
  for (const p of picks) {
    r += 1;
    desired.push({ rank: r, title: p.title, norm: p.norm, pinned: false });
  }
  for (const p of pinned) {
    if (pickNorms.has(p.norm)) continue;
    r += 1;
    desired.push({ rank: r, title: p.title, norm: p.norm, pinned: true });
  }
  return desired;
}

/** Splits "01 - Title.mp3" into base "Title" and extension ".mp3". */
export function splitFileName(fileName: string): { base: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { base: fileName, extension: "" };
  return { base: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

/**
 * Indexes a band's folder by normalized title (first file per norm wins —
 * legacy behavior). Files are `NN - Title.ext`; the rank prefix is stripped
 * before normalizing.
 */
export function indexOnDisk(files: { fileName: string }[]): OnDiskTrack[] {
  const seen = new Map<string, OnDiskTrack>();
  for (const f of files) {
    const { base, extension } = splitFileName(f.fileName);
    const title = base.replace(RANK_PREFIX_RX, "");
    const norm = normTitle(title);
    if (!norm || seen.has(norm)) continue;
    seen.set(norm, { norm, fileName: f.fileName, title, extension });
  }
  return [...seen.values()];
}

/** Final file name for a desired track, given its current extension. */
export function targetFileName(d: DesiredTrack, extension: string): string {
  return `${String(d.rank).padStart(2, "0")} - ${safeName(d.title)}${extension}`;
}

/**
 * Desired-state diff for one band folder.
 *
 * - `acquire`: desired but not on disk.
 * - `retire`:  on disk but not desired (moved to _retired, never deleted —
 *   "a downgrade should be reversible").
 * - `renames`: rank/title changes, always executed in two phases (via ~tmp~)
 *   so shuffled ranks never collide mid-flight.
 */
export function planSync(desired: DesiredTrack[], onDisk: OnDiskTrack[]): SyncPlan {
  const have = new Map(onDisk.map((f) => [f.norm, f]));
  const desiredNorms = new Set(desired.map((d) => d.norm));

  const acquire = desired.filter((d) => !have.has(d.norm));
  const retire = onDisk.filter((f) => !desiredNorms.has(f.norm));

  const renames: RenameAction[] = [];
  for (const d of desired) {
    const f = have.get(d.norm);
    if (!f) continue;
    const to = targetFileName(d, f.extension);
    if (f.fileName !== to) {
      renames.push({ from: f.fileName, viaTemp: TEMP_PREFIX + to, to });
    }
  }

  return { acquire, retire, renames };
}
