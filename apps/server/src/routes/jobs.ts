import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { JobRow } from "../db/repositories.js";
import { getJob, listJobs, retryJob } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { verifyAll, verifyBand } from "../services/verify.js";

/** Job queue + deep verify API (PLAN.md §4.5). */

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const JobSchema = z.object({
  id: z.number(),
  type: z.string(),
  status: z.string(),
  attempts: z.number(),
  runAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const VerifyIssueSchema = z.object({
  type: z.enum(["missing", "surplus", "renamed", "replaced", "corrupt"]),
  norm: z.string().optional(),
  fileName: z.string().optional(),
  expected: z.string().optional(),
  detail: z.string().optional(),
});

const VerifyReportSchema = z.object({
  artistId: z.number(),
  band: z.string(),
  planCount: z.number(),
  onDiskCount: z.number(),
  ok: z.boolean(),
  issues: z.array(VerifyIssueSchema),
});

function shapeJob(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    runAt: job.runAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    payload: JSON.parse(job.payloadJson) as Record<string, unknown>,
  };
}

export function createJobsRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const listRoute = createRoute({
    method: "get",
    path: "/jobs",
    tags: ["jobs"],
    summary: "List background jobs (newest first)",
    request: {
      query: z.object({
        status: z.enum(["pending", "running", "done", "failed"]).optional(),
        type: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Jobs",
        content: {
          "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) },
        },
      },
    },
  });
  app.openapi(listRoute, (c) => {
    const q = c.req.valid("query");
    const jobs = listJobs(deps.db, {
      status: q.status,
      type: q.type,
      limit: q.limit,
    });
    return c.json({ jobs: jobs.map(shapeJob) }, 200);
  });

  const retryRoute = createRoute({
    method: "post",
    path: "/jobs/{id}/retry",
    tags: ["jobs"],
    summary: "Re-queue a failed job",
    request: {
      params: z.object({ id: z.coerce.number().int().positive() }),
    },
    responses: {
      200: {
        description: "Job re-queued",
        content: { "application/json": { schema: z.object({ job: JobSchema }) } },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(retryRoute, (c) => {
    const id = c.req.valid("param").id;
    const job = getJob(deps.db, id);
    if (!job) throw new ApiError(404, `job ${id} not found`);
    if (job.status !== "failed") {
      throw new ApiError(409, `job ${id} is ${job.status}, only failed jobs can be retried`);
    }
    retryJob(deps.db, id);
    const updated = getJob(deps.db, id);
    return c.json({ job: shapeJob(updated as JobRow) }, 200);
  });

  const verifyRoute = createRoute({
    method: "post",
    path: "/verify",
    tags: ["jobs"],
    summary: "Deep verify: plan vs disk by normalized title, file name AND content hash",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ artistId: z.number().int().positive().optional() }).optional(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Verify reports (one per band)",
        content: {
          "application/json": {
            schema: z.object({ reports: z.array(VerifyReportSchema) }),
          },
        },
      },
      404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(verifyRoute, async (c) => {
    const body = c.req.valid("json");
    const reports = body?.artistId
      ? [await verifyBand(deps, body.artistId)]
      : await verifyAll(deps);
    return c.json({ reports }, 200);
  });

  return app;
}
