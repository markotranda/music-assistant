import { autoApprove, normTitle, type ScoreTier } from "@ma/core";
import {
  type CandidateRow,
  findCandidateByKey,
  getCandidate,
  getSetting,
  insertCandidate,
  listCandidates,
  rejectPendingForArtistName,
  setCandidateStatus,
  setSetting,
} from "../db/repositories.js";
import { DEFAULT_TRENDS, type TrendsSettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { pinAlbum, trackBand } from "./bands.js";
import { logEvent } from "./events.js";
import { policyConfig } from "./policy.js";

/**
 * Candidates (PLAN.md §4.1): proposals that enter the QUEUE, never the library
 * directly. Approval is explicit: a related artist becomes a tracked band (with
 * a score chosen at approval), a new release runs the existing pin-album flow.
 */

export type CandidateView = {
  id: number;
  type: string;
  status: string;
  tasteFit: number | null;
  reason: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function shapeCandidate(row: CandidateRow): CandidateView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    tasteFit: row.tasteFit,
    reason: row.reason,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

/** Dedupe key for artist-ish candidates: normalized lowercase name. */
export function artistKey(name: string): string {
  return normTitle(name);
}

export function trendsSettings(deps: AppDeps): TrendsSettings {
  return getSetting<TrendsSettings>(deps.db, "trends") ?? DEFAULT_TRENDS;
}

export function isIgnored(deps: AppDeps, name: string): boolean {
  const lower = name.trim().toLowerCase();
  return trendsSettings(deps).ignoredArtists.some((n) => n.toLowerCase() === lower);
}

/**
 * Inserts unless the same (type, key) already exists in ANY status — approved
 * and rejected suggestions are never re-surfaced. Returns the new id, or null
 * when deduped.
 */
export function createCandidateIfNew(
  deps: AppDeps,
  input: {
    type: string;
    key: string;
    artistId: number | null;
    payload: Record<string, unknown>;
    tasteFit: number | null;
    reason: string | null;
  },
): number | null {
  if (findCandidateByKey(deps.db, input.type, input.key)) return null;
  return insertCandidate(deps.db, input);
}

export function listCandidateViews(
  deps: AppDeps,
  filter: { status?: string; limit?: number } = {},
): CandidateView[] {
  return listCandidates(deps.db, filter).map(shapeCandidate);
}

export type ApproveResult = {
  candidate: CandidateView;
  /** related: the newly tracked band. */
  trackedArtistId?: number;
  /** new_release: titles pinned into the plan. */
  pinned?: { id: number; rank: number; title: string; norm: string }[];
  skipped?: string[];
};

export async function approveCandidate(
  deps: AppDeps,
  id: number,
  score: ScoreTier,
): Promise<ApproveResult> {
  const row = getCandidate(deps.db, id);
  if (!row) throw new ApiError(404, `candidate ${id} not found`);
  if (row.status !== "pending") {
    throw new ApiError(409, `candidate ${id} is already ${row.status}`);
  }
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;

  if (row.type === "related") {
    const name = String(payload.name ?? "");
    if (!name) throw new ApiError(422, `candidate ${id} has no artist name`);
    const { artist } = await trackBand(deps, { name, score });
    setCandidateStatus(deps.db, id, "approved");
    logEvent(deps, "candidate_approved", { id, type: row.type, name, score });
    return {
      candidate: shapeCandidate({ ...row, status: "approved" }),
      trackedArtistId: artist.id,
    };
  }

  if (row.type === "new_release") {
    if (!row.artistId) throw new ApiError(422, `candidate ${id} has no tracked artist`);
    const title = String(payload.title ?? "");
    const result = await pinAlbum(deps, row.artistId, title);
    setCandidateStatus(deps.db, id, "approved");
    logEvent(deps, "candidate_approved", {
      id,
      type: row.type,
      title,
      pinned: result.pinned.length,
    });
    return {
      candidate: shapeCandidate({ ...row, status: "approved" }),
      pinned: result.pinned,
      skipped: result.skipped,
    };
  }

  throw new ApiError(422, `candidate type '${row.type}' cannot be approved yet`);
}

export function rejectCandidate(deps: AppDeps, id: number): CandidateView {
  const row = getCandidate(deps.db, id);
  if (!row) throw new ApiError(404, `candidate ${id} not found`);
  if (row.status !== "pending") {
    throw new ApiError(409, `candidate ${id} is already ${row.status}`);
  }
  setCandidateStatus(deps.db, id, "rejected");
  logEvent(deps, "candidate_rejected", { id, type: row.type });
  return shapeCandidate({ ...row, status: "rejected" });
}

/**
 * Approval-mode pass (PLAN §4.2 gate 6): hybrid/auto approve through the exact
 * same path as a human click. Related artists land at score 1 (casual) — their
 * quota grows only when you raise it yourself.
 */
export async function maybeAutoApprove(
  deps: AppDeps,
  id: number,
  verdict: { pass: boolean; score: number },
): Promise<boolean> {
  const policy = policyConfig(deps);
  if (!autoApprove(policy, { ...verdict, penalty: 0, gates: [] })) return false;
  const row = getCandidate(deps.db, id);
  if (!row) return false;
  await approveCandidate(deps, id, 1);
  logEvent(deps, "candidate_auto_approved", { id, type: row.type, mode: policy.approvalMode });
  return true;
}

/** "Never suggest this artist": blocklist + reject its pending candidates. */
export function ignoreArtist(deps: AppDeps, name: string): { ignored: string[]; rejected: number } {
  const trimmed = name.trim();
  if (!trimmed) throw new ApiError(422, "artist name required");
  const trends = trendsSettings(deps);
  const lower = trimmed.toLowerCase();
  if (!trends.ignoredArtists.some((n) => n.toLowerCase() === lower)) {
    trends.ignoredArtists = [...trends.ignoredArtists, trimmed];
    setSetting(deps.db, "trends", trends);
  }
  const rejected = rejectPendingForArtistName(deps.db, trimmed);
  logEvent(deps, "artist_ignored", { name: trimmed, rejected });
  return { ignored: trends.ignoredArtists, rejected };
}
