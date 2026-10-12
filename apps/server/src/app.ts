import { serveStatic } from "@hono/node-server/serve-static";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { MA_CORE_VERSION } from "@ma/core";
import { z } from "zod";

export const app = new OpenAPIHono();

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
