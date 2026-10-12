import { describe, expect, it } from "vitest";
import {
  autoApprove,
  canAcquire,
  decayProposals,
  evaluateCandidate,
  GENRE_PENALTY,
  orderAcquisitions,
  type PolicyConfig,
  rotationRanks,
  simulatePolicy,
} from "../src/policy";

const policy: PolicyConfig = {
  approvalMode: "manual",
  tasteFitThreshold: 70,
  autoApproveFit: 85,
  bandHardMaxTracks: 40,
  genreSoftCapShare: 0.5,
  maxTotalTracks: 5000,
  maxTotalGb: 50,
  monthlyAcquisitionBudgetTracks: 40,
  decayMonths: 12,
  rotationEnabled: true,
  pruneReportEnabled: true,
  autoPruneEnabled: false,
};

describe("evaluateCandidate", () => {
  const ctx = {
    tasteFit: 90,
    artistName: "Terror",
    artistPlannedTracks: 10,
    tags: ["hardcore"],
    genreShare: { hardcore: 0.2 },
  };

  it("passes a clean candidate with its score intact", () => {
    const v = evaluateCandidate(policy, ctx);
    expect(v.pass).toBe(true);
    expect(v.score).toBe(90);
    expect(v.penalty).toBe(0);
    expect(v.gates.map((g) => [g.name, g.pass])).toEqual([
      ["taste_fit", true],
      ["band_cap", true],
      ["genre_balance", true],
    ]);
  });

  it("hard-blocks below the taste-fit threshold", () => {
    const v = evaluateCandidate(policy, { ...ctx, tasteFit: 69 });
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.name === "taste_fit")?.detail).toContain("69 < threshold 70");
  });

  it("hard-blocks when the band is at its planned cap", () => {
    const v = evaluateCandidate(policy, { ...ctx, artistPlannedTracks: 40 });
    expect(v.pass).toBe(false);
    expect(v.gates.find((g) => g.name === "band_cap")?.detail).toContain("40/40");
  });

  it("soft-penalizes over-represented genres instead of blocking", () => {
    const v = evaluateCandidate(policy, {
      ...ctx,
      tags: ["hardcore", "punk"],
      genreShare: { hardcore: 0.8, punk: 0.1 },
    });
    expect(v.pass).toBe(true); // soft gate
    expect(v.penalty).toBe(GENRE_PENALTY);
    expect(v.score).toBe(90 - GENRE_PENALTY);
    expect(v.gates.find((g) => g.name === "genre_balance")?.detail).toContain("hardcore 80%");
    // Duplicate tags never double-penalize.
    expect(
      evaluateCandidate(policy, {
        ...ctx,
        tags: ["hardcore", "HARDCORE"],
        genreShare: { hardcore: 0.8 },
      }).penalty,
    ).toBe(GENRE_PENALTY);
  });
});

describe("autoApprove", () => {
  const pass = evaluateCandidate(policy, {
    tasteFit: 90,
    artistName: "X",
    artistPlannedTracks: 0,
    tags: [],
    genreShare: {},
  });
  const borderline = evaluateCandidate(policy, {
    tasteFit: 80,
    artistName: "X",
    artistPlannedTracks: 0,
    tags: [],
    genreShare: {},
  });

  it("manual never auto-approves", () => {
    expect(autoApprove(policy, pass)).toBe(false);
  });

  it("hybrid approves only at/above the fit threshold", () => {
    const hybrid = { ...policy, approvalMode: "hybrid" as const };
    expect(autoApprove(hybrid, pass)).toBe(true); // 90 >= 85
    expect(autoApprove(hybrid, borderline)).toBe(false); // 80 < 85
  });

  it("auto approves everything that passes the gates", () => {
    const auto = { ...policy, approvalMode: "auto" as const };
    expect(autoApprove(auto, borderline)).toBe(true);
    const blocked = evaluateCandidate(auto, {
      tasteFit: 10,
      artistName: "X",
      artistPlannedTracks: 0,
      tags: [],
      genreShare: {},
    });
    expect(autoApprove(auto, blocked)).toBe(false);
  });
});

describe("canAcquire", () => {
  const ctx = {
    libraryTracks: 100,
    libraryBytes: 1024 ** 3,
    maxTotalTracks: 5000,
    maxTotalGb: 50,
    acquiredThisMonth: 5,
    monthlyBudgetTracks: 40,
  };

  it("allows within hard budgets and reports the soft monthly target", () => {
    const v = canAcquire(ctx);
    expect(v.allowed).toBe(true);
    expect(v.overBudget).toBe(false);
    expect(v.gates.map((g) => g.pass)).toEqual([true, true]);
  });

  it("hard-blocks at the track and size ceilings but never on the monthly target", () => {
    expect(canAcquire({ ...ctx, libraryTracks: 5000 }).allowed).toBe(false);
    expect(canAcquire({ ...ctx, libraryBytes: 50 * 1024 ** 3 }).allowed).toBe(false);
    const over = canAcquire({ ...ctx, acquiredThisMonth: 120 });
    expect(over.allowed).toBe(true); // overflow allowed per policy
    expect(over.overBudget).toBe(true);
  });
});

describe("orderAcquisitions", () => {
  it("sorts by taste-fit descending, stable for nulls", () => {
    const ordered = orderAcquisitions([
      { tasteFit: 40, id: 1 },
      { tasteFit: null, id: 2 },
      { tasteFit: 90, id: 3 },
      { tasteFit: 70, id: 4 },
    ]);
    expect(ordered.map((o) => o.id)).toEqual([3, 4, 1, 2]);
  });
});

