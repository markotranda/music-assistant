/**
 * Shared domain types. Pure data shapes only — no runtime logic.
 */

/** Taste tier: 1 = background, 2 = like, 3 = love. 0 = untracked/unset. */
export type ScoreTier = 1 | 2 | 3;
export type Score = 0 | ScoreTier;

/** A track as ranked by popularity (Last.fm global plays). */
export type RankedTrack = {
  title: string;
  norm: string;
  plays: number;
};

/** A track chosen for the plan, in final rank order. */
export type DesiredTrack = {
  rank: number;
  title: string;
  norm: string;
  pinned: boolean;
};

/** A file found in the band's collection folder. */
export type OnDiskTrack = {
  norm: string;
  fileName: string;
  title: string;
  extension: string;
};

/** Two-phase rename so shuffled ranks never collide mid-flight. */
export type RenameAction = {
  from: string;
  /** Phase 1: rename `from` -> `viaTemp`. */
  viaTemp: string;
  /** Phase 2: rename `viaTemp` -> `to`. */
  to: string;
};

/** Desired-state diff for one band's folder. */
export type SyncPlan = {
  acquire: DesiredTrack[];
  retire: OnDiskTrack[];
  renames: RenameAction[];
};
