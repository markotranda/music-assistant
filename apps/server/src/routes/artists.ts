import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { ArtistRow } from "../db/repositories.js";
import { enqueueJobRow, listArtists, listPlanRows } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import * as bands from "../services/bands.js";

/**
 * Band tracking API (PLAN.md §4.6). Contract-first: every route declares its
 * Zod schema and the OpenAPI document at /doc is generated from these.
 */

const IdParam = z.object({ id: z.coerce.number().int().positive() });

const ErrorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const ArtistSchema = z.object({
  id: z.number(),
  mbid: z.string(),
  name: z.string(),
  disambig: z.string().nullable(),
  score: z.number(),
  catalogSize: z.number().nullable(),
  quota: z.number().nullable(),
  pinnedMbid: z.string().nullable(),
  ignored: z.boolean(),
  createdAt: z.string(),
});

const DesiredSchema = z.object({
  rank: z.number(),
  title: z.string(),
  norm: z.string(),
  pinned: z.boolean(),
});

const SyncResultSchema = z.object({
  applied: z.boolean(),
  desired: z.array(DesiredSchema),
  acquire: z.array(DesiredSchema),
  retire: z.array(z.object({ fileName: z.string() })),
  renames: z.array(z.object({ from: z.string(), to: z.string() })),
});

const PlanRowSchema = z.object({
  id: z.number(),
  rank: z.number(),
  title: z.string(),
  norm: z.string(),
  pinned: z.boolean(),
  status: z.string(),
  source: z.string(),
});

const errorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  422: {
    description: "Unprocessable",
    content: { "application/json": { schema: ErrorSchema } },
  },
} as const;

function shapeArtist(a: ArtistRow | ReturnType<typeof listArtists>[number]) {
  return {
    id: a.id,
    mbid: a.mbid,
    name: a.name,
    disambig: a.disambig,
    score: a.score,
    catalogSize: a.catalogSize,
    quota: a.quota,
    pinnedMbid: a.pinnedMbid,
    ignored: a.ignored,
    createdAt: a.createdAt,
  };
}