describe("decayProposals", () => {
  const now = new Date("2026-10-12T00:00:00.000Z");

  it("proposes unplayed and long-idle tracks with reasons, most prunable first", () => {
    const proposals = decayProposals(
      [
        {
          norm: "recentlyplayed",
          title: "Recently Played",
          artistName: "Terror",
          lastPlayed: "2026-09-01T00:00:00.000Z",
          playCount: 20,
          acquiredAt: "2020-01-01T00:00:00.000Z",
          sizeBytes: 100,
        },
        {
          norm: "neverplayed",
          title: "Never Played",
          artistName: "Terror",
          lastPlayed: null,
          playCount: 0,
          acquiredAt: "2024-01-01T00:00:00.000Z",
          sizeBytes: 200,
        },
        {
          norm: "oldfavorite",
          title: "Old Favorite",
          artistName: "Death",
          lastPlayed: "2025-09-01T00:00:00.000Z",
          playCount: 50,
          acquiredAt: "2020-01-01T00:00:00.000Z",
          sizeBytes: null,
        },
        {
          norm: "nodates",
          title: "No Dates",
          artistName: "Death",
          lastPlayed: null,
          playCount: 0,
          acquiredAt: null,
          sizeBytes: null,
        },
      ],
      { now, decayMonths: 12 },
    );

    expect(proposals.map((p) => p.norm)).toEqual(["neverplayed", "oldfavorite"]);
    expect(proposals[0].reason).toContain("unplayed since acquisition");
    expect(proposals[1].reason).toContain("last played 13 months ago (50 plays)");
    // Recently played and undated tracks never propose.
    expect(proposals.some((p) => p.norm === "recentlyplayed")).toBe(false);
    expect(proposals.some((p) => p.norm === "nodates")).toBe(false);
  });

  it("is deterministic", () => {
    const tracks = [
      {
        norm: "a",
        title: "A",
        artistName: "X",
        lastPlayed: "2020-01-01T00:00:00.000Z",
        playCount: 0,
        acquiredAt: null,
        sizeBytes: null,
      },
    ];
    const opts = { now, decayMonths: 12 };
    expect(decayProposals(tracks, opts)).toEqual(decayProposals(tracks, opts));
  });
});

describe("rotationRanks", () => {
  it("blends global popularity with own plays (own plays weigh 5x)", () => {
    const order = rotationRanks([
      { norm: "globalhit", globalPlays: 1000, ownPlays: 5 }, // 1025
      { norm: "myjam", globalPlays: 200, ownPlays: 200 }, // 1200
      { norm: "deepcut", globalPlays: 500, ownPlays: 0 }, // 500
    ]);
    expect(order).toEqual(["myjam", "globalhit", "deepcut"]);
  });

  it("breaks ties deterministically by norm", () => {
    const order = rotationRanks([
      { norm: "b", globalPlays: 10, ownPlays: 0 },
      { norm: "a", globalPlays: 10, ownPlays: 0 },
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("simulatePolicy", () => {
  const state = {
    artists: [
      { name: "Terror", score: 1 as const, catalogSize: 135, plannedTracks: 7 },
      { name: "Death", score: 2 as const, catalogSize: 100, plannedTracks: 13 },
    ],
    libraryTracks: 500,
    libraryBytes: 5 * 1024 ** 3,
    acquiredThisMonth: 10,
    policy,
  };

  it("projects quota changes for score changes (legacy formula preserved)", () => {
    // Terror 1->3: quota 7 -> 23 @ catalog 135 (legacy clamps preserved).
    const sim = simulatePolicy(state, { scoreChanges: { Terror: 3 } });
    expect(sim.changes).toHaveLength(1);
    expect(sim.changes[0]).toMatchObject({
      artist: "Terror",
      quotaBefore: 7,
      quotaAfter: 23,
      deltaTracks: 16,
    });
    expect(sim.library.tracksProjected).toBe(516);
    expect(sim.summary).toContain("Terror: score 1→3 ⇒ quota 7→23 (+16)");
    expect(sim.summary).toContain("500→516 of 5000 tracks");
  });

  it("clamps projections with the policy band cap", () => {
    const sim = simulatePolicy(
      { ...state, policy: { ...policy, bandHardMaxTracks: 10 } },
      { scoreChanges: { Terror: 3 } },
    );
    expect(sim.changes[0]).toMatchObject({ quotaBefore: 7, quotaAfter: 10, deltaTracks: 3 });
  });

  it("applies policy patches and flags hard-budget blocks", () => {
    const sim = simulatePolicy(state, {
      scoreChanges: { Terror: 3 },
      policyPatch: { maxTotalTracks: 510 },
    });
    expect(sim.policy.maxTotalTracks).toBe(510);
    expect(sim.summary).toContain("hard budget would block");
  });

  it("reports 'no changes' for empty scenarios and same-score edits", () => {
    expect(simulatePolicy(state, {}).summary).toContain("no quota changes");
    expect(simulatePolicy(state, { scoreChanges: { terror: 1 } }).changes).toHaveLength(0);
  });

  it("ignores unknown artists and invalid scores", () => {
    const sim = simulatePolicy(state, {
      scoreChanges: { Nobody: 3, Terror: 9 },
    });
    expect(sim.changes).toHaveLength(0);
  });
});
