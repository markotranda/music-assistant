/**
 * Anti-overload policy engine (PLAN.md §4.2) — the heart of "doesn't overload".
 * Pure functions over explicit state: gates, budget ordering, decay proposals,
 * rank rotation and the policy simulator. The server wires these into jobs and
 * routes; every decision renders as typed gate results with human reasons.
 */

import { getQuota, type QuotaFormula } from "./formula.js";
import type { ScoreTier } from "./types.js";

export type ApprovalMode = "manual" | "hybrid" | "auto";

export type PolicyConfig = {
  /** manual: everything waits in the queue; hybrid: auto ≥ autoApproveFit; auto: all gates pass. */
  approvalMode: ApprovalMode;
  /** Hard gate: candidates below this never enter the queue. */
  tasteFitThreshold: number;
  /** Hybrid mode auto-approves at/above this adjusted score. */
  autoApproveFit: number;
  /** Hard cap: planned tracks per band (on top of the formula's score caps). */
  bandHardMaxTracks: number;
  /** Soft cap: genre shares above this get a score penalty instead of a block. */
  genreSoftCapShare: number;
  /** Hard global budgets (enforced at acquire time). */
  maxTotalTracks: number;
  maxTotalGb: number;
  /** Soft monthly target — overflow is allowed, spend is just tracked and reported. */
  monthlyAcquisitionBudgetTracks: number;
  /** Unplayed tracks older than this decay toward rotation/retired. */
  decayMonths: number;
  rotationEnabled: boolean;
  /** Weekly prune report cadence (the report endpoint always works on demand). */
  pruneReportEnabled: boolean;
  autoPruneEnabled: boolean;
};

export type GateName = "taste_fit" | "band_cap" | "genre_balance" | "global_tracks" | "global_size";

export type GateResult = {
  name: GateName;
  pass: boolean;
  detail: string;
};

export type CandidateContext = {
  /** Taste-fit 0..100 from the taste engine. */
  tasteFit: number;
  artistName: string;
  /** Planned (not yet owned) track count for this artist, excluding the candidate. */
  artistPlannedTracks: number;
  /** The candidate's genre tags (lowercase). */
  tags: string[];
  /** tag -> current library share 0..1 (from artist_tags + plan counts). */
  genreShare: Record<string, number>;
};

export type CandidateVerdict = {
  /** Hard gates all passed (taste_fit, band_cap). */
  pass: boolean;
  /** Score after the soft genre penalty — what the queue displays. */
  score: number;
  penalty: number;
  gates: GateResult[];
};

/** Soft genre over-representation penalty (kept "soft but effective"). */
export const GENRE_PENALTY = 15;

/**
 * Gate a candidate: taste-fit threshold and per-band cap are hard; genre
 * balance is a soft score penalty so an over-represented genre ranks lower
 * instead of vanishing.
 */