export function createArtistsRoutes(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  const listRoute = createRoute({
    method: "get",
    path: "/artists",
    tags: ["artists"],
    summary: "List tracked bands",
    responses: {
      200: {
        description: "Tracked bands with plan/disk counts",
        content: {
          "application/json": {
            schema: z.object({
              artists: z.array(
                ArtistSchema.extend({
                  planCount: z.number(),
                  onDiskCount: z.number(),
                }),
              ),
            }),
          },
        },
      },
    },
  });
  app.openapi(listRoute, (c) => {
    const rows = listArtists(deps.db).map((a) => ({
      ...shapeArtist(a),
      planCount: listPlanRows(deps.db, a.id).length,
      onDiskCount: deps.collection.listBandFiles(a.name).length,
    }));
    return c.json({ artists: rows }, 200);
  });

  const resolveRoute = createRoute({
    method: "post",
    path: "/artists/resolve",
    tags: ["artists"],
    summary: "Resolve a name to MBID candidates (no side effects)",
    request: {
      body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } },
    },
    responses: {
      200: {
        description: "Best match with alternatives to disambiguate",
        content: {
          "application/json": {
            schema: z.object({
              mbid: z.string(),
              name: z.string(),
              country: z.string().nullable(),
              disambiguation: z.string().nullable(),
              pinned: z.boolean(),
              alternatives: z.array(
                z.object({
                  mbid: z.string(),
                  name: z.string(),
                  country: z.string().nullable(),
                  disambiguation: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      404: { description: "No match", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(resolveRoute, async (c) => {
    const { name } = c.req.valid("json");
    const resolved = await bands.resolveBand(deps, name);
    if (!resolved) {
      return c.json({ error: `could not resolve '${name}' on MusicBrainz` }, 404);
    }
    return c.json(resolved, 200);
  });

  const trackRoute = createRoute({
    method: "post",
    path: "/artists",
    tags: ["artists"],
    summary: "Track a band: resolve, compute quota, build plan, reconcile",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              mbid: z.string().optional(),
              score: z.number().int().min(1).max(3).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Band tracked and planned",
        content: {
          "application/json": {
            schema: z.object({
              artist: ArtistSchema,
              catalog: z.object({
                albums: z.number(),
                catalog: z.number(),
                method: z.string(),
              }),
              sync: SyncResultSchema,
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(trackRoute, async (c) => {
    const result = await bands.trackBand(deps, c.req.valid("json"));
    return c.json(result, 201);
  });

  const detailRoute = createRoute({
    method: "get",
    path: "/artists/{id}",
    tags: ["artists"],
    summary: "Band detail with plan rows",
    request: { params: IdParam },
    responses: {
      200: {
        description: "Band detail",
        content: {
          "application/json": {
            schema: z.object({
              artist: ArtistSchema,
              plan: z.array(PlanRowSchema),
              onDiskCount: z.number(),
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(detailRoute, (c) => {
    const detail = bands.bandDetail(deps, c.req.valid("param").id);
    return c.json(
      {
        artist: shapeArtist(detail.artist),
        plan: detail.plan.map((r) => ({
          id: r.id,
          rank: r.rank,
          title: r.title,
          norm: r.normTitle,
          pinned: r.pinned,
          status: r.status,
          source: r.source,
        })),
        onDiskCount: detail.onDiskCount,
      },
      200,
    );
  });

  const scoreRoute = createRoute({
    method: "patch",
    path: "/artists/{id}",
    tags: ["artists"],
    summary: "Change the taste tier (re-quota + re-plan immediately)",
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
        description: "Updated band with the resulting sync summary",
        content: {
          "application/json": {
            schema: z.object({ artist: ArtistSchema, sync: SyncResultSchema }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(scoreRoute, async (c) => {
    const result = await bands.setScore(
      deps,
      c.req.valid("param").id,
      c.req.valid("json").score as 1 | 2 | 3,
    );
    return c.json({ artist: shapeArtist(result.artist), sync: result.sync }, 200);
  });

  const untrackRoute = createRoute({
    method: "delete",
    path: "/artists/{id}",
    tags: ["artists"],
    summary: "Untrack a band (files are retired, never deleted)",
    request: { params: IdParam },
    responses: {
      200: {
        description: "Untracked",
        content: {
          "application/json": { schema: z.object({ retired: z.number() }) },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(untrackRoute, (c) => {
    return c.json(bands.untrack(deps, c.req.valid("param").id), 200);
  });

  const syncRoute = createRoute({
    method: "post",
    path: "/artists/{id}/sync",
    tags: ["artists"],
    summary: "Preview (apply=false) or apply the desired-state plan",
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ apply: z.boolean().optional() }).optional(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Sync result",
        content: { "application/json": { schema: SyncResultSchema } },
      },
      ...errorResponses,
    },
  });
  app.openapi(syncRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await bands.syncBand(deps, c.req.valid("param").id, {
      apply: body?.apply ?? false,
    });
    return c.json(result, 200);
  });

  const planAllRoute = createRoute({
    method: "post",
    path: "/plan",
    tags: ["artists"],
    summary:
      "Sync every tracked band as a job: build/reconcile plans and enqueue downloads (budget-gated)",
    responses: {
      202: {
        description: "Bulk plan queued (jobId null = an identical run is already queued)",
        content: {
          "application/json": { schema: z.object({ jobId: z.number().nullable() }) },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(planAllRoute, (c) => {
    const jobId = enqueueJobRow(deps.db, "plan_all", {});
    return c.json({ jobId }, 202);
  });

  const pinTrackRoute = createRoute({
    method: "post",
    path: "/artists/{id}/tracks",
    tags: ["artists"],
    summary: "Pin a track (survives every re-plan)",
    request: {
      params: IdParam,
      body: {
        content: { "application/json": { schema: z.object({ title: z.string().min(1) }) } },
      },
    },
    responses: {
      201: {
        description: "Pinned track",
        content: {
          "application/json": {
            schema: z.object({
              id: z.number(),
              rank: z.number(),
              title: z.string(),
              norm: z.string(),
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(pinTrackRoute, (c) => {
    const pinned = bands.pinTrack(deps, c.req.valid("param").id, c.req.valid("json").title);
    return c.json(pinned, 201);
  });

  const pinAlbumRoute = createRoute({
    method: "post",
    path: "/artists/{id}/albums",
    tags: ["artists"],
    summary: "Pin a whole album (MusicBrainz track list)",
    request: {
      params: IdParam,
      body: {
        content: { "application/json": { schema: z.object({ album: z.string().min(1) }) } },
      },
    },
    responses: {
      201: {
        description: "Pinned tracks (already-planned titles are skipped)",
        content: {
          "application/json": {
            schema: z.object({
              pinned: z.array(
                z.object({
                  id: z.number(),
                  rank: z.number(),
                  title: z.string(),
                  norm: z.string(),
                }),
              ),
              skipped: z.array(z.string()),
            }),
          },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(pinAlbumRoute, async (c) => {
    const result = await bands.pinAlbum(deps, c.req.valid("param").id, c.req.valid("json").album);
    return c.json(result, 201);
  });

  const removeTrackRoute = createRoute({
    method: "delete",
    path: "/artists/{id}/tracks/{norm}",
    tags: ["artists"],
    summary: "Remove a planned track (file is retired if present)",
    request: {
      params: z.object({
        id: z.coerce.number().int().positive(),
        norm: z.string().min(1),
      }),
    },
    responses: {
      200: {
        description: "Removed",
        content: {
          "application/json": { schema: z.object({ retired: z.boolean() }) },
        },
      },
      ...errorResponses,
    },
  });
  app.openapi(removeTrackRoute, (c) => {
    const p = c.req.valid("param");
    return c.json(bands.removeTrack(deps, p.id, p.norm), 200);
  });

  return app;
}
