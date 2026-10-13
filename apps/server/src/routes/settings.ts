import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import {
  PATCH_SCHEMAS,
  readSettings,
  type SettingsGroup,
  updateSettingsGroup,
} from "../services/settings.js";

/** Settings API (PLAN.md §4.5). Secrets are masked on read; "" clears them. */

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const tier = z.object({ 1: z.number(), 2: z.number(), 3: z.number() });

const SettingsSchema = z.object({
  formula: z.object({
    multipliers: tier,
    floors: tier,
    caps: tier,
    deepShare: z.number(),
  }),
  policy: z.object({
    approvalMode: z.enum(["manual", "hybrid", "auto"]),
    tasteFitThreshold: z.number(),
    autoApproveFit: z.number(),
    bandHardMaxTracks: z.number(),
    genreSoftCapShare: z.number(),
    monthlyAcquisitionBudgetTracks: z.number(),
    maxTotalTracks: z.number(),
    maxTotalGb: z.number(),
    decayMonths: z.number(),
    rotationEnabled: z.boolean(),
    pruneReportEnabled: z.boolean(),
    autoPruneEnabled: z.boolean(),
  }),
  integrations: z.object({
    lastfmApiKeyMasked: z.string().nullable(),
    lastfmUsername: z.string(),
    musicbrainzUserAgent: z.string(),
    deezerEnabled: z.boolean(),
  }),
  acquisition: z.object({
    audioFormat: z.string(),
    audioQuality: z.string(),
    minDurationS: z.number(),
    maxDurationS: z.number(),
    playerClients: z.array(z.string().nullable()),
    embedArt: z.boolean(),
    replayGain: z.boolean(),
  }),
  auth: z.object({ tokenMasked: z.string().nullable() }),
  overrides: z.object({
    pinnedMbids: z.record(z.string(), z.string()),
    searchNameFixes: z.record(z.string(), z.string()),
  }),
  trends: z.object({
    discoverySeeds: z.number(),
    discoveryDepth: z.number(),
    radarLookbackDays: z.number(),
    ignoredArtists: z.array(z.string()),
  }),
});

export function createSettingsRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const getRoute = createRoute({
    method: "get",
    path: "/settings",
    tags: ["settings"],
    summary: "All settings groups (secrets masked)",
    responses: {
      200: {
        description: "Settings",
        content: { "application/json": { schema: z.object({ settings: SettingsSchema }) } },
      },
    },
  });
  app.openapi(getRoute, (c) => c.json({ settings: readSettings(deps) }, 200));

  // One route per group so each patch body is documented exactly (and each
  // path is distinct — no first-match-wins schema confusion).
  for (const [group, bodySchema] of Object.entries(PATCH_SCHEMAS) as [
    SettingsGroup,
    (typeof PATCH_SCHEMAS)[SettingsGroup],
  ][]) {
    const route = createRoute({
      method: "put",
      path: `/settings/${group}`,
      tags: ["settings"],
      summary: `Update ${group} settings (partial: omitted fields are kept; secrets "" clears)`,
      request: {
        body: { content: { "application/json": { schema: bodySchema } } },
      },
      responses: {
        200: {
          description: "Updated settings (secrets masked)",
          content: { "application/json": { schema: z.object({ settings: SettingsSchema }) } },
        },
        422: {
          description: "Validation failed",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    });
    app.openapi(route, (c) => {
      updateSettingsGroup(deps, group, c.req.valid("json"));
      return c.json({ settings: readSettings(deps) }, 200);
    });
  }

  return app;
}
