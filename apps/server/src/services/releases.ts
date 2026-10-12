import { computeTasteFit, type TasteFitPart } from "@ma/core";
import { insertAlbum, listArtists } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { createCandidateIfNew, isIgnored, maybeAutoApprove, trendsSettings } from "./candidates.js";
import { logEvent } from "./events.js";
import { artistTagNames, verdictFor } from "./policy.js";
import { scoringProfile } from "./taste.js";

/**
 * Release radar (PLAN.md §4.3): MusicBrainz release-groups newer than the
 * lookback window become `new_release` candidates ("Metallica released X"),
 * deduped by release-group MBID so re-runs never spam the queue.
 */

export type ReleaseRadarResult = {
  created: number;
  found: number;
  artistsChecked: number;
  /** Blocked by policy gates (below taste-fit threshold or band cap). */
  gated: number;
};

export async function runReleaseRadar(deps: AppDeps): Promise<ReleaseRadarResult> {
  const trends = trendsSettings(deps);
  const profile = scoringProfile(deps);
  const since = new Date(Date.now() - trends.radarLookbackDays * 86400_000)
    .toISOString()
    .slice(0, 10);

  const result: ReleaseRadarResult = { created: 0, found: 0, artistsChecked: 0, gated: 0 };
  const failures: string[] = [];

  for (const artist of listArtists(deps.db)) {
    if (isIgnored(deps, artist.name)) continue;
    result.artistsChecked += 1;

    let groups: Awaited<ReturnType<typeof deps.musicbrainz.getRecentReleaseGroups>>;
    try {
      groups = await deps.musicbrainz.getRecentReleaseGroups(artist.mbid, since);
    } catch (err) {
      failures.push(`${artist.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const group of groups) {
      result.found += 1;
      // Record the release with its date — feeds era weights over time.
      insertAlbum(deps.db, {
        artistId: artist.id,
        mbid: group.id,
        title: group.title,
        releaseDate: group.firstReleaseDate,
        type: group.primaryType,
      });

      const fit = computeTasteFit(profile, {
        kind: "new_release",
        artistName: artist.name,
        releaseDate: group.firstReleaseDate ?? undefined,
      });

      // Releases inherit the artist's cached tags for the genre-balance gate.
      const tags = artistTagNames(deps, artist.id);
      const verdict = verdictFor(deps, {
        tasteFit: fit.score,
        artistName: artist.name,
        artistId: artist.id,
        tags,
      });
      if (!verdict.pass) {
        result.gated += 1;
        logEvent(deps, "candidate_gated", {
          name: `${artist.name} — ${group.title}`,
          type: "new_release",
          gates: verdict.gates.filter((g) => !g.pass).map((g) => g.detail),
        });
        continue;
      }

      const createdId = createCandidateIfNew(deps, {
        type: "new_release",
        key: `rg:${group.id}`,
        artistId: artist.id,
        payload: {
          artistName: artist.name,
          title: group.title,
          rgMbid: group.id,
          releaseDate: group.firstReleaseDate,
          primaryType: group.primaryType,
          secondaryTypes: group.secondaryTypes,
          why: fit.parts as TasteFitPart[],
          policy: verdict.gates,
        },
        tasteFit: verdict.score,
        reason: `${artist.name} released ${group.title}${
          group.firstReleaseDate ? ` (${group.firstReleaseDate})` : ""
        }${verdict.penalty > 0 ? ` · −${verdict.penalty} genre balance` : ""}`,
      });
      if (createdId !== null) {
        result.created += 1;
        await maybeAutoApprove(deps, createdId, verdict);
      }
    }
  }

  logEvent(deps, "release_radar_run", { ...result, failures: failures.length });
  if (failures.length > 0 && result.artistsChecked === failures.length) {
    throw new Error(`release radar failed for all artists: ${failures.join("; ")}`);
  }
  return result;
}
