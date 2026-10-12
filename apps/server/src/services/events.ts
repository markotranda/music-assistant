import { events } from "../db/schema.js";
import type { AppDeps } from "../deps.js";

/** Append to the audit log — every decision leaves a trace (PLAN.md §5). */
export function logEvent(deps: AppDeps, kind: string, payload: Record<string, unknown>): void {
  deps.db
    .insert(events)
    .values({ kind, payloadJson: JSON.stringify(payload) })
    .run();
}
