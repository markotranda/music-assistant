# docs

- `llms.txt` / `llms-full.txt` — generated snapshots of the AI-agent interface
  (PLAN.md §4.5). The server serves live versions of the same content at
  `/llms.txt` and `/llms-full.txt`, derived from the OpenAPI document.

Regenerate after API changes with `pnpm llms` (builds the server, then writes
both files from the same builders the server uses).
