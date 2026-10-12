import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getSetting } from "./db/repositories.js";
import { type AuthSettings, DEFAULT_AUTH } from "./db/seed.js";
import type { AppDeps } from "./deps.js";

/**
 * Bearer-token auth for `/api/*` (PLAN.md §4.6). Off by default: until a token
 * is set in Settings the API is open (single-user LAN app). `/health`, `/doc`
 * and the static web UI stay open so the login screen can load.
 */

export function tokenMatches(provided: string, expected: string): boolean {
  // Constant-time compare via digest (both sides are equal-length buffers).
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authMiddleware(deps: AppDeps) {
  return async (c: Context, next: Next) => {
    const auth = getSetting<AuthSettings>(deps.db, "auth") ?? DEFAULT_AUTH;
    if (!auth.token) return next();

    const header = c.req.header("authorization");
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!provided || !tokenMatches(provided, auth.token)) {
      return c.json({ error: "missing or invalid API token" }, 401);
    }
    return next();
  };
}
