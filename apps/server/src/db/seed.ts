import { DEFAULT_QUOTA_FORMULA, type QuotaFormula } from "@ma/core";
import { eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { settings } from "./schema.js";

/** Anti-overload policy (PLAN.md §4.2). Tunable in Settings. */
export type PolicySettings = {
  /** manual: approve everything in the queue; hybrid: auto ≥ 85 taste-fit; auto: all gates pass. */
  approvalMode: "manual" | "hybrid" | "auto";
  /** Candidates below this taste-fit score never enter the queue. */
  tasteFitThreshold: number;
  /** Tracks the sync engine may acquire per calendar month. */
  monthlyAcquisitionBudgetTracks: number;
  maxTotalTracks: number;
  maxTotalGb: number;
  /** Unplayed tracks older than this decay toward rotation/retired. */
  decayMonths: number;
  rotationEnabled: boolean;
  pruneReportEnabled: boolean;
};

export const DEFAULT_POLICY: PolicySettings = {
  approvalMode: "manual",
  tasteFitThreshold: 70,
  monthlyAcquisitionBudgetTracks: 40,
  maxTotalTracks: 5000,
  maxTotalGb: 50,
  decayMonths: 12,
  rotationEnabled: true,
  pruneReportEnabled: true,
};

export type IntegrationSettings = {
  lastfmApiKey: string;
  musicbrainzUserAgent: string;
  deezerEnabled: boolean;
};

/**
 * Integration config. Secrets come from env as *initial* values and are
 * editable in Settings afterwards (never committed to the repo).
 */
export function defaultIntegrations(env: NodeJS.ProcessEnv = process.env): IntegrationSettings {
  return {
    lastfmApiKey: env.LASTFM_API_KEY ?? "",
    musicbrainzUserAgent: env.MA_USER_AGENT ?? "MusicAssistant/0.1.0 ( https://github.com/ )",
    deezerEnabled: true,
  };
}

export type AppSettings = {
  formula: QuotaFormula;
  policy: PolicySettings;
  integrations: IntegrationSettings;
};

/** Seeds default settings on first run. Existing values are never overwritten. */
export function seedSettings(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  const defaults: Record<string, unknown> = {
    formula: DEFAULT_QUOTA_FORMULA,
    policy: DEFAULT_POLICY,
    integrations: defaultIntegrations(env),
  };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (!existing) {
      db.insert(settings)
        .values({ key, valueJson: JSON.stringify(value) })
        .run();
    }
  }
}
