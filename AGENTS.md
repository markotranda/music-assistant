# AGENTS.md — guidance for AI coding agents (and humans)

## Objective

Music Assistant: a self-hosted web app that **follows trends** (release radar for tracked
bands, scrobble-informed discovery) and **doesn't overload the library** (quota formula,
taste-fit gates, budgets, decay/rotation/prune). Docker-first, single-user UI + public
REST API/CLI. Full product plan: `PLAN.md`.

## Tech stack (pinned)

- **Node.js 24+** (Docker runtime: `node:26-slim`), package manager **pnpm 12** (workspaces)
- **TypeScript 6** — `strict` (see `tsconfig.base.json`), `nodenext` modules for Node code,
  `bundler` resolution for web. ESM everywhere (`"type": "module"`); relative imports in
  Node packages use explicit `.js` extensions.
- **Hono + @hono/zod-openapi + Zod 4** — API server. Zod schemas are the single source of
  truth: they produce runtime validation, TS types, and the OpenAPI doc at `/doc`.
- **Drizzle ORM + SQLite** (Phase 1+) — single-file DB in `./data`.
- **React 19 + Vite + TanStack Query + Tailwind CSS v4** — web UI (TanStack Router,
  Zustand, shadcn/ui arrive with Phase 4 UI work).
- **Vitest** (unit/integration), **Biome** (lint + format).
- **yt-dlp + ffmpeg + node-taglib-sharp** (Phase 3+) — acquisition and tagging.

## Commands

```sh
pnpm install        # install workspace dependencies
pnpm dev            # run server (:8787) + web (:5173) in parallel
pnpm build          # build all packages (topological order)
pnpm typecheck      # tsc --noEmit per package
pnpm test           # builds libs, then runs Vitest (run build first on fresh checkout)
pnpm lint           # biome check
pnpm format         # biome check --write
docker compose up   # production-ish single container (needs .env)
```

## Project structure

```
apps/server/        Hono API (routes in src/app.ts), entry src/index.ts
apps/web/           React SPA (Vite)
apps/cli/           `ma` Commander CLI
packages/core/      PURE domain logic only (quota, normalization, selection, policy).
                    No I/O, no deps. This is where behavior is unit-tested.
packages/integrations/  External adapters (MusicBrainz, Last.fm, Deezer, yt-dlp, fs).
                    Config-injected, fixture-tested, no live calls in CI.
data/               SQLite + app state (gitignored, Docker volume)
collection/         Managed music library (gitignored, Docker volume)
```

## Conventions

- **Pure core**: business rules live in `packages/core` as pure functions with golden tests.
  Ported legacy behavior (quota formula, `Norm-Title` pipeline, alt-version filter) must
  match the legacy tool's outputs — see `PLAN.md` §1.
- **Contract-first API**: add routes with `createRoute` + Zod schemas in `src/app.ts` (or
  per-feature modules); never return untyped JSON.
- **Errors**: integrations throw typed errors; job handlers record failures into the
  `jobs` table with messages. No silent `catch {}` — the legacy tool's biggest flaw.
- **Imports**: `import type` for type-only imports (`verbatimModuleSyntax` is on).
- **Formatting/lint**: Biome is authoritative; run `pnpm format` before committing.
- **Secrets**: never hardcode API keys. Config comes from env (`.env`, gitignored) and the
  Settings store. `.env.example` holds placeholders only.

## Boundaries (never touch)

- `data/`, `collection/`, `.env` — runtime/user state.
- Legacy project `C:\Users\PC\Personal\music` — read-only reference for behavior porting.
- Never commit secrets; never weaken `strict` TS options.

## Current phase

Phase 0 (foundation) complete: monorepo, CI, Docker, health endpoint, smoke tests.
Next: Phase 1 — Drizzle schema + `packages/core` domain (quota, normalization, selection).
Before starting a phase, its plan is presented to the owner for approval.
