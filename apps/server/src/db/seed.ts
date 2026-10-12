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
  /** Scrobble-history owner (PLAN §4.3) — empty disables ingestion. */
  lastfmUsername: string;
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
    lastfmUsername: env.LASTFM_USERNAME ?? "",
    musicbrainzUserAgent: env.MA_USER_AGENT ?? "MusicAssistant/0.1.0 ( https://github.com/ )",
    deezerEnabled: true,
  };
}

/** Acquisition config (yt-dlp). Tunable in Settings. */
export type AcquisitionSettings = {
  audioFormat: string;
  audioQuality: string;
  minDurationS: number;
  maxDurationS: number;
  /** yt-dlp player-client fallback chain; null = default client. */
  playerClients: (string | null)[];
};

export const DEFAULT_ACQUISITION: AcquisitionSettings = {
  audioFormat: "mp3",
  audioQuality: "2",
  minDurationS: 60,
  maxDurationS: 900,
  playerClients: [null, "web_safari", "android,web"],
};

/** API access (PLAN.md §4.6). Single bearer token, enforcement off by default. */
export type AuthSettings = {
  /** When non-null, `/api/*` requires `Authorization: Bearer <token>`. */
  token: string | null;
};

export const DEFAULT_AUTH: AuthSettings = { token: null };

/** Trends & discovery tuning (PLAN.md §4.3). */
export type TrendsSettings = {
  /** Top-affinity bands used as discovery seeds. */
  discoverySeeds: number;
  /** Similar artists fetched per seed. */
  discoveryDepth: number;
  /** Release radar window (days). */
  radarLookbackDays: number;
  /** Lowercased artist names to never suggest again. */
  ignoredArtists: string[];
};

export const DEFAULT_TRENDS: TrendsSettings = {
  discoverySeeds: 5,
  discoveryDepth: 5,
  radarLookbackDays: 30,
  ignoredArtists: [],
};

export type AppSettings = {
  formula: QuotaFormula;
  policy: PolicySettings;
  integrations: IntegrationSettings;
  acquisition: AcquisitionSettings;
  auth: AuthSettings;
  trends: TrendsSettings;
};

/** Seeds default settings on first run. Existing values are never overwritten. */
export function seedSettings(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  const defaults: Record<string, unknown> = {
    formula: DEFAULT_QUOTA_FORMULA,
    policy: DEFAULT_POLICY,
    integrations: defaultIntegrations(env),
    acquisition: DEFAULT_ACQUISITION,
    auth: DEFAULT_AUTH,
    trends: DEFAULT_TRENDS,
    overrides: { pinnedMbids: {}, searchNameFixes: {} },
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
