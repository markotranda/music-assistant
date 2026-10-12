import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import {
  applyPrune,
  budgetState,
  genreShares,
  policyConfig,
  pruneReport,
  simulate,
} from "../services/policy.js";
import { PATCH_SCHEMAS } from "../services/settings.js";

/** Policy API (PLAN.md §4.2, §4.5): budgets, prune report, simulator. */

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const GateSchema = z.object({
  name: z.string(),
  pass: z.boolean(),
  detail: z.string(),
});

export function createPolicyRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const overviewRoute = createRoute({
    method: "get",
    path: "/policy",
    tags: ["policy"],
    summary: "Policy state: gates, budget usage, genre shares",
    responses: {
      200: {
        description: "Policy state",
        content: {
          "application/json": {
            schema: z.object({
              policy: z.record(z.string(), z.unknown()),
              budget: z.object({
                ownedTracks: z.number(),
                maxTotalTracks: z.number(),
                bytesUsed: z.number(),
                maxTotalGb: z.number(),
                acquiredThisMonth: z.number(),
                monthlyBudgetTracks: z.number(),
                allowed: z.boolean(),
                overBudget: z.boolean(),
                gates: z.array(GateSchema),
              }),
              genreShares: z.record(z.string(), z.number()),
            }),
          },
        },
      },
    },
  });
  app.openapi(overviewRoute, (c) =>
    c.json(
      {
        policy: policyConfig(deps) as unknown as Record<string, unknown>,
        budget: budgetState(deps),
        genreShares: genreShares(deps),
      },
      200,
    ),
  );

  const reportRoute = createRoute({
    method: "get",
    path: "/policy/prune-report",
    tags: ["policy"],
    summary: "Prune report: decayed tracks proposed for retirement (with reasons)",
    responses: {
      200: {
        description: "Prune report",
        content: {
          "application/json": {
            schema: z.object({
              generatedAt: z.string(),
              decayMonths: z.number(),
              autoPruneEnabled: z.boolean(),
              proposals: z.array(
                z.object({
                  norm: z.string(),
                  title: z.string(),
                  artistName: z.string(),
                  reason: z.string(),
                  priority: z.number(),
                  sizeBytes: z.number().nullable(),
                }),
              ),
              reclaimableBytes: z.number(),
              summary: z.string(),
            }),
          },
        },
      },
    },
  });
  app.openapi(reportRoute, (c) => c.json(pruneReport(deps), 200));

  const applyRoute = createRoute({
    method: "post",
    path: "/policy/prune/apply",
    tags: ["policy"],
    summary: "Retire pruned tracks to _retired/<Band>/ (recoverable)",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ norms: z.array(z.string()).optional() }).optional(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Retired",
        content: {
          "application/json": {
            schema: z.object({
              retired: z.array(z.object({ artist: z.string(), fileName: z.string() })),
              skipped: z.array(z.string()),
            }),
          },
        },
      },
      422: {
        description: "Validation failed",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
  app.openapi(applyRoute, (c) => {
    const body = c.req.valid("json") ?? {};
    return c.json(applyPrune(deps, { norms: body.norms }), 200);
  });

  const simulateRoute = createRoute({
    method: "post",
    path: "/policy/simulate",
    tags: ["policy"],
    summary: 'Simulator: "what would change if I set score 3 on X / lower the budget?"',
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              scoreChanges: z.record(z.string(), z.number()).optional(),
              policyPatch: PATCH_SCHEMAS.policy.optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Projection (nothing applied)",
        content: {
          "application/json": {
            schema: z.object({
              policy: z.record(z.string(), z.unknown()),
              changes: z.array(
                z.object({
                  artist: z.string(),
                  scoreBefore: z.number(),
                  scoreAfter: z.number(),
                  quotaBefore: z.number(),
                  quotaAfter: z.number(),
                  deltaTracks: z.number(),
                }),
              ),
              library: z.object({
                tracksNow: z.number(),
                tracksProjected: z.number(),
                maxTotalTracks: z.number(),
                acquiredThisMonth: z.number(),
                monthlyBudgetTracks: z.number(),
              }),
              summary: z.string(),
            }),
          },
        },
      },
      422: {
        description: "Validation failed",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
  app.openapi(simulateRoute, (c) =>
    c.json(
      simulate(deps, {
        scoreChanges: c.req.valid("json").scoreChanges,
        policyPatch: c.req.valid("json").policyPatch,
      }),
      200,
    ),
  );

  return app;
}
