# Music Assistant

A self-hosted music assistant that **follows trends** and **doesn't overload your library**.

- **Trends** — a release radar for the bands you track, a scrobble-informed discovery feed,
  and taste-fit scoring (0–100, with human-readable reasons) for every candidate.
- **Anti-overload** — per-band quotas from a proven formula, per-genre balance, hard library
  budgets, a soft monthly acquisition target, decay → prune reports and rank rotation.
  Nothing enters the library without passing the gates (or your explicit approval).
- **Acquisition** — yt-dlp downloads, canonical retagging, verification by content hash.
  Your files stay yours: retire-not-delete (`_retired/<Band>/`), no streaming service.

Single-user web UI, plus a documented REST API and `ma` CLI so anyone can self-host and
automate.

## Quick start (Docker)

```sh
cp .env.example .env      # fill in LASTFM_API_KEY and MA_USER_AGENT
docker compose up -d      # build + start on http://localhost:8787
```

Or pull the published image (multi-arch). Every push to `main` is versioned and built
automatically — `:latest` always matches `main`, and each build also gets a patch tag
(`:1.1.1`, `:1.1`, …). Manual `v*` tags cut feature versions.

```sh
docker pull ghcr.io/markotranda/music-assistant:latest
```

State lives in `./data` (one SQLite file — trivial to back up), your managed music in
`./collection`. Both survive upgrades.

## Configuration

Values in `.env` seed the app; everything can be changed later in **Settings** (stored in
the database, secrets are masked in reads).

| Variable | Purpose |
|---|---|
| `LASTFM_API_KEY` | Popularity rankings, scrobbles, similar artists |
| `MA_USER_AGENT` | MusicBrainz User-Agent with contact info (required by MB etiquette) |
| `PORT` | HTTP port (default `8787`) |
| `MA_API_URL` | Base URL the CLI talks to (default `http://localhost:8787`) |
| `MA_DATA_DIR` / `MA_COLLECTION_DIR` / `MA_RETIRED_DIR` | Where state, the collection and retired files live (the compose file mounts these) |

Optional bearer token for the API can be enabled in Settings (off by default).

## First run

An empty instance shows a **first-run wizard** on the dashboard:

1. Configure integrations (Last.fm key + username, MusicBrainz user-agent).
2. Either **import your legacy state** (see below) or **start fresh** by tracking a band.

### Coming from the old PowerShell tool

The one-shot importer reads the old `bands.csv` + `plan.csv` and matches files in the
collection by normalized title:

```sh
ma migrate --bands tools/state/bands.csv --plan tools/state/plan.csv
```

or upload both CSVs in the dashboard wizard. **Bands-only import works too** — if you're
not keeping the old collection, import just `bands.csv` and every band keeps its score
while plans are built fresh and acquired through the normal pipeline:

```sh
ma migrate --bands bands.csv
```

What it does and doesn't do:

- Bands keep their score, MBID and disambiguation; quota is recomputed with the pinned
  formula and **cross-checked against the legacy `Quota` column** (mismatches are reported).
- Plan rows whose file exists become `OWNED` tracks (real content hash + size); the rest
  become `PLANNED` — legacy statuses are known-stale, so the disk decides. Migrated tracks
  get their acquisition date from the file's mtime (keeps the monthly budget honest and the
  decay clock realistic).
- **The collection is only read.** Files that match no plan row stay untouched and are
  listed in the migration report. Re-running the import is safe (existing rows are skipped).
- After importing a real collection, review **Policy** before letting the weekly rotation /
  prune jobs run — they can rename rank prefixes and retire idle tracks (recoverable from
  `_retired/`).

## Concepts

- **Band** — a tracked artist with a score (1 casual / 2 fan / 3 favorite). The plan size
  comes from the quota formula `quota = clamp(multiplier[score] × √catalog, floor, cap)`
  (banker's rounding — parity-pinned against the legacy tool's output).
- **Plan** — the desired top-N tracks per band; files are `NN - Title.ext` in
  `<collection>/<Band>/`. Pinned tracks survive re-plans.
- **Candidates** — new-release and related-artist suggestions with taste-fit scores and
  reasons. Approval modes: `manual`, `hybrid` (auto-approve ≥ 85 fit), `auto`. Related
  artists you approve land at score 1 — raise it when they earn it.
- **Policy** — the anti-overload engine: taste-fit threshold, per-band cap, soft genre
  penalty, hard track/GB budgets (enforced server-side at download time), soft monthly
  target (overflow allowed), weekly prune report with optional auto-retire.

## REST API & CLI

Contract-first: every endpoint is defined by Zod schemas and the OpenAPI document is
generated from them.

- `/doc` — OpenAPI JSON
- `/llms.txt`, `/llms-full.txt` — llmstxt.org-format API reference (also committed under
  `docs/`, regenerate with `pnpm llms`)

```sh
ma track "Terror" --score 2     # track a band (resolves on MusicBrainz)
ma sync 1                       # preview/apply the plan
ma jobs                         # background job queue
ma candidates                   # review suggestions
ma policy                       # budgets + gates
ma prune                        # decay report (apply: ma prune apply)
ma simulate '{"Terror": 3}'     # "what would change?" — projection only
ma api                          # list all endpoints
```

Examples for the REST API:

```sh
curl localhost:8787/api/artists
curl localhost:8787/api/dashboard
curl -X POST localhost:8787/api/policy/simulate \
  -H 'content-type: application/json' -d '{"scoreChanges": {"Terror": 3}}'
```

## Development

```sh
pnpm install
pnpm dev          # API on :8787, web UI on :5173
pnpm test         # build libs + vitest (unit + integration + UI)
pnpm typecheck    # tsc --noEmit per package
pnpm lint         # biome
pnpm build        # all packages (topological order)
```

Monorepo layout: `apps/server` (Hono API + jobs), `apps/web` (React 19 + Vite),
`apps/cli` (`ma`), `packages/core` (pure domain logic — quota, normalization, selection,
policy; golden-tested), `packages/integrations` (MusicBrainz, Last.fm, Deezer, yt-dlp,
filesystem). See `PLAN.md` for the product plan and `AGENTS.md` for contributor guidance.

## Backup & upgrades

- **Backup** = copy `./data` and `./collection`. That's everything.
- Upgrades: pull the new image (or rebuild) and restart — migrations run automatically.
- Retired tracks are recoverable from `_retired/<Band>/`; deleting them is the only
  destructive action and it's yours to take.
