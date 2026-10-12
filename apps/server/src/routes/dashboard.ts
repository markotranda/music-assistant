import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { count, eq, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { getSetting, listArtists, listEvents } from "../db/repositories.js";
import { jobs, planItems, tracks } from "../db/schema.js";
import { DEFAULT_POLICY, type PolicySettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";

/** Dashboard summary + audit event feed (PLAN.md §4.5 "Dashboard"). */

const EventSchema = z.object({
  id: z.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const DashboardSchema = z.object({
  library: z.object({
    bands: z.number(),
    plannedTracks: z.number(),
    ownedTracks: z.number(),
    bytesUsed: z.number(),
    maxTotalTracks: z.number(),
    maxTotalGb: z.number(),
  }),
  acquisition: z.object({
    acquiredThisMonth: z.number(),
    monthlyBudgetTracks: z.number(),
  }),
  jobs: z.object({
    pending: z.number(),
    running: z.number(),
    done: z.number(),
    failed: z.number(),
  }),
  recentEvents: z.array(EventSchema),
});

function shapeEvent(row: ReturnType<typeof listEvents>[number]) {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

/** Aggregated numbers for the dashboard — one small call, no N+1. */
export function getDashboard(deps: AppDeps) {
  const db = deps.db;
  const policy = getSetting<PolicySettings>(db, "policy") ?? DEFAULT_POLICY;

  const planned = db.select({ n: count() }).from(planItems).get()?.n ?? 0;
  const owned =
    db.select({ n: count() }).from(tracks).where(eq(tracks.status, "OWNED")).get()?.n ?? 0;
  const bytes =
    db
      .select({ n: sum(tracks.sizeBytes) })
      .from(tracks)
      .get()?.n ?? 0;

  const monthPrefix = new Date().toISOString().slice(0, 7); // "2026-10"
  const acquiredThisMonth =
    db
      .select({ n: count() })
      .from(tracks)
      .where(sql`${tracks.acquiredAt} LIKE ${`${monthPrefix}%`}`)
      .get()?.n ?? 0;

  const jobCounts: Record<string, number> = {};
  for (const row of db
    .select({ status: jobs.status, n: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .all()) {
    jobCounts[row.status] = row.n;
  }

  return {
    library: {
      bands: listArtists(db).length,
      plannedTracks: planned,
      ownedTracks: owned,
      bytesUsed: Number(bytes ?? 0),
      maxTotalTracks: policy.maxTotalTracks,
      maxTotalGb: policy.maxTotalGb,
    },
    acquisition: {
      acquiredThisMonth,
      monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
    },
    jobs: {
      pending: jobCounts.pending ?? 0,
      running: jobCounts.running ?? 0,
      done: jobCounts.done ?? 0,
      failed: jobCounts.failed ?? 0,
    },
    recentEvents: listEvents(db, { limit: 10 }).map(shapeEvent),
  };
}

export function createDashboardRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const dashRoute = createRoute({
    method: "get",
    path: "/dashboard",
    tags: ["system"],
    summary: "Library vs budgets, job counts, recent events — one call for the home screen",
    responses: {
      200: {
        description: "Dashboard summary",
        content: { "application/json": { schema: DashboardSchema } },
      },
    },
  });
  app.openapi(dashRoute, (c) => c.json(getDashboard(deps), 200));

  const eventsRoute = createRoute({
    method: "get",
    path: "/events",
    tags: ["system"],
    summary: "Audit log (every sync/prune/download decision), newest first",
    request: {
      query: z.object({
        kind: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
    },
    responses: {
      200: {
        description: "Events",
        content: {
          "application/json": { schema: z.object({ events: z.array(EventSchema) }) },
        },
      },
    },
  });
  app.openapi(eventsRoute, (c) => {
    const q = c.req.valid("query");
    return c.json(
      { events: listEvents(deps.db, { kind: q.kind, limit: q.limit ?? 50 }).map(shapeEvent) },
      200,
    );
  });

  return app;
}
