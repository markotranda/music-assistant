# Music Assistant

A self-hosted music assistant that **follows trends** and **doesn't overload your library**.

- **Trends**: release radar for bands you track, scrobble-informed discovery feed, taste-fit
  scoring for every candidate.
- **Anti-overload**: per-band quotas, per-genre and global budgets, monthly acquisition
  budget, decay/rotation with prune reports. Nothing enters the library without passing the
  gates (or your approval).
- **Acquisition**: downloads via yt-dlp, canonical retagging, retire-not-delete.

## Quick start (Docker)

```sh
cp .env.example .env   # fill in LASTFM_API_KEY and MA_USER_AGENT
docker compose up -d
# open http://localhost:8787
```

Data lives in `./data` (SQLite), your music in `./collection`. Both survive upgrades.

## Development

```sh
pnpm install
pnpm dev          # API on :8787, web UI on :5173
pnpm test
pnpm lint
```

## API

Contract-first: the OpenAPI document is generated from the Zod schemas and served at
`/doc`. See `PLAN.md` for the product plan and `AGENTS.md` for contributor/agent guidance.

## Status

Phase 0 (foundation) — see `PLAN.md` §6 for the implementation roadmap.
