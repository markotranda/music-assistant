import { DEFAULT_QUOTA_FORMULA, type QuotaFormula } from "@ma/core";
import { z } from "zod";
import { getSetting, setSetting } from "../db/repositories.js";
import {
  type AcquisitionSettings,
  type AuthSettings,
  DEFAULT_ACQUISITION,
  DEFAULT_AUTH,
  DEFAULT_POLICY,
  DEFAULT_TRENDS,
  defaultIntegrations,
  type IntegrationSettings,
  type PolicySettings,
  type TrendsSettings,
} from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { refreshDeps } from "../deps.js";
import { ApiError } from "../errors.js";

/**
 * Settings store (PLAN.md §4.5). Groups are updated as partial patches:
 * omitted fields are kept. Secrets are never returned in clear — reads give a
 * masked hint; writes accept "" to clear or a new value to replace.
 */

export type SettingsGroup =
  | "formula"
  | "policy"
  | "integrations"
  | "acquisition"
  | "auth"
  | "overrides"
  | "trends";

/** Merge base per group — rows written before a field existed still validate. */
const GROUP_DEFAULTS: Record<SettingsGroup, () => Record<string, unknown>> = {
  formula: () => ({ ...DEFAULT_QUOTA_FORMULA }),
  policy: () => ({ ...DEFAULT_POLICY }),
  integrations: () => ({ ...defaultIntegrations(), lastfmApiKey: "" }),
  acquisition: () => ({ ...DEFAULT_ACQUISITION }),
  auth: () => ({ ...DEFAULT_AUTH }),
  overrides: () => ({ pinnedMbids: {}, searchNameFixes: {} }),
  trends: () => ({ ...DEFAULT_TRENDS }),
};

const tierTriple = z.object({
  1: z.number().positive().optional(),
  2: z.number().positive().optional(),
  3: z.number().positive().optional(),
});

const formulaPatch = z.object({
  multipliers: tierTriple.optional(),
  floors: tierTriple.optional(),
  caps: tierTriple.optional(),
  deepShare: z.number().min(0).max(1).optional(),
});

const policyPatch = z.object({
  approvalMode: z.enum(["manual", "hybrid", "auto"]).optional(),
  tasteFitThreshold: z.number().min(0).max(100).optional(),
  monthlyAcquisitionBudgetTracks: z.number().int().positive().optional(),
  maxTotalTracks: z.number().int().positive().optional(),
  maxTotalGb: z.number().positive().optional(),
  decayMonths: z.number().int().positive().optional(),
  rotationEnabled: z.boolean().optional(),
  pruneReportEnabled: z.boolean().optional(),
});

const integrationsPatch = z.object({
  /** "" clears the key; omitted keeps the stored one. */
  lastfmApiKey: z.string().optional(),
  lastfmUsername: z.string().optional(),
  musicbrainzUserAgent: z.string().min(5).optional(),
  deezerEnabled: z.boolean().optional(),
});

const acquisitionPatch = z.object({
  audioFormat: z.enum(["mp3", "m4a", "flac", "opus", "vorbis", "aac", "alac", "wav"]).optional(),
  audioQuality: z
    .string()
    .regex(/^[0-9]$/, "audioQuality is a yt-dlp quality 0-9")
    .optional(),
  minDurationS: z.number().int().positive().optional(),
  maxDurationS: z.number().int().positive().optional(),
  playerClients: z.array(z.string().min(1).nullable()).optional(),
});

const authPatch = z.object({
  /** "" clears the token (disables enforcement); omitted keeps it. */
  token: z.string().optional(),
});

const overridesPatch = z.object({
  /** name -> MBID: pin a merged act's real MBID (enables the Last.fm whitelist). */
  pinnedMbids: z.record(z.string(), z.string()).optional(),
  /** name -> search name: fix how the band is searched on Last.fm/Deezer/YouTube. */
  searchNameFixes: z.record(z.string(), z.string()).optional(),
});

const trendsPatch = z.object({
  discoverySeeds: z.number().int().positive().max(50).optional(),
  discoveryDepth: z.number().int().positive().max(20).optional(),
  radarLookbackDays: z.number().int().positive().max(3650).optional(),
  ignoredArtists: z.array(z.string()).optional(),
});

export const PATCH_SCHEMAS = {
  formula: formulaPatch,
  policy: policyPatch,
  integrations: integrationsPatch,
  acquisition: acquisitionPatch,
  auth: authPatch,
  overrides: overridesPatch,
  trends: trendsPatch,
} as const;

