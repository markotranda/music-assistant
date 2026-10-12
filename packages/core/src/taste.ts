/**
 * Taste profile + taste-fit scoring (PLAN.md §4.1, §4.3). Pure functions:
 * the server assembles inputs (scrobbles, scores, tags), this module turns
 * them into a profile and scores candidates with an EXPLAINABLE breakdown —
 * the "why suggested" column is a first-class output.
 */

export type WeightMap = Record<string, number>;

export type TasteProfile = {
  /** artist name -> 0..1 (scrobble plays + tracked-band score boosts). */
  bandAffinity: WeightMap;
  /** lowercase genre tag -> 0..1. */
  genreWeights: WeightMap;
  /** decade ("1990s") -> 0..1. */
  eraWeights: WeightMap;
};

export type CandidateKind = "related" | "new_release" | "trending" | "missing_track";

export type TasteCandidate = {
  kind: CandidateKind;
  artistName: string;
  /** For related artists: the seed band and Last.fm's 0..1 match. */
  similarTo?: { name: string; match: number };
  /** The candidate's genre tags (any case). */
  tags?: string[];
  /** For releases: "YYYY", "YYYY-MM" or "YYYY-MM-DD". */
  releaseDate?: string;
};

export type TasteFitPart = {
  label: string;
  points: number;
  max: number;
};

export type TasteFit = {
  score: number;
  parts: TasteFitPart[];
};

/** Raw signals -> normalized profile (each map sums into 0..1 individual weights). */
export type TasteInput = {
  /** artist name -> raw affinity signal (plays + score boosts), >= 0. */
  artistWeights: WeightMap;
  /** artist name -> genre tags (any case). */
  artistTags: Record<string, string[]>;
  /** decade ("1990s") -> raw weight. */
  decadeWeights: WeightMap;
};

function normalize(map: WeightMap): WeightMap {
  const max = Math.max(0, ...Object.values(map));
  if (max <= 0) return {};
  const out: WeightMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (value > 0) out[key] = value / max;
  }
  return out;
}

export function buildTasteProfile(input: TasteInput): TasteProfile {
  const bandAffinity = normalize(input.artistWeights);

  // Genres accumulate each artist's weight under its tags; a tag's strength is
  // how much of your listening leans on artists that carry it.
  const genreRaw: WeightMap = {};
  for (const [artist, tags] of Object.entries(input.artistTags)) {
    const weight = input.artistWeights[artist] ?? 0;
    if (weight <= 0) continue;
    for (const tag of new Set(tags.map((t) => t.trim().toLowerCase()))) {
      if (tag) genreRaw[tag] = (genreRaw[tag] ?? 0) + weight;
    }
  }

  return {
    bandAffinity,
    genreWeights: normalize(genreRaw),
    eraWeights: normalize(input.decadeWeights),
  };
}

export function decadeOf(releaseDate: string): string | null {
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  if (!Number.isFinite(year) || year < 1000 || year > 3000) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

const AFFINITY_MAX = 45;
const GENRE_MAX = 35;
const ERA_MAX = 20;

/**
 * Taste-fit 0..100 with the points breakdown shown in the queue. Parts that
 * don't apply (no tags known, no release date) are excluded from the total so
 * a related artist and a new release stay comparable on the same 0..100 axis.
 * Affinity lookups are case-insensitive ("Terror" matches "terror").
 */
export function computeTasteFit(profile: TasteProfile, candidate: TasteCandidate): TasteFit {
  const parts: TasteFitPart[] = [];
  let earned = 0;
  let max = 0;

  const affinity: WeightMap = {};
  for (const [name, weight] of Object.entries(profile.bandAffinity)) {
    affinity[name.toLowerCase()] = weight;
  }
  const affinityOf = (name: string) => affinity[name.trim().toLowerCase()] ?? 0;

  // Affinity: this band itself, or similarity to a band you love.
  const own = affinityOf(candidate.artistName);
  if (candidate.similarTo) {
    const seed = affinityOf(candidate.similarTo.name) || 0.5;
    const points = AFFINITY_MAX * candidate.similarTo.match * (0.4 + 0.6 * seed);
    max += AFFINITY_MAX;
    earned += points;
    parts.push({
      label: `similar to ${candidate.similarTo.name} (${Math.round(candidate.similarTo.match * 100)}% match)`,
      points: Math.round(points),
      max: AFFINITY_MAX,
    });
  } else {
    const points = AFFINITY_MAX * own;
    max += AFFINITY_MAX;
    earned += points;
    parts.push({
      label: own > 0 ? `in your rotation (${Math.round(own * 100)}% affinity)` : "new to you",
      points: Math.round(points),
      max: AFFINITY_MAX,
    });
  }

  // Genre overlap with the tags you lean on.
  if (candidate.tags && candidate.tags.length > 0) {
    const overlap = Math.min(
      1,
      candidate.tags
        .map((t) => profile.genreWeights[t.trim().toLowerCase()] ?? 0)
        .reduce((a, b) => a + b, 0),
    );
    const points = GENRE_MAX * overlap;
    max += GENRE_MAX;
    earned += points;
    const top = candidate.tags
      .map((t) => t.trim().toLowerCase())
      .sort((a, b) => (profile.genreWeights[b] ?? 0) - (profile.genreWeights[a] ?? 0))
      .slice(0, 3)
      .join(", ");
    parts.push({
      label: top ? `genre overlap (${top})` : "genre overlap",
      points: Math.round(points),
      max: GENRE_MAX,
    });
  }

  // Era preference, when the candidate has a release date AND the profile has
  // era data at all (otherwise the part would just drag every score down).
  const decade = candidate.releaseDate ? decadeOf(candidate.releaseDate) : null;
  if (decade && Object.keys(profile.eraWeights).length > 0) {
    const weight = profile.eraWeights[decade] ?? 0;
    const points = ERA_MAX * weight;
    max += ERA_MAX;
    earned += points;
    parts.push({
      label: `${decade} release`,
      points: Math.round(points),
      max: ERA_MAX,
    });
  }

  const score = max > 0 ? Math.round((earned / max) * 100) : 0;
  return { score: Math.min(100, Math.max(0, score)), parts };
}
