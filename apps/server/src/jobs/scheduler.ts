import { getSetting, setSetting } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { enqueueJob } from "../services/bands.js";

/**
 * Recurring job scheduler (PLAN.md §4.3): trends jobs are due-based, not
 * cron-based — on boot and every hour we enqueue whichever cadence elapsed.
 * Last-run timestamps persist in settings so restarts don't skip or double-run.
 */

export type Schedule = { type: string; everyMs: number; payload?: Record<string, unknown> };

export const SCHEDULES: Schedule[] = [
  { type: "scrobble_sync", everyMs: 24 * 60 * 60 * 1000, payload: {} },
  { type: "release_radar", everyMs: 24 * 60 * 60 * 1000 },
  { type: "discovery", everyMs: 72 * 60 * 60 * 1000 },
];

const STATE_KEY = "scheduler_state";

export function runDueSchedules(deps: AppDeps, now = Date.now()): string[] {
  const state = getSetting<Record<string, string>>(deps.db, STATE_KEY) ?? {};
  const enqueued: string[] = [];
  let changed = false;

  for (const schedule of SCHEDULES) {
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
