import { cleanTitle, foldText, isAltVersion, normTitle } from "./text.js";
import type { RankedTrack } from "./types.js";

/** Raw popularity entry as returned by Last.fm (or similar sources). */
export type RawRankedTrack = {
  name: string;
  plays: number;
};

/**
 * Ranks raw popularity entries into deduped, filtered track picks — the pure
 * part of the legacy Get-RankedTracks: drop alt versions (live/demo/remix...),
 * dedupe on the normalized title (first/highest-ranked wins), and keep a clean
 * display title (falling back to the folded raw title).
 */
export function rankTracks(raw: RawRankedTrack[]): RankedTrack[] {
  const out: RankedTrack[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (isAltVersion(t.name)) continue;
    const norm = normTitle(t.name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ title: cleanTitle(t.name) || foldText(t.name), norm, plays: t.plays });
  }
  return out;
}
