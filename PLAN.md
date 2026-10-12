# Music Assistant — Plan

> A self-hosted music assistant that **follows trends** and **doesn't overload your library**.
> Docker-first, GitHub-hosted, single-user web UI + documented API/CLI.

---

## 1. Analysis of the existing implementation (`C:\Users\PC\Personal\music`)

### What exists today

A ~614-line PowerShell 5.1 CLI ("MusicConsolidator") managing a curated track collection
(141 bands / 1,672 files / ~16 GB) organized as `collection\<Band>\NN - Title.mp3`, where `NN`
is a stable popularity rank. State lives in `tools\state\bands.csv` (141 rows) and
`tools\state\plan.csv` (1,673 rows). Commands: `add-band`, `set-score`, `add-track`,
`add-album`, `remove-band`, `remove-track`, `status`, `resync`, `verify`.

The core loop: resolve artist on **MusicBrainz** → estimate catalog size → compute a **quota**
from a taste score (1–3) → pick top-N tracks by **Last.fm global popularity** → acquire missing
tracks (**yt-dlp** from YouTube) → rename to `NN - Title` → **retire** surplus files to
`_retired` instead of deleting → rewrite plan state.

### Good ideas to KEEP

| Idea | Why it works |
|---|---|
| **Quota formula** `quota = clamp(multiplier[score] × √catalog, floor, cap)` | Sub-linear: big catalogs don't explode. Self-correcting against estimation errors. Directly implements "don't overload my library". |
| **Score tiers 1/2/3** (background / like / love), new discoveries default to 1 | Tiny human input, big organizational effect. |
| **Reconcile-and-retire sync** (desired state diff, retire-not-delete, `-WhatIf`, `verify`) | Safe, reversible; the folder always equals the plan. |
| **Pinned tracks** that survive resync | Escape hatch from the formula. |
| **Title normalization pipeline** for dedup (fold dashes/quotes → strip parentheticals → strip "remaster/live/mix" suffixes → strip diacritics → lowercase alnum) | Battle-tested; solves real-world title chaos. |
| **Alt-version filter** (live/demo/remix/karaoke/medley) + duration gate 60–900 s | Keeps junk out of the library. |
| **Deep-cut mix** at score 3 (65 % hits / 35 % sampled deep cuts) | Depth for loved bands without flooding. |
| **Popularity rank in filename** (`NN - Title`) | File order encodes popularity in any dumb player. |
| **Merged-artist guard** (Last.fm same-name acts; pinned MBIDs) | Obscure but real problem, already solved. |
| **Canonical retagging after download** (ffmpeg metadata) | YouTube metadata is unreliable. |
| **Two-phase rename** (`~tmp~` prefix) | Rank reshuffles never collide mid-flight. |

### Problems to DROP or FIX

- **The import/provenance layer** — `useLocalLibrary` / `sourceLibrary` (Z:\media\music),
  `Get-LocalIndex` / `Select-BestLocal` / `Copy-Item` paths, plan.csv `Source`/`Ext` columns,
  old `Artist - Album - NN - Title` name parsing. Half-migrated and mostly dead. **Not needed.**
- **Schema drift** — plan.csv `Status` values (`OWNED`/`DOWNLOAD`) no longer match what the code
  writes (`PLANNED`/`COPIED`/`DOWNLOADED`/`FAILED`); statuses are effectively meaningless.
- **CSV state** — fragile, mojibake-prone on PS 5.1, no relational integrity, whole-file rewrites.
- **Duplicated logic** — retire block ×3, rank-prefix stripping ×3 inconsistent variants,
  plan dedup ×2, path join + mkdir ×6.
- **Silent failures** — Deezer `catch {}`, yt-dlp output discarded, `Get-MB` returns `$null`
  after 4 tries with no log; `add-band` saves state before sync (inconsistent on error).
- **Hardcoding scattered** — rate-limit sleeps, retry counts, page sizes (no pagination —
  catalog estimates truncate at 100 release-groups), duration gates.
- **`add-album`** (bulk-import whole albums as pinned rows) — the only "mass import" command;
  not needed in the new app.
- **verify only counts rows vs files** — renamed/replaced files pass undetected.

### Scope of the new app (from requirements)

