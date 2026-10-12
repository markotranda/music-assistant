import { computeTasteFit, type TasteFitPart } from "@ma/core";
import { listArtists, scrobblePlaysByArtist } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import {
  artistKey,
  createCandidateIfNew,
  isIgnored,
  maybeAutoApprove,
  trendsSettings,
} from "./candidates.js";
import { logEvent } from "./events.js";
import { verdictFor } from "./policy.js";
import { scoringProfile } from "./taste.js";

/**
 * Discovery feed (PLAN.md §4.3): Last.fm `artist.getSimilar` on the highest-
 * affinity tracked bands -> `related` candidates, scored by taste-fit with the
 * why breakdown. Deduped against tracked bands, ignored names and every
 * candidate ever created.
 */

export type DiscoveryResult = {
  created: number;
  skipped: number;
  considered: number;
  /** Blocked by policy gates (below taste-fit threshold or band cap). */
  gated: number;
};

export async function runDiscovery(deps: AppDeps): Promise<DiscoveryResult> {
  const trends = trendsSettings(deps);
  const profile = scoringProfile(deps);

  const plays = new Map(
    scrobblePlaysByArtist(deps.db).map((r) => [r.artistName.toLowerCase(), r.plays]),
  );
  const seeds = listArtists(deps.db)
    .filter((a) => !isIgnored(deps, a.name))
    .sort((a, b) => {
      const wa = (a.score ?? 0) * 50 + (plays.get(a.name.toLowerCase()) ?? 0);
      const wb = (b.score ?? 0) * 50 + (plays.get(b.name.toLowerCase()) ?? 0);
      return wb - wa;
    })
    .slice(0, trends.discoverySeeds);

  const tracked = new Set(listArtists(deps.db).map((a) => a.name.toLowerCase()));
  const result: DiscoveryResult = { created: 0, skipped: 0, considered: 0, gated: 0 };
  const failures: string[] = [];

  for (const seed of seeds) {
    let sims: Awaited<ReturnType<typeof deps.lastfm.getSimilarArtists>>;
    try {
      sims = await deps.lastfm.getSimilarArtists(seed.name, trends.discoveryDepth);
    } catch (err) {
      failures.push(`${seed.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const sim of sims) {
      result.considered += 1;
      const name = sim.name.trim();
      if (!name) continue;
      const key = artistKey(name);
      if (tracked.has(name.toLowerCase()) || isIgnored(deps, name)) {
        result.skipped += 1;
        continue;
      }

      let tags: string[] = [];
      try {
        tags = await deps.lastfm.getTopTags(name, 5);
      } catch {
        // Tag lookup is enrichment only — the candidate stands without genres.
      }

      const fit = computeTasteFit(profile, {
        kind: "related",
        artistName: name,
        similarTo: { name: seed.name, match: sim.match },
        tags,
      });

      // Policy gates (PLAN §4.2): below-threshold and over-cap candidates are
      // rejected at creation with their reasons logged — the queue stays clean.
      const verdict = verdictFor(deps, {
        tasteFit: fit.score,
        artistName: name,
        artistId: null,
        tags,
        artistPlannedTracks: 0,
      });
      if (!verdict.pass) {
        result.gated += 1;
        logEvent(deps, "candidate_gated", {
          name,
          type: "related",
          gates: verdict.gates.filter((g) => !g.pass).map((g) => g.detail),
        });
        continue;
      }

      const createdId = createCandidateIfNew(deps, {
        type: "related",
        key,
        artistId: null,
        payload: {
          name,
          mbid: sim.mbid,
          similarTo: { name: seed.name, match: sim.match },
          tags,
          why: fit.parts as TasteFitPart[],
          policy: verdict.gates,
        },
        tasteFit: verdict.score,
        reason:
          fit.parts.map((p) => p.label).join(" · ") +
          (verdict.penalty > 0 ? ` · −${verdict.penalty} genre balance` : ""),
      });
      if (createdId === null) {
        result.skipped += 1;
        continue;
      }
      result.created += 1;
      await maybeAutoApprove(deps, createdId, verdict);
    }
  }

  logEvent(deps, "discovery_run", { ...result, failures: failures.length });
  if (failures.length > 0 && result.created === 0 && result.considered === 0) {
    // Every seed failed — surface WHY instead of a silent empty feed.
    throw new Error(`discovery failed for all seeds: ${failures.join("; ")}`);
  }
  return result;
}
