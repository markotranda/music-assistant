import { serveStatic } from "@hono/node-server/serve-static";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { MA_CORE_VERSION } from "@ma/core";
import { IntegrationError } from "@ma/integrations";
import { z } from "zod";
import type { AppDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { createArtistsRoutes } from "./routes/artists.js";
import { createJobsRoutes } from "./routes/jobs.js";

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // Typed errors -> HTTP status. Services throw ApiError; nothing is swallowed.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message, ...err.details }, err.status as 400);
    }
    if (err instanceof IntegrationError) {
      // Upstream service failure: surface WHICH service and why, never a
      // generic "internal error" (the legacy tool's biggest flaw was silence).
      return c.json(
        {
          error: `upstream ${err.service} failure: ${err.message}`,
          service: err.service,
          upstreamStatus: err.status ?? null,
        },
        502,
      );
    }
    console.error("unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  const healthRoute = createRoute({
    method: "get",
    path: "/health",
    tags: ["system"],
    summary: "Health check",
    responses: {
      200: {
        description: "Service health",
        content: {
          "application/json": {
            schema: z.object({
              status: z.literal("ok"),
              version: z.string(),
              time: z.string(),
            }),
          },
        },
      },
    },
  });

  app.openapi(healthRoute, (c) =>
    c.json({
      status: "ok" as const,
      version: MA_CORE_VERSION,
      time: new Date().toISOString(),
    }),
  );

  app.route("/api", createArtistsRoutes(deps));
  app.route("/api", createJobsRoutes(deps));

  // Contract-first API: the OpenAPI document is generated from the Zod schemas
  // above and is the single source of truth for the public API (see /llms.txt).
  app.doc("/doc", {
    openapi: "3.1.0",
    info: {
      title: "Music Assistant API",
      version: MA_CORE_VERSION,
      description:
        "Self-hosted music assistant that follows trends and doesn't overload your library.",
    },
  });

  // Serve the built web UI when its directory is available (Docker image).
  // Set MA_WEB_DIR (e.g. "./web"); unset in dev, where Vite serves the UI.
  const webDir = process.env.MA_WEB_DIR;
  if (webDir) {
    app.get("/*", serveStatic({ root: webDir }));
  }

  return app;
}