| Requirement | Meaning |
|---|---|
| **Follows trends** | ① Manual band tracking: monitor tracked bands for new releases + discover related trending artists. ② Listening-history awareness: ingest scrobbles to build a taste profile that scores candidates. |
| **Acquisition** | Download via **yt-dlp** into the managed collection, plus local-file management and **tagging**. |
| **Anti-overload** | ① Strict caps (per band, per genre, global size/track budgets). ② **Taste-fit scoring** with a pass threshold. ③ **Auto-prune/rotation**: listening-driven score decay, demotion to retired/rotation, prune suggestions. |
| **Users** | Single-user web UI for you + documented REST API & CLI so anyone can self-host/automate. |
| **Migration** | Import existing `bands.csv` / `plan.csv` on first run. |

---

## 2. Tech stack decision

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 26** (LTS October 2026; Node 24 LTS as fallback) | Single language full-stack; yt-dlp ships JS-based challenge solvers and Node is their preferred runtime — one less dependency in Docker. |
| Language | **TypeScript 6** (`strict` default, ES2025 target) | Current stable; TS 7 (Go compiler) lands later — 6.x is the safe, supported bridge. |
| API framework | **Hono** | 2026 default for greenfield TS APIs: web-standards, first-class types (no `@types/` dance), tiny, runs on Node. Emits OpenAPI easily for the "API for others" requirement. |
| DB | **SQLite via Drizzle ORM** (`better-sqlite3`) | Self-hosting friendly: one file, no DB container, trivial backup. Drizzle gives typed schema + migrations. |
| Job queue / scheduler | **Durable SQLite-backed job queue** (small in-process worker + cron-style scheduler) | No Redis; downloads must survive restarts. |
| Frontend | **React 19 + Vite + TanStack Router + TanStack Query + Zustand + Tailwind v4 + shadcn/ui** | The consensus 2026 SPA stack. Server state via TanStack Query only; Zustand for minimal UI state. |
| Validation / contracts | **Zod** + Hono RPC / `@hono/zod-openapi` | One schema → runtime validation, TS types, OpenAPI doc. |
| Testing | **Vitest** (unit/integration) + **Testing Library** (components) + **Playwright** (smoke E2E) | Standard 2026 trio. |
| Lint/format | **Biome** | Fast single-tool lint + format; predictable output for AI-assisted edits. |
| Media tooling | **yt-dlp + ffmpeg** (baked into the image) + **node-taglib-sharp** (tag write) + **music-metadata** (tag read) | yt-dlp for acquisition, ffmpeg for audio extraction/m4a→mp3, TagLib for reliable ID3/MP4/FLAC tags (artist, title, album artist, track #, rank). |
| Metadata services | **MusicBrainz** (identity, catalog, new releases), **Last.fm** (popularity ranking, scrobbles, similar artists), **Deezer** (top-track widening, optional) | Same proven signals as the old tool, plus the scrobble history needed for taste scoring. |
| CLI | **`ma`** — thin Commander-based CLI over the same core package | "Me + API/CLI" requirement; works against local instance via API token. |
| Monorepo | **pnpm workspaces** (`apps/server`, `apps/web`, `apps/cli`, `packages/core`, `packages/integrations`) | Shares domain logic between server and CLI without duplication. |
| Deployment | **Multi-stage Dockerfile** (node:26-slim + ffmpeg + yt-dlp w/ EJS scripts + Node JS runtime), **docker-compose** with `./data` (DB) and `./collection` volumes | One `docker compose up`; state and music survive upgrades. |
| CI / release | **GitHub Actions**: lint → test → build → publish multi-arch image to **GHCR** on tag | "Hosted on GitHub" + reproducible releases. |

Deliberately excluded: PostgreSQL/Redis (overkill for one user), Next.js (no SSR need; SPA +
API is simpler to containerize), Spotify API (no streaming integration wanted), any
"import from old source library" feature.

---

## 3. AI development guidelines for this stack (fetched Oct 2026)

Sources: TypeScript devblog (TS 6.0, Mar 2026), Node.js release schedule, llmstxt.org,
addyosmani.com "How to write a good spec for AI agents", Honeycomb "How I code with LLMs",
Convex "Readable TypeScript", 2026 React/stack guides (pkgpulse, patterns.dev, TanStack docs).

1. **Pin the stack in the spec** (AGENTS.md): "Node 26, TypeScript 6 strict, Hono + Zod,
   Drizzle + SQLite, React 19 + Vite + TanStack Query" — with exact commands
   (`pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm build`). Vague specs produce vague code.
2. **Use current TS 6 defaults**: `strict: true`, `module: nodenext`, ES2025 target. Do not
   emit deprecated patterns (ES5 targets, AMD modules, implicit `any`) — 6.0 is the cleanup
   release before the Go-based 7.0.
3. **Generate incrementally, verify constantly** (Honeycomb guidance): one endpoint / one
   component / one job at a time, running tests after each — never scaffold the whole app in
   one pass. Fits the phased plan below; each phase is independently testable.
4. **Readable TS over clever TS** (Convex patterns): object params instead of long positional
   lists, small pure functions in `packages/core`, no clever generics; edge-triggered effects
   in React; ternaries over `&&` for optional rendering.
5. **React 19 rules**: no `useEffect` for data fetching (TanStack Query only), server state
   never in Zustand, feature-based folders, components < 200 lines, co-located tests,
   `lazy()` + `Suspense` for heavy views.
6. **Contract-first API**: Zod schemas are the single source of truth → generate OpenAPI →
   ship `/llms.txt` + `/llms-full.txt` on the server and in the repo, auto-derived from the
   contract so AI consumers of the API never see stale endpoints.
7. **AGENTS.md at repo root** with: objective, stack + versions, commands, project structure,
   conventions (error handling style, result types), and **boundaries** ("never touch
   `data/`, `collection/`, secrets"). The single most helpful constraint: never commit secrets —
   API keys come from env/`.env` only (the old tool committed a Last.fm key to `config.json`).
8. **Spec each feature before coding it** (Osmani): short spec with objective, stack, data
   shape example JSON, and acceptance checks. Anchor output format with one example.
9. **Test pyramid for AI safety**: pure domain logic in `packages/core` gets exhaustive
   unit tests (quota math, normalization, selection, prune policy) so refactors by AI are
   caught; integrations get contract tests with recorded fixtures (no live API calls in CI).
10. **Agent-friendly repo hygiene**: deterministic formatting (Biome), no ambiguous
    re-exports, path aliases (`@/…`), every module has one obvious home.

---

## 4. Product design

### 4.1 Concepts

- **Band** — tracked artist (MBID-keyed), with score tier 1–3 (0 = untracked/undecided).
- **Quota** — how many tracks a band "owns" in the collection. Port of the proven formula:
  `quota = clamp(multiplier[score] × √catalog, floor[score], cap[score])`, also clamped to catalog.
- **Plan** — desired state: the ranked tracks a band should own (`NN - Title`), with status
  `PLANNED → DOWNLOADING → OWNED | FAILED`, and `pinned` flag for manual picks.
- **Library** — what's actually on disk (scanned + tagged), reconciled against the plan.
- **Taste profile** — derived from scrobbles + scores + play history: per-genre weights,
  per-band affinity, era/decade preferences. Feeds **taste-fit scoring** (0–100) of candidates.
- **Candidate** — proposed addition (new band, new release, related artist, missing hit track).
  Enters the **queue**, never the library directly.
- **Retired / rotation** — tracks that fell out of the plan or decayed; moved to
  `collection/_retired/<Band>/`, recoverable, invisible to players scanning the collection.

### 4.2 Anti-overload policy engine (the heart of "doesn't overload")

Layered gates — a candidate must pass **all** to be auto-queued:

1. **Taste-fit threshold** — score ≥ configured threshold (default 70) vs taste profile.
2. **Per-band cap** — quota formula (existing) + hard max per band.
3. **Per-genre cap** — max tracks / max % of library per genre group; genre over budget ⇒
   candidates get penalized scores instead of blocked (keeps balance soft but effective).
4. **Global budgets** — max total tracks, max GB, max *new acquisitions per month*
   (e.g. 40 tracks/month). The month budget is spent by highest taste-fit first.
5. **Rotation & decay** — every track accrues `last_played`, `play_count`. Unplayed tracks
   older than N months decay; below threshold they propose demotion to rotation/retired.
   A weekly **prune report** lists candidates for removal to hit the size target.
6. **Approval mode** — `manual` (default: approve/reject in the queue UI), `auto` (all gates
   auto-approved), `hybrid` (auto-approve ≥ 85 taste-fit, queue the rest).

### 4.3 Trend following

- **Release radar** — daily/weekly job: for every tracked band, fetch MusicBrainz
  release-groups since last check → surface new singles/albums as candidates ("Metallica
  released X"). Album tracks can be pinned via the existing `add-album`-style flow (kept,
  but as "pin album" on a release, not bulk import).
- **Discovery feed** — Last.fm `artist.getSimilar` on your highest-affinity bands + Deezer
  top-track widening → candidates scored by taste-fit, deduped against known/ignored artists.
- **History-aware ranking** — Last.fm (or ListenBrainz) scrobble ingestion updates the taste
  profile and per-track popularity ranks; the `NN` rank prefix re-syncs as global popularity
  and your own plays change over time (two-phase rename keeps it collision-free).
- **Weekly digest** — "N candidates, 2 new releases, library at 87 % of budget" — rendered
  in the UI and optionally as markdown (nice-to-have: ntfy/Shoutrrr notification).

### 4.4 Core workflows (mapped from the old commands)

| Old | New |
|---|---|
| `add-band` | Web: "Track band" → MB resolution with disambiguation + alternative candidates shown → score tier → queue-based sync |
| `set-score` | Score picker on band page; triggers re-plan (quota diff) |
| `resync` | "Re-plan" button / scheduled reconcile job; full desired-state diff with WhatIf-style preview |
| `add-track` | "Pin track" on search; survives re-plans |
| `add-album` | "Pin album" on a release |
| `remove-band/track` | "Untrack" / "Remove" → retire (reversible), with bulk selection |
| `status` | Dashboard: library health, budgets, queue, job history |
| `verify` | Deep verify job: plan vs disk by normalized title **and** file hash/size (not just counts) |
| *(import layer)* | One-shot `ma migrate` / first-run wizard importing `bands.csv` + `plan.csv` + collection scan |

### 4.5 Web UI (single user)

- **Dashboard** — library size vs budget, monthly acquisition spend, queue count, job status,
  prune report, new releases.
- **Bands** — list with score/quota/on-disk; band page: plan table, retire/restore, pin tracks,
  release radar.
- **Queue** — candidate review: taste-fit score, why-suggested (similar-to X / new release /
  trending), approve/reject/ignore-artist (persisted "never suggest" list).
- **Trends** — discovery feed + scrobble history stats.
- **Settings** — formula tuning (multipliers/floors/caps/deepShare), policy gates, approval
  mode, API tokens, integrations (Last.fm API key, MB user-agent — editable here, masked,
  env-var override supported), migration tool.

### 4.6 API & CLI

- REST API (OpenAPI 3.1 via `@hono/zod-openapi`), token auth (`Authorization: Bearer`).
- `/llms.txt` + `/llms-full.txt` served from the app and stored in-repo.
- `ma` CLI: `ma bands`, `ma track <artist>`, `ma score <artist> 3`, `ma queue`, `ma sync`,
  `ma status`, `ma migrate`, `ma verify` — for scripting and other self-hosters.

---

## 5. Data model (SQLite, Drizzle)

```
artists       id, mbid, name, disambig, score(0-3), catalog_size, quota, pinned_mbid, ignored, created_at
tracks        id, artist_id, title, norm_title, rank, pinned, status, file_path, ext,
              duration_s, hash, play_count, last_played, acquired_at
plan_items    id, artist_id, track_id?, title, norm_title, rank, pinned, status, source(why)
albums        id, artist_id, mbid, title, release_date, type
candidates    id, type(new_release|related|trending|missing_track), artist_id?, payload_json,
              taste_fit, status(pending|approved|rejected), reason, created_at
scrobbles     id, artist_id?, title, album, played_at, source
taste_profile id?, genre_weights_json, era_weights_json, updated_at
jobs          id, type, payload_json, status, attempts, run_at, started_at, finished_at, error
settings      key, value_json
events        id, kind, payload_json, created_at   -- audit log for every sync/prune decision
```

Normalization pipeline, quota formula, alt-version regexes and the merge-guard logic move
into `packages/core` verbatim (rewritten in TS, unit-tested against the legacy behavior).

---

## 6. Implementation plan

Phased so every phase ends with a runnable, tested artifact. Per AI-dev guidelines: implement
one vertical slice at a time with tests, not big-bang scaffolds.

### Phase 0 — Foundation (repo, CI, Docker skeleton)
- pnpm monorepo; TS 6 strict; Biome; Vitest; GitHub Actions (lint/test/build); `AGENTS.md`.
- Multi-stage Dockerfile (node:26-slim + ffmpeg + yt-dlp + EJS scripts); compose file with
  `./data` and `./collection` volumes; GHCR publish workflow.
- **Exit**: `docker compose up` serves a "hello" health endpoint; CI green.

### Phase 1 — Core domain + storage
- Drizzle schema + migrations; `packages/core`: normalization, quota formula, track selection
  (top-N + deep-cut mix), alt-version filter, desired-state diff engine (reconcile/retire plan).
- Unit tests: golden cases ported from the legacy tool (e.g. AC/DC catalog 174 @ score 3 → 26).
- **Exit**: pure functions reproduce legacy plan selection on recorded Last.fm fixtures.

### Phase 2 — Integrations + band tracking
- MusicBrainz client (rate-limited, retried, paginated — fixes the 100-item truncation bug),
  Last.fm client (UTF-8-safe), Deezer optional; artist resolution UI flow with disambiguation.
- Track/untrack/score flows; sync job = plan diff + preview (WhatIf equivalent) + apply.
- **Exit**: adding a band in the UI produces a plan identical in spirit to `add-band` of old.

### Phase 3 — Acquisition pipeline (yt-dlp + tagging)
- SQLite job queue + worker; download job (ytsearch with quality filters, retries, logged
  output — no more silent failures), ffmpeg convert, TagLib canonical retag (artist/title/
  album-artist/rank), two-phase rename, retire/restore, deep verify job (hash-aware).
- **Exit**: a planned track ends up as `NN - Title.mp3` with correct tags; failure states visible.

### Phase 4 — Web UI (MVP)
- Vite + React 19 + TanStack stack; Dashboard, Bands, Band detail, Queue (manual approval),
  Settings (formula + gates); API tokens.
- **Exit**: full loop works from the browser with zero CLI usage.

### Phase 5 — Trends & taste
- Scrobble ingestion (Last.fm import + ongoing sync), taste profile computation,
  taste-fit scoring for candidates, `artist.getSimilar` discovery feed, MusicBrainz release
  radar job, weekly digest; rank re-sync as popularity drifts.
- **Exit**: queue shows explained, scored candidates; digest generated.

### Phase 6 — Anti-overload policy engine
- Caps (band/genre/global), monthly budget spending by taste-fit, approval modes
  (manual/hybrid/auto), decay + rotation + prune report, "never suggest" list.
- **Exit**: policy simulator view ("what would change if I set score 3 on X / lower budget").

### Phase 7 — API polish, CLI, docs, release
- OpenAPI generation, `/llms.txt`, `ma` CLI, first-run wizard (settings + migration),
  `ma migrate` importing legacy `bands.csv`/`plan.csv` + collection scan (import once, then
  retire the CSVs), README (self-hosting guide for others), tagged v1.0 → GHCR image.

### Migration strategy (from the interview decision)
- One-shot importer: parse `bands.csv` (Band, Score, MBID, Catalog) and `plan.csv`
  (Band, Rank, Title, Pinned) using the same normalization rules; scan `collection/**` to
  mark tracks OWNED and hash files; map legacy statuses (`OWNED`/`DOWNLOAD`/`PLANNED`) to the
  new enum; report everything it couldn't map instead of guessing.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| yt-dlp breakage (YouTube n-challenge/EJS/JS-runtime issues are frequent in 2026) | Bake yt-dlp + EJS scripts + Node runtime into image; pin version; updater job + visible job errors; retries with alternate player-clients (proven recipe from legacy tool). |
| MusicBrainz/Last.fm rate limits & outages | Central rate-limited clients with backoff + fixtures for tests; jobs are durable and resumable. |
| Same-name artist merges (Last.fm) | Keep pinned-MBID override + merged-artist whitelist (proven solution). |
| Title/metadata chaos causing dupes | Keep the battle-tested normalization pipeline + alt-version filter verbatim, with golden tests. |
| Library grows despite limits | Hard global budgets are enforced server-side in the sync engine, not just UI suggestions. |
| Secrets leak (legacy committed an API key) | All API keys are **configurable in Settings** (stored server-side, masked in UI) with env-var overrides; the legacy Last.fm key is carried over for testing and rotated by the owner later. |

## 8. Non-goals (explicitly out)

- Import/consolidation from an old source library (the `Z:\media\music` feature).
- Streaming-service playback or Spotify sync.
- Multi-user accounts/permissions (the API is for automation and other self-hosters).
- Audio fingerprinting (AcoustID) — normalization + MusicBrainz matching suffices for now.
- Mobile apps (responsive web covers it).
