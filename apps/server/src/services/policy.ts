import {
  type AcquireVerdict,
  type CandidateVerdict,
  canAcquire,
  decayProposals,
  evaluateCandidate,
  normTitle,
  type PolicyConfig,
  type PruneProposal,
  type Scenario,
  type Simulation,
  simulatePolicy,
  type TrackPlay,
} from "@ma/core";
import {
  allArtistTags,
  countTracksByStatus,
  deletePlanRow,
  getSetting,
  listArtists,
  listPlanRows,
  listTracks,
  sumOwnedBytes,
  updateTrackPlayData,
} from "../db/repositories.js";
import { scrobbles, tracks } from "../db/schema.js";
import { DEFAULT_POLICY, type PolicySettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { logEvent } from "./events.js";

/**
 * Policy engine wiring (PLAN.md §4.2): gate evaluation, genre shares, budget
 * state, decay/prune and the simulator — all driven by the pure functions in
 * @ma/core. Every blocked or pruned item leaves an event with its reason.
 */

export function policyConfig(deps: AppDeps): PolicyConfig {
  return getSetting<PolicySettings>(deps.db, "policy") ?? DEFAULT_POLICY;
}

/**
 * Genre share per tag: the fraction of planned tracks by artists carrying the
 * tag. Tags overlap (a band counts toward each of its tags), so shares read as
 * "how much of the library touches this genre" and can sum above 1.
 */
export function genreShares(deps: AppDeps): Record<string, number> {
  const tagsByArtist = new Map<number, string[]>();
  for (const row of allArtistTags(deps.db)) {
    const list = tagsByArtist.get(row.artistId) ?? [];
    list.push(row.tag);
    tagsByArtist.set(row.artistId, list);
  }
  if (tagsByArtist.size === 0) return {};

  const planCounts = new Map<number, number>();
  let total = 0;
  for (const artistId of tagsByArtist.keys()) {
    const n = listPlanRows(deps.db, artistId).length;
    planCounts.set(artistId, n);
    total += n;
  }
  if (total === 0) return {};

  const share: Record<string, number> = {};
  for (const [artistId, tags] of tagsByArtist) {
    const count = planCounts.get(artistId) ?? 0;
    for (const tag of tags) {
      share[tag] = (share[tag] ?? 0) + count / total;
    }
  }
  return share;
}

/** Tags cached for an artist (used when scoring its candidates). */
export function artistTagNames(deps: AppDeps, artistId: number): string[] {
  return allArtistTags(deps.db)
    .filter((t) => t.artistId === artistId)
    .sort((a, b) => a.rank - b.rank)
    .map((t) => t.tag);
}

export function plannedTrackCount(deps: AppDeps, artistId: number): number {
  return listPlanRows(deps.db, artistId).length;
}

/** Gate a candidate with live policy + library context. */
export function verdictFor(
  deps: AppDeps,
  ctx: {
    tasteFit: number;
    artistName: string;
    artistId: number | null;
    tags: string[];
    /** Overrides the plan-count lookup (candidates for untracked acts). */
    artistPlannedTracks?: number;
  },
): CandidateVerdict {
  return evaluateCandidate(policyConfig(deps), {
    tasteFit: ctx.tasteFit,
    artistName: ctx.artistName,
    artistPlannedTracks:
      ctx.artistPlannedTracks ??
      (ctx.artistId !== null ? plannedTrackCount(deps, ctx.artistId) : 0),
    tags: ctx.tags,
    genreShare: genreShares(deps),
  });
}

/** Hard-budget state at acquire time (the monthly target is soft). */
export function acquireVerdict(deps: AppDeps): AcquireVerdict {
  return canAcquire(budgetInputs(deps));
}

export type BudgetState = {
  ownedTracks: number;
  maxTotalTracks: number;
  bytesUsed: number;
  maxTotalGb: number;
  acquiredThisMonth: number;
  monthlyBudgetTracks: number;
} & AcquireVerdict;

/** Full budget picture for the policy page, CLI and acquire gates. */
export function budgetState(deps: AppDeps): BudgetState {
  const policy = policyConfig(deps);
  const byStatus = countTracksByStatus(deps.db);
  return {
    ownedTracks: byStatus.OWNED ?? 0,
    maxTotalTracks: policy.maxTotalTracks,
    bytesUsed: sumOwnedBytes(deps.db),
    maxTotalGb: policy.maxTotalGb,
    acquiredThisMonth: acquiredThisMonth(deps.db),
    monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
    ...canAcquire(budgetInputs(deps)),
  };
}

function budgetInputs(deps: AppDeps): Parameters<typeof canAcquire>[0] {
  const policy = policyConfig(deps);
  return {
    libraryTracks: countTracksByStatus(deps.db).OWNED ?? 0,
    libraryBytes: sumOwnedBytes(deps.db),
    maxTotalTracks: policy.maxTotalTracks,
    maxTotalGb: policy.maxTotalGb,
    acquiredThisMonth: acquiredThisMonth(deps.db),
    monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
  };
}

function acquiredThisMonth(db: AppDeps["db"]): number {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  return db
    .select()
    .from(tracks)
    .all()
    .filter((r) => (r.acquiredAt ?? "").startsWith(monthPrefix)).length;
}

// ------------------------------------------------------ play data & decay

/** Matches scrobbles to owned tracks by (artist, norm title) — fills play data. */
export function syncTrackPlayData(deps: AppDeps): number {
  const plays = new Map<string, { playCount: number; lastPlayed: string | null }>();
  for (const s of deps.db.select().from(scrobbles).all()) {
    const key = `${s.artistName.trim().toLowerCase()}\u0000${normTitle(s.title)}`;
    const row = plays.get(key) ?? { playCount: 0, lastPlayed: null };
    row.playCount += 1;
    if (!row.lastPlayed || s.playedAt > row.lastPlayed) row.lastPlayed = s.playedAt;
    plays.set(key, row);
  }

  let updated = 0;
  for (const track of listTracks(deps.db, { status: "OWNED" })) {
    const play = plays.get(`${track.artistName.trim().toLowerCase()}\u0000${track.normTitle}`);
    const playCount = play?.playCount ?? 0;
    const lastPlayed = play?.lastPlayed ?? null;
    if (playCount !== track.playCount || lastPlayed !== track.lastPlayed) {
      updateTrackPlayData(deps.db, track.id, { playCount, lastPlayed });
      updated += 1;
    }
  }
  return updated;
}

export type PruneReport = {
  generatedAt: string;
  decayMonths: number;
  autoPruneEnabled: boolean;
  proposals: PruneProposal[];
  /** Bytes freed if every proposal retires. */
  reclaimableBytes: number;
  summary: string;
};

export function pruneReport(deps: AppDeps, now = new Date()): PruneReport {
  const policy = policyConfig(deps);
  const playState: TrackPlay[] = listTracks(deps.db, { status: "OWNED" }).map((t) => ({
    norm: t.normTitle,
    title: t.title,
    artistName: t.artistName,
    lastPlayed: t.lastPlayed,
    playCount: t.playCount,
    acquiredAt: t.acquiredAt,
    sizeBytes: t.sizeBytes,
  }));
  const proposals = decayProposals(playState, { now, decayMonths: policy.decayMonths });
  const reclaimableBytes = proposals.reduce((n, p) => n + (p.sizeBytes ?? 0), 0);
  return {
    generatedAt: now.toISOString(),
    decayMonths: policy.decayMonths,
    autoPruneEnabled: policy.autoPruneEnabled,
    proposals,
    reclaimableBytes,
    summary:
      proposals.length === 0
        ? "nothing to prune — every owned track was played within the decay window"
        : `${proposals.length} track${proposals.length === 1 ? "" : "s"} idle over ${policy.decayMonths} months (${(reclaimableBytes / 1024 ** 2).toFixed(0)} MB reclaimable)`,
  };
}

/**
 * Retires pruned tracks to _retired/<Band>/ (recoverable) and drops their plan
 * rows — the legacy retire-not-delete flow, applied to decay proposals.
 */
export function applyPrune(
  deps: AppDeps,
  opts: { norms?: string[]; now?: Date } = {},
): { retired: { artist: string; fileName: string }[]; skipped: string[] } {
  const report = pruneReport(deps, opts.now);
  const wanted = opts.norms ? new Set(opts.norms) : null;
  const artistsByName = new Map(listArtists(deps.db).map((a) => [a.name, a]));
  const retired: { artist: string; fileName: string }[] = [];
  const skipped: string[] = [];

  for (const proposal of report.proposals) {
    if (wanted && !wanted.has(proposal.norm)) continue;
    const artist = artistsByName.get(proposal.artistName);
    const file = artist
      ? deps.collection
          .listBandFiles(proposal.artistName)
          .find((f) => normFromFileName(f.fileName) === proposal.norm)
      : undefined;
    if (!artist || !file) {
      skipped.push(proposal.norm);
      continue;
    }
    deps.collection.retireFiles(proposal.artistName, [{ fileName: file.fileName }]);
    if (listPlanRows(deps.db, artist.id).some((p) => p.normTitle === proposal.norm)) {
      deletePlanRow(deps.db, artist.id, proposal.norm);
    }
    retired.push({ artist: proposal.artistName, fileName: file.fileName });
  }

  logEvent(deps, "prune_applied", {
    retired: retired.length,
    skipped: skipped.length,
    auto: opts.norms === undefined,
  });
  return { retired, skipped };
}

/** "<NN> - Title.ext" (or "Title.ext") on disk -> the plan's norm title. */
export function normFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const titlePart = base.replace(/^\d+\s*-\s*/, "");
  return normTitle(titlePart);
}

// --------------------------------------------------------------- simulator

export function simulate(deps: AppDeps, scenario: Scenario): Simulation {
  const byStatus = countTracksByStatus(deps.db);
  return simulatePolicy(
    {
      artists: listArtists(deps.db).map((a) => ({
        name: a.name,
        score: (a.score === 0 ? 1 : a.score) as 1 | 2 | 3,
        catalogSize: a.catalogSize,
        plannedTracks: listPlanRows(deps.db, a.id).length,
      })),
      libraryTracks: byStatus.OWNED ?? 0,
      libraryBytes: sumOwnedBytes(deps.db),
      acquiredThisMonth: acquiredThisMonth(deps.db),
      policy: policyConfig(deps),
    },
    scenario,
  );
}
