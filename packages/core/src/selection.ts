import { DEFAULT_QUOTA_FORMULA, roundHalfToEven } from "./formula.js";
import type { RankedTrack } from "./types.js";

/**
 * Track selection, ported from the legacy Select-Tracks.
 *
 * Score 1/2 (or when the catalog fits the quota): straight top-N by popularity.
 * Score 3: 65% top hits + 35% deep cuts, sampled with a fixed step from a
 * window of the next deepN×4 ranked tracks, so loved bands get depth without
 * flooding the library.
 *
 * Deviation from legacy: quota <= 0 returns [] (PowerShell's array slice
 * `0..-1` wraps around and returned garbage in that edge case).
 */
export function selectTracks(
  ranked: RankedTrack[],
  quota: number,
  score: number,
  deepShare: number = DEFAULT_QUOTA_FORMULA.deepShare,
): RankedTrack[] {
  if (ranked.length === 0 || quota <= 0) return [];
  if (score !== 3 || ranked.length <= quota) {
    return ranked.slice(0, Math.min(quota, ranked.length));
  }

  const topN = roundHalfToEven(quota * (1 - deepShare));
  const deepN = quota - topN;
  const chosen = ranked.slice(0, topN);

  const lo = topN;
  const hi = Math.min(ranked.length - 1, topN + deepN * 4);
  if (hi > lo && deepN > 0) {
    const step = Math.max(1, Math.floor((hi - lo + 1) / deepN));
    for (let d = 0; d < deepN; d++) {
      const idx = lo + d * step;
      if (idx <= hi) chosen.push(ranked[idx] as RankedTrack);
    }
  }
  return chosen;
}