/** "34ca…37b" — enough to identify, never enough to use. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

export type SettingsView = {
  formula: QuotaFormula;
  policy: PolicySettings;
  integrations: Omit<IntegrationSettings, "lastfmApiKey"> & {
    lastfmApiKeyMasked: string | null;
  };
  acquisition: AcquisitionSettings;
  auth: { tokenMasked: string | null };
  overrides: { pinnedMbids: Record<string, string>; searchNameFixes: Record<string, string> };
  trends: TrendsSettings;
};

/** The full settings as safe-to-display values (secrets masked). */
export function readSettings(deps: AppDeps): SettingsView {
  const formula = getSetting<QuotaFormula>(deps.db, "formula") ?? DEFAULT_QUOTA_FORMULA;
  const policy = getSetting<PolicySettings>(deps.db, "policy") ?? DEFAULT_POLICY;
  const integrations =
    getSetting<IntegrationSettings>(deps.db, "integrations") ?? ({} as IntegrationSettings);
  const acquisition =
    getSetting<AcquisitionSettings>(deps.db, "acquisition") ?? DEFAULT_ACQUISITION;
  const auth = getSetting<AuthSettings>(deps.db, "auth") ?? DEFAULT_AUTH;
  const overrides = getSetting<{
    pinnedMbids: Record<string, string>;
    searchNameFixes: Record<string, string>;
  }>(deps.db, "overrides") ?? { pinnedMbids: {}, searchNameFixes: {} };
  const trends = getSetting<TrendsSettings>(deps.db, "trends") ?? DEFAULT_TRENDS;

  return {
    formula,
    policy,
    integrations: {
      lastfmUsername: integrations.lastfmUsername ?? "",
      musicbrainzUserAgent: integrations.musicbrainzUserAgent,
      deezerEnabled: integrations.deezerEnabled,
      lastfmApiKeyMasked: maskSecret(integrations.lastfmApiKey),
    },
    acquisition,
    auth: { tokenMasked: maskSecret(auth.token) },
    overrides,
    trends,
  };
}

/**
 * Merges a partial patch into a settings group, validates the result, and
 * persists it. Rebuilds the integration adapters when their config changes so
 * an edited Last.fm key takes effect immediately (not at next restart).
 */
export function updateSettingsGroup(deps: AppDeps, group: SettingsGroup, patch: unknown): void {
  const schema = PATCH_SCHEMAS[group];
  const parsed = schema.safeParse(patch);
  if (!parsed.success) {
    throw new ApiError(422, `invalid ${group} settings`, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const key = group;
  const current = {
    ...GROUP_DEFAULTS[group](),
    ...getSetting<Record<string, unknown>>(deps.db, key),
  };
  const merged = mergeGroup(group, current, parsed.data);

  // Full-shape validation of the merged result (invariants like floor <= cap).
  assertValid(group, merged);
  setSetting(deps.db, key, merged);

  if (group === "integrations") {
    refreshDeps(deps);
  }
}

function mergeGroup(
  group: SettingsGroup,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      group === "formula" &&
      (field === "multipliers" || field === "floors" || field === "caps")
    ) {
      out[field] = { ...(current[field] as object), ...(value as object) };
      continue;
    }
    // Secrets: "" means clear, so the stored value stays a string or null.
    if (group === "auth" && field === "token") {
      out.token = value === "" ? null : value;
      continue;
    }
    if (group === "integrations" && field === "lastfmApiKey") {
      out.lastfmApiKey = value;
      continue;
    }
    out[field] = value;
  }
  return out;
}

function assertValid(group: SettingsGroup, merged: Record<string, unknown>): void {
  const full = FULL_SCHEMAS[group].safeParse(merged);
  if (!full.success) {
    throw new ApiError(422, `invalid ${group} settings`, {
      issues: full.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
}

const tierFull = z.object({
  1: z.number().positive(),
  2: z.number().positive(),
  3: z.number().positive(),
});

const FULL_SCHEMAS = {
  formula: z
    .object({
      multipliers: tierFull,
      floors: tierFull,
      caps: tierFull,
      deepShare: z.number().min(0).max(1),
    })
    .refine((f) => [1, 2, 3].every((s) => f.floors[s as 1 | 2 | 3] <= f.caps[s as 1 | 2 | 3]), {
      message: "each floor must be <= its cap",
    }),
  policy: z.object({
    approvalMode: z.enum(["manual", "hybrid", "auto"]),
    tasteFitThreshold: z.number().min(0).max(100),
    monthlyAcquisitionBudgetTracks: z.number().int().positive(),
    maxTotalTracks: z.number().int().positive(),
    maxTotalGb: z.number().positive(),
    decayMonths: z.number().int().positive(),
    rotationEnabled: z.boolean(),
    pruneReportEnabled: z.boolean(),
  }),
  integrations: z.object({
    lastfmApiKey: z.string(),
    lastfmUsername: z.string(),
    musicbrainzUserAgent: z.string().min(5),
    deezerEnabled: z.boolean(),
  }),
  acquisition: z
    .object({
      audioFormat: z.string().min(1),
      audioQuality: z.string().regex(/^[0-9]$/),
      minDurationS: z.number().int().positive(),
      maxDurationS: z.number().int().positive(),
      playerClients: z.array(z.string().min(1).nullable()),
    })
    .refine((a) => a.minDurationS < a.maxDurationS, {
      message: "minDurationS must be below maxDurationS",
    }),
  auth: z.object({ token: z.string().nullable() }),
  overrides: z.object({
    pinnedMbids: z.record(z.string(), z.string()),
    searchNameFixes: z.record(z.string(), z.string()),
  }),
  trends: z.object({
    discoverySeeds: z.number().int().positive().max(50),
    discoveryDepth: z.number().int().positive().max(20),
    radarLookbackDays: z.number().int().positive().max(3650),
    ignoredArtists: z.array(z.string()),
  }),
} as const;