export function evaluateCandidate(policy: PolicyConfig, ctx: CandidateContext): CandidateVerdict {
  const gates: GateResult[] = [];

  const fitPass = ctx.tasteFit >= policy.tasteFitThreshold;
  gates.push({
    name: "taste_fit",
    pass: fitPass,
    detail: `taste-fit ${ctx.tasteFit} ${fitPass ? "≥" : "<"} threshold ${policy.tasteFitThreshold}`,
  });

  const bandPass = ctx.artistPlannedTracks < policy.bandHardMaxTracks;
  gates.push({
    name: "band_cap",
    pass: bandPass,
    detail: `${ctx.artistName}: ${ctx.artistPlannedTracks}/${policy.bandHardMaxTracks} planned tracks`,
  });

  const over = [...new Set(ctx.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
    .map((tag) => ({ tag, share: ctx.genreShare[tag] ?? 0 }))
    .filter((g) => g.share > policy.genreSoftCapShare)
    .sort((a, b) => b.share - a.share);

  const penalty = over.length > 0 ? GENRE_PENALTY : 0;
  gates.push({
    name: "genre_balance",
    pass: over.length === 0,
    detail:
      over.length > 0
        ? `over budget: ${over.map((g) => `${g.tag} ${Math.round(g.share * 100)}%`).join(", ")} (−${GENRE_PENALTY})`
        : "genres within budget",
  });

  return {
    pass: fitPass && bandPass,
    score: Math.max(0, ctx.tasteFit - penalty),
    penalty,
    gates,
  };
}

/** Should the approval mode auto-approve this verdict? */
export function autoApprove(policy: PolicyConfig, verdict: CandidateVerdict): boolean {
  if (!verdict.pass) return false;
  switch (policy.approvalMode) {
    case "auto":
      return true;
    case "hybrid":
      return verdict.score >= policy.autoApproveFit;
    default:
      return false;
  }
}

export type AcquireContext = {
  libraryTracks: number;
  libraryBytes: number;
  maxTotalTracks: number;
  maxTotalGb: number;
  acquiredThisMonth: number;
  monthlyBudgetTracks: number;
};

export type AcquireVerdict = {
  allowed: boolean;
  /** Monthly target is soft — overBudget reports without blocking. */
  overBudget: boolean;
  gates: GateResult[];
};

const BYTES_PER_GB = 1024 ** 3;

/** Hard budgets at acquire time. The monthly target is a tracked, soft guide. */
export function canAcquire(ctx: AcquireContext): AcquireVerdict {
  const gates: GateResult[] = [];

  const tracksPass = ctx.libraryTracks < ctx.maxTotalTracks;
  gates.push({
    name: "global_tracks",
    pass: tracksPass,
    detail: `${ctx.libraryTracks}/${ctx.maxTotalTracks} tracks`,
  });

  const sizePass = ctx.libraryBytes < ctx.maxTotalGb * BYTES_PER_GB;
  gates.push({
    name: "global_size",
    pass: sizePass,
    detail: `${(ctx.libraryBytes / BYTES_PER_GB).toFixed(1)}/${ctx.maxTotalGb} GB`,
  });

  return {
    allowed: tracksPass && sizePass,
    overBudget: ctx.acquiredThisMonth >= ctx.monthlyBudgetTracks,
    gates,
  };
}

/** Acquisitions run highest taste-fit first (PLAN §4.2 gate 4). */
export function orderAcquisitions<T extends { tasteFit: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.tasteFit ?? -1) - (a.tasteFit ?? -1));
}

// ------------------------------------------------------- decay & rotation

export type TrackPlay = {
  norm: string;
  title: string;
  artistName: string;
  /** ISO timestamp or null when never played since import. */
  lastPlayed: string | null;
  playCount: number;
  acquiredAt: string | null;
  sizeBytes: number | null;
};

export type PruneProposal = {
  norm: string;
  title: string;
  artistName: string;
  /** Why this track proposes retirement. */
  reason: string;
  /** Prune priority 0..100 — higher = more prunable. */
  priority: number;
  sizeBytes: number | null;
};

const DAY_MS = 86_400_000;

/**
 * Decay proposals: tracks unplayed for longer than `decayMonths` (never-played
 * counts from acquisition). Sorted most-prunable first. Deterministic over the
 * given `now`.
 */
export function decayProposals(
  tracks: TrackPlay[],
  opts: { now: Date; decayMonths: number },
): PruneProposal[] {
  const cutoff = opts.now.getTime() - opts.decayMonths * 30 * DAY_MS;
  const proposals: PruneProposal[] = [];

  for (const t of tracks) {
    const reference = t.lastPlayed ?? t.acquiredAt;
    if (!reference) continue; // no timeline yet — nothing to judge
    const refMs = Date.parse(reference);
    if (!Number.isFinite(refMs) || refMs >= cutoff) continue;

    const idleDays = Math.floor((opts.now.getTime() - refMs) / DAY_MS);
    const neverPlayed = t.lastPlayed === null;
    // Priority: idle time drives it; a little play history buys grace.
    const priority = Math.min(
      100,
      Math.round(idleDays / 30) * 5 + (neverPlayed ? 20 : 0) - Math.min(20, t.playCount * 2),
    );
    proposals.push({
      norm: t.norm,
      title: t.title,
      artistName: t.artistName,
      reason: neverPlayed
        ? `unplayed since acquisition (${idleDays} days)`
        : `last played ${Math.floor(idleDays / 30)} months ago (${t.playCount} plays)`,
      priority: Math.max(0, priority),
      sizeBytes: t.sizeBytes,
    });
  }

  return proposals.sort((a, b) => b.priority - a.priority || a.norm.localeCompare(b.norm));
}

export type RankInput = {
  norm: string;
  globalPlays: number;
  ownPlays: number;
};

/** Your own plays count for more than global popularity when rotating ranks. */
export const OWN_PLAY_WEIGHT = 5;

