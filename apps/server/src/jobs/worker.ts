import {
  claimNextJob,
  completeJob,
  failJobAttempt,
  requeueRunningJobs,
} from "../db/repositories.js";
import type { AppDeps } from "../deps.js";

/**
 * Durable SQLite-backed job worker. In-process, one job at a time (yt-dlp is
 * heavy), bounded retries with backoff, and boot recovery for jobs orphaned by
 * a crash. Every handler error is recorded on the job row — downloads must
 * survive restarts and failures must be visible (PLAN.md §5).
 */

export type JobContext = {
  deps: AppDeps;
  jobId: number;
  attempt: number;
};

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

export type WorkerOptions = {
  /** Poll interval when idle. */
  pollMs?: number;
  /** Attempts before a job is marked failed. */
  maxAttempts?: number;
  /** Attempt N waits N × backoffMs before retrying. */
  backoffMs?: number;
};

export type Worker = ReturnType<typeof createWorker>;

export function createWorker(
  deps: AppDeps,
  handlers: Record<string, JobHandler>,
  options: WorkerOptions = {},
) {
  const pollMs = options.pollMs ?? 5000;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 30_000;

  async function runOnce(): Promise<boolean> {
    const job = claimNextJob(deps.db);
    if (!job) return false;

    const handler = handlers[job.type];
    if (!handler) {
      failJobAttempt(deps.db, job.id, job.attempts, {
        maxAttempts: 0, // unknown type: fail immediately, no retry
        backoffMs: 0,
        message: `no handler registered for job type '${job.type}'`,
      });
      return true;
    }

    try {
      await handler(JSON.parse(job.payloadJson) as Record<string, unknown>, {
        deps,
        jobId: job.id,
        attempt: job.attempts,
      });
      completeJob(deps.db, job.id);
    } catch (err) {
      failJobAttempt(deps.db, job.id, job.attempts, {
        maxAttempts,
        backoffMs,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  /** Processes every due job right now. Returns how many ran. */
  async function drain(): Promise<number> {
    let count = 0;
    while (await runOnce()) count += 1;
    return count;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  return {
    /** Re-queues orphaned jobs and starts polling. */
    start(): void {
      requeueRunningJobs(deps.db);
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void drain().finally(() => {
          busy = false;
        });
      }, pollMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
    drain,
  };
}
