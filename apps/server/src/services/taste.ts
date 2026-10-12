import { buildTasteProfile, decadeOf, type TasteProfile, type WeightMap } from "@ma/core";
import {
  listAlbums,
  listArtists,
  readTasteProfile,
  saveTasteProfile,
  scrobblePlaysByArtist,
} from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { logEvent } from "./events.js";

/**
 * Taste profile (PLAN.md §4.1): band affinity from scrobbles + tracked scores,
 * genre weights from Last.fm tags of the strongest artists, era weights from
 * the release dates of the albums you lean on. Recomputed by the scrobble sync
 * and discovery jobs; the persisted snapshot feeds candidate scoring.
 */

export type TasteProfileView = TasteProfile & { updatedAt: string | null };

/** How much a tracked band's score counts next to raw plays (fixture-pinned). */
export const SCORE_PLAY_BOOST = 50;

/** Top-N artists whose tags are fetched for genre weights. */
const TAG_SAMPLE = 25;

/** Raw affinity signal per lowercased artist name: plays + score boost. */
export function artistWeightMap(deps: AppDeps): {
  weights: WeightMap;
  display: Map<string, string>;
} {
  const weights: WeightMap = {};
  const display = new Map<string, string>();

  for (const row of scrobblePlaysByArtist(deps.db)) {
    const key = row.artistName.trim().toLowerCase();
    if (!key) continue;
    display.set(key, row.artistName);
    weights[key] = (weights[key] ?? 0) + row.plays;
  }
  for (const artist of listArtists(deps.db)) {
    const key = artist.name.trim().toLowerCase();
    if (!key) continue;
    if (!display.has(key)) display.set(key, artist.name);
    weights[key] = (weights[key] ?? 0) + (artist.score ?? 0) * SCORE_PLAY_BOOST;
  }
  return { weights, display };
}

/** The persisted snapshot, or an empty profile when none exists yet. */
export function readProfile(deps: AppDeps): TasteProfileView {
  const row = readTasteProfile(deps.db);
  if (!row) {
    return { bandAffinity: {}, genreWeights: {}, eraWeights: {}, updatedAt: null };
  }
  return {
    bandAffinity: {},
    genreWeights: JSON.parse(row.genreWeightsJson) as WeightMap,
    eraWeights: JSON.parse(row.eraWeightsJson) as WeightMap,
    updatedAt: row.updatedAt,
  };
}

/**
 * Recomputes the profile (network: one getTopTags per sampled artist) and
 * persists the genre/era snapshot. Tag failures degrade per artist and are
 * logged — never silent.
 */
export async function recomputeTasteProfile(deps: AppDeps): Promise<TasteProfileView> {
  const { weights, display } = artistWeightMap(deps);

  const artistTags: Record<string, string[]> = {};
  const top = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TAG_SAMPLE);
  let tagFailures = 0;
  for (const [key] of top) {
    try {
      artistTags[key] = await deps.lastfm.getTopTags(display.get(key) ?? key, 5);
    } catch (err) {
      tagFailures += 1;
      logEvent(deps, "taste_tags_degraded", {
        artist: display.get(key) ?? key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Era preference: the release decades of the albums you lean on, weighted by
  // the artist's affinity (tracked bands have albums; scrobbles have no years).
  const decadeWeights: WeightMap = {};
  for (const artist of listArtists(deps.db)) {
    const weight = weights[artist.name.trim().toLowerCase()] ?? 0;
    if (weight <= 0) continue;
    for (const album of listAlbums(deps.db, artist.id)) {
      const decade = decadeOf(album.releaseDate ?? "");
      if (decade) decadeWeights[decade] = (decadeWeights[decade] ?? 0) + weight;
    }
  }

  const profile = buildTasteProfile({ artistWeights: weights, artistTags, decadeWeights });
  saveTasteProfile(deps.db, profile);
  const updatedAt = new Date().toISOString();
  logEvent(deps, "taste_recomputed", {
    artists: Object.keys(weights).length,
    tagged: Object.keys(artistTags).length,
    tagFailures,
  });
  return { ...profile, updatedAt };
}

/**
 * Profile used for scoring: full affinity from live scrobbles/scores + the
 * persisted genre/era snapshot (which needs network calls to refresh).
 */
export function scoringProfile(deps: AppDeps): TasteProfile {
  const { weights } = artistWeightMap(deps);
  const stored = readProfile(deps);
  return {
    bandAffinity: normalize(weights),
    genreWeights: stored.genreWeights,
    eraWeights: stored.eraWeights,
  };
}

function normalize(map: WeightMap): WeightMap {
  const max = Math.max(0, ...Object.values(map));
  if (max <= 0) return {};
  const out: WeightMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (value > 0) out[key] = value / max;
  }
  return out;
}
