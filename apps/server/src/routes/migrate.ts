import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { enqueueJobRow } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { latestMigrateReport } from "../services/migrate.js";

/** Legacy state migration API (PLAN.md §6 Phase 7). */

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ReportSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  bands: z.object({
    imported: z.number(),
    skipped: z.array(z.string()),
    quotaDiffs: z.array(
      z.object({
        band: z.string(),
        legacyQuota: z.number().nullable(),
        computedQuota: z.number().nullable(),
      }),
    ),
  }),
  plan: z.object({
    imported: z.number(),
    alreadyImported: z.number(),
    owned: z.number(),
    planned: z.number(),
    pinned: z.number(),
  }),
  files: z.object({
    matched: z.number(),
    unmatched: z.array(z.string()),
    unknownBandDirs: z.array(z.string()),
  }),
  problems: z.array(z.string()),
  summary: z.string(),
});

export function createMigrateRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const importRoute = createRoute({
    method: "post",
    path: "/migrate",
    tags: ["migrate"],
    summary: "Import legacy state (bands.csv + plan.csv) as a durable job",
    description:
      "Queues the one-shot importer. The collection is scanned from the server's " +
      "configured collection directory; files are only read. GET /api/migrate/report " +
      "returns the outcome once the job finishes.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              bandsCsv: z.string().min(1),
              planCsv: z.string().min(1),
            }),
          },
        },
      },
    },
    responses: {
      202: {
        description: "Migration queued (jobId null = an identical run is already queued)",
        content: {
          "application/json": { schema: z.object({ jobId: z.number().nullable() }) },
        },
      },
      422: {
        description: "Validation failed",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });
  app.openapi(importRoute, (c) => {
    const { bandsCsv, planCsv } = c.req.valid("json");
    const jobId = enqueueJobRow(deps.db, "migrate", { bandsCsv, planCsv });
    return c.json({ jobId }, 202);
  });

  const reportRoute = createRoute({
    method: "get",
    path: "/migrate/report",
    tags: ["migrate"],
    summary: "Report of the last migration run (everything unmapped is listed)",
    responses: {
      200: {
        description: "Report (null before the first run)",
        content: {
          "application/json": {
            schema: z.object({ report: ReportSchema.nullable() }),
          },
        },
      },
    },
  });
  app.openapi(reportRoute, (c) => c.json({ report: latestMigrateReport(deps) }, 200));

  return app;
}
