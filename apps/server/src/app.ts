import { serveStatic } from "@hono/node-server/serve-static";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { MA_CORE_VERSION } from "@ma/core";
import { IntegrationError } from "@ma/integrations";
import { z } from "zod";
import { authMiddleware } from "./auth.js";
import type { AppDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { buildLlmsFullTxt, buildLlmsTxt } from "./llms.js";
import { createArtistsRoutes } from "./routes/artists.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createJobsRoutes } from "./routes/jobs.js";
import { createMigrateRoutes } from "./routes/migrate.js";
import { createPolicyRoutes } from "./routes/policy.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createTrendsRoutes } from "./routes/trends.js";

/** Shared by /doc, /llms.txt and the in-repo docs snapshot. */
export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: {
    title: "Music Assistant API",
    version: MA_CORE_VERSION,
    description:
      "Self-hosted music assistant that follows trends and doesn't overload your library.",
  },
};

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono({
    // Request validation failures return a typed 422 like service-side
    // validation — one status, one shape for "your input is wrong".
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "validation failed",
            issues: result.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          422,
        );
      }
    },
  });

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

  // Bearer-token gate for the API when a token is set in Settings (off by
  // default). /health, /doc and the static web UI stay open.
  app.use("/api/*", authMiddleware(deps));

  app.route("/api", createArtistsRoutes(deps));
  app.route("/api", createJobsRoutes(deps));
  app.route("/api", createSettingsRoutes(deps));
  app.route("/api", createDashboardRoutes(deps));
  app.route("/api", createTrendsRoutes(deps));
  app.route("/api", createPolicyRoutes(deps));
  app.route("/api", createMigrateRoutes(deps));

  // Contract-first API: the OpenAPI document is generated from the Zod schemas
  // above and is the single source of truth for the public API (see /llms.txt).
  app.doc("/doc", OPENAPI_CONFIG);

  // AI-agent interface (PLAN §4.5): llmstxt.org format, derived from the same
  // OpenAPI document so it can never drift from the routes.
  const spec = app.getOpenAPI31Document(OPENAPI_CONFIG) as unknown as Parameters<
    typeof buildLlmsTxt
  >[0];
  app.get("/llms.txt", (c) => c.text(buildLlmsTxt(spec)));
  app.get("/llms-full.txt", (c) => c.text(buildLlmsFullTxt(spec)));

  // Serve the built web UI when its directory is available (Docker image).
  // Set MA_WEB_DIR (e.g. "./web"); unset in dev, where Vite serves the UI.
  const webDir = process.env.MA_WEB_DIR;
  if (webDir) {
    app.get(
      "/*",
      serveStatic({
        root: webDir,
        // SPA fallback: paths without a file extension (deep links like
        // /bands/12) get index.html so client-side routing can take over.
        rewriteRequestPath: (path) => (path.includes(".") ? path : "/index.html"),
      }),
    );
  }

  return app;
}