/**
 * Rotation rank order: global popularity blended with your own listening.
 * Returns norms in the new rank order (1-based rank = index + 1).
 */
export function rotationRanks(inputs: RankInput[]): string[] {
  return [...inputs]
    .sort(
      (a, b) =>
        b.globalPlays +
          b.ownPlays * OWN_PLAY_WEIGHT -
          (a.globalPlays + a.ownPlays * OWN_PLAY_WEIGHT) || a.norm.localeCompare(b.norm),
    )
    .map((i) => i.norm);
}

// ------------------------------------------------------------ simulator

export type Scenario = {
  /** artist name (case-insensitive) -> new score tier. */
  scoreChanges?: Record<string, number>;
  policyPatch?: Partial<PolicyConfig>;
};

export type SimArtist = {
  name: string;
  score: ScoreTier;
  catalogSize: number | null;
  plannedTracks: number;
};

export type SimState = {
  artists: SimArtist[];
  libraryTracks: number;
  libraryBytes: number;
  acquiredThisMonth: number;
  policy: PolicyConfig;
  formula?: QuotaFormula;
};

export type SimChange = {
  artist: string;
  scoreBefore: ScoreTier;
  scoreAfter: ScoreTier;
  quotaBefore: number;
  quotaAfter: number;
  /** quotaAfter − quotaBefore (planned tracks to add or retire). */
  deltaTracks: number;
};

export type Simulation = {
  policy: PolicyConfig;
  changes: SimChange[];
  library: {
    tracksNow: number;
    tracksProjected: number;
    maxTotalTracks: number;
    acquiredThisMonth: number;
    monthlyBudgetTracks: number;
  };
  summary: string;
};

const DEFAULT_CATALOG = 100;

/**
 * "What would change if I set score 3 on X / lower the budget?" — projects
 * quotas for score changes and re-evaluates the hard budgets under a policy
 * patch. Pure projection: nothing is applied.
 */
export function simulatePolicy(state: SimState, scenario: Scenario): Simulation {
  const policy: PolicyConfig = { ...state.policy, ...scenario.policyPatch };
  const formula = state.formula;

  const changes: SimChange[] = [];
  for (const artist of state.artists) {
    const wanted =
      scenario.scoreChanges?.[artist.name] ?? scenario.scoreChanges?.[artist.name.toLowerCase()];
    if (wanted === undefined || ![1, 2, 3].includes(wanted)) continue;
    const scoreAfter = wanted as ScoreTier;
    if (scoreAfter === artist.score) continue;

    const catalog = artist.catalogSize ?? DEFAULT_CATALOG;
    const quotaBefore = Math.min(
      getQuota(artist.score, catalog, formula),
      policy.bandHardMaxTracks,
    );
    const quotaAfter = Math.min(getQuota(scoreAfter, catalog, formula), policy.bandHardMaxTracks);
    changes.push({
      artist: artist.name,
      scoreBefore: artist.score,
      scoreAfter,
      quotaBefore,
      quotaAfter,
      deltaTracks: quotaAfter - quotaBefore,
    });
  }

  const deltaTotal = changes.reduce((n, c) => n + c.deltaTracks, 0);
  const tracksProjected = Math.max(0, state.libraryTracks + deltaTotal);
  const budgetState = canAcquire({
    libraryTracks: tracksProjected,
    libraryBytes: state.libraryBytes,
    maxTotalTracks: policy.maxTotalTracks,
    maxTotalGb: policy.maxTotalGb,
    acquiredThisMonth: state.acquiredThisMonth,
    monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
  });

  const summary =
    changes.length === 0
      ? `no quota changes; library stays at ${state.libraryTracks} tracks`
      : changes
          .map(
            (c) =>
              `${c.artist}: score ${c.scoreBefore}→${c.scoreAfter} ⇒ quota ${c.quotaBefore}→${c.quotaAfter} (${c.deltaTracks >= 0 ? "+" : ""}${c.deltaTracks})`,
          )
          .join("; ") +
        ` ⇒ library ${state.libraryTracks}→${tracksProjected} of ${policy.maxTotalTracks} tracks` +
        (budgetState.allowed ? "" : " — hard budget would block acquisitions");

  return {
    policy,
    changes,
    library: {
      tracksNow: state.libraryTracks,
      tracksProjected,
      maxTotalTracks: policy.maxTotalTracks,
      acquiredThisMonth: state.acquiredThisMonth,
      monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
    },
    summary,
  };
}
