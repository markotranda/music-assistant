import { getSetting, setSetting } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { enqueueJob } from "../services/bands.js";
import { policyConfig } from "../services/policy.js";

/**
 * Recurring job scheduler (PLAN.md §4.3): trends and policy jobs are due-based,
 * not cron-based — on boot and every hour we enqueue whichever cadence elapsed.
 * Last-run timestamps persist in settings so restarts don't skip or double-run.
 */

export type Schedule = {
  type: string;
  everyMs: number;
  payload?: Record<string, unknown>;
  /** Policy switches can disable a schedule entirely. */
  enabled?: (deps: AppDeps) => boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const SCHEDULES: Schedule[] = [
  { type: "scrobble_sync", everyMs: DAY_MS, payload: {} },
  { type: "release_radar", everyMs: DAY_MS },
  { type: "discovery", everyMs: 3 * DAY_MS },
  {
    type: "prune_scan",
    everyMs: 7 * DAY_MS,
    enabled: (deps) => {
      const p = policyConfig(deps);
      return p.pruneReportEnabled || p.autoPruneEnabled;
    },
  },
  {
    type: "rotation_scan",
    everyMs: 7 * DAY_MS,
    enabled: (deps) => policyConfig(deps).rotationEnabled,
  },
];

const STATE_KEY = "scheduler_state";

export function runDueSchedules(deps: AppDeps, now = Date.now()): string[] {
  const state = getSetting<Record<string, string>>(deps.db, STATE_KEY) ?? {};
  const enqueued: string[] = [];
  let changed = false;

  for (const schedule of SCHEDULES) {
    if (schedule.enabled && !schedule.enabled(deps)) continue;
    const last = state[schedule.type] ? Date.parse(state[schedule.type]) : 0;
    if (!Number.isFinite(last) || now - last >= schedule.everyMs) {
      enqueueJob(deps.db, schedule.type, schedule.payload ?? {});
      state[schedule.type] = new Date(now).toISOString();
      enqueued.push(schedule.type);
      changed = true;
    }
  }

  if (changed) setSetting(deps.db, STATE_KEY, state);
  return enqueued;
}

/** Starts the scheduler; returns a stop function (tests and shutdown). */
export function startScheduler(deps: AppDeps, intervalMs = 60 * 60 * 1000): () => void {
  runDueSchedules(deps);
  const timer = setInterval(() => runDueSchedules(deps), intervalMs);
  // Never hold the process open just for the scheduler.
  timer.unref?.();
  return () => clearInterval(timer);
}
