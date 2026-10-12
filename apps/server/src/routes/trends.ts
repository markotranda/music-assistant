import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ScoreTier } from "@ma/core";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { enqueueJob } from "../services/bands.js";
import {
  approveCandidate,
  ignoreArtist,
  listCandidateViews,
  rejectCandidate,
} from "../services/candidates.js";
import { buildDigest } from "../services/digest.js";
import { scrobbleStats } from "../services/scrobbles.js";
import { readProfile, recomputeTasteProfile, scoringProfile } from "../services/taste.js";

/** Trends & taste API (PLAN.md §4.3, §4.5 "Queue"/"Trends"). */

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const CandidateSchema = z.object({
  id: z.number(),
  type: z.string(),
  status: z.string(),
  tasteFit: z.number().nullable(),
  reason: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const TasteSchema = z.object({
  bandAffinity: z.record(z.string(), z.number()),
  genreWeights: z.record(z.string(), z.number()),
  eraWeights: z.record(z.string(), z.number()),
  updatedAt: z.string().nullable(),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const errorResponses = {
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
  409: {
    description: "Conflict (candidate already handled)",
    content: { "application/json": { schema: ErrorSchema } },
  },
  422: {
    description: "Validation failed",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

export function createTrendsRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const listRoute = createRoute({
    method: "get",
    path: "/candidates",
    tags: ["trends"],
    summary: "Candidate queue (new releases + related artists), taste-fit sorted",
    request: {
      query: z.object({
        status: z.enum(["pending", "approved", "rejected"]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
    },
    responses: {
      200: {
        description: "Candidates",
        content: {
          "application/json": {
            schema: z.object({ candidates: z.array(CandidateSchema) }),
          },
        },
      },
    },
  });
  app.openapi(listRoute, (c) => {
    const q = c.req.valid("query");
    return c.json(
      {
        candidates: listCandidateViews(deps, {
          status: q.status ?? "pending",
          limit: q.limit,
        }),
      },
      200,
    );
  });

  const approveRoute = createRoute({
    method: "post",
    path: "/candidates/{id}/approve",
    tags: ["trends"],
    summary:
      "Approve a candidate: related artists are tracked (score picked here), releases are pinned",
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ score: z.number().int().min(1).max(3) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Approved",
        content: {
          "application/json": {
            schema: z.object({
              candidate: CandidateSchema,
              trackedArtistId: z.number().optional(),
              pinned: z
                .array(
                  z.object({
                    id: z.number(),
                    rank: z.number(),
                    title: z.string(),
                    norm: z.string(),
                  }),
                )
                .optional(),
              skipped: z.array(z.string()).optional(),
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(approveRoute, async (c) => {
    const result = await approveCandidate(
      deps,
      c.req.valid("param").id,
      c.req.valid("json").score as ScoreTier,
    );
    return c.json(result, 200);
  });

  const rejectRoute = createRoute({
    method: "post",
    path: "/candidates/{id}/reject",
    tags: ["trends"],
    summary: "Reject a candidate (it will not be suggested again)",
    request: { params: IdParam },
    responses: {
      200: {
        description: "Rejected",
        content: {
          "application/json": { schema: z.object({ candidate: CandidateSchema }) },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(rejectRoute, (c) =>
    c.json({ candidate: rejectCandidate(deps, c.req.valid("param").id) }, 200),
  );

  const ignoreRoute = createRoute({
    method: "post",
    path: "/candidates/ignore-artist",
    tags: ["trends"],
    summary: "Never suggest this artist again (blocklist + reject pending)",
    request: {
      body: {
        content: {
          "application/json": { schema: z.object({ name: z.string().min(1) }) },
        },
      },
    },
    responses: {
      200: {
        description: "Ignored",
        content: {
          "application/json": {
            schema: z.object({
              ignored: z.array(z.string()),
              rejected: z.number(),
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(ignoreRoute, (c) => c.json(ignoreArtist(deps, c.req.valid("json").name), 200));

  const tasteRoute = createRoute({
    method: "get",
    path: "/taste",
    tags: ["trends"],
    summary: "Taste profile: band affinities, genre and era weights",
    responses: {
      200: {
        description: "Profile",
        content: { "application/json": { schema: z.object({ profile: TasteSchema }) } },
      },
    },
  });
  app.openapi(tasteRoute, (c) =>
    c.json(
      {
        // Band affinity is cheap and always fresh; genre/era come from the
        // persisted snapshot (tag fetches happen on recompute).
        profile: { ...readProfile(deps), bandAffinity: scoringProfile(deps).bandAffinity },
      },
      200,
    ),
  );

  const recomputeRoute = createRoute({
    method: "post",
    path: "/taste/recompute",
    tags: ["trends"],
    summary: "Recompute the taste profile from scrobbles + scores (fetches genre tags)",
    responses: {
      200: {
        description: "Profile",
        content: { "application/json": { schema: z.object({ profile: TasteSchema }) } },
      },
    },
  });
  app.openapi(recomputeRoute, async (c) =>
    c.json({ profile: await recomputeTasteProfile(deps) }, 200),
  );

  const scrobblesRoute = createRoute({
    method: "get",
    path: "/scrobbles",
    tags: ["trends"],
    summary: "Scrobble stats: total plays, last play, top artists",
    responses: {
      200: {
        description: "Stats",
        content: {
          "application/json": {
            schema: z.object({
              total: z.number(),
              lastPlayedAt: z.string().nullable(),
              topArtists: z.array(z.object({ artistName: z.string(), plays: z.number() })),
            }),
          },
        },
      },
    },
  });
  app.openapi(scrobblesRoute, (c) => c.json(scrobbleStats(deps), 200));

  const syncRoute = createRoute({
    method: "post",
    path: "/scrobbles/sync",
    tags: ["trends"],
    summary: "Import scrobble history as a job (full history on first run)",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ full: z.boolean().optional() }).optional(),
          },
        },
      },
    },
    responses: {
      202: {
        description: "Enqueued",
        content: {
          "application/json": {
            schema: z.object({ enqueued: z.literal("scrobble_sync"), full: z.boolean() }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(syncRoute, (c) => {
    const body = c.req.valid("json") ?? {};
    const full = body.full === true;
    enqueueJob(deps.db, "scrobble_sync", { full });
    return c.json({ enqueued: "scrobble_sync" as const, full }, 202);
  });

  for (const type of ["discovery", "release_radar"] as const) {
    const triggerRoute = createRoute({
      method: "post",
      path: type === "discovery" ? "/trends/discover" : "/trends/release-radar",
      tags: ["trends"],
      summary:
        type === "discovery"
          ? "Run the related-artist discovery feed as a job"
          : "Run the release radar as a job",
      responses: {
        202: {
          description: "Enqueued",
          content: {
            "application/json": {
              schema: z.object({ enqueued: z.literal(type) }),
            },
          },
        },
      },
    });
    app.openapi(triggerRoute, (c) => {
      enqueueJob(deps.db, type, {});
      return c.json({ enqueued: type }, 202);
    });
  }

  const digestRoute = createRoute({
    method: "get",
    path: "/digest",
    tags: ["trends"],
    summary: "Digest: candidates pending, new releases, library vs budgets",
    responses: {
      200: {
        description: "Digest",
        content: {
          "application/json": {
            schema: z.object({
              generatedAt: z.string(),
              pendingCandidates: z.number(),
              newReleases: z.number(),
              relatedArtists: z.number(),
              library: z.object({
                ownedTracks: z.number(),
                maxTotalTracks: z.number(),
                trackPct: z.number(),
                bytesUsed: z.number(),
                maxTotalGb: z.number(),
                sizePct: z.number(),
              }),
              acquisition: z.object({
                acquiredThisMonth: z.number(),
                monthlyBudgetTracks: z.number(),
              }),
              jobs: z.object({
                pending: z.number(),
                running: z.number(),
                failed: z.number(),
              }),
              headline: z.string(),
              markdown: z.string(),
            }),
          },
        },
      },
    },
  });
  app.openapi(digestRoute, (c) => c.json(buildDigest(deps), 200));

  return app;
}
