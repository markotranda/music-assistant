/**
 * `/llms.txt` + `/llms-full.txt` (PLAN.md §4.5 "AI-agent interface"): the
 * product's API surface in the llmstxt.org format, derived from the live
 * OpenAPI document so it can never drift from the routes. The server serves
 * these; `node dist/server.js --print-llms[-full]` writes the in-repo copy.
 */

type Doc = {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, unknown>>;
};

type Operation = {
  summary?: string;
  description?: string;
  tags?: string[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
};

function operations(doc: Doc): { method: string; path: string; op: Operation }[] {
  const out: { method: string; path: string; op: Operation }[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, raw] of Object.entries(methods ?? {})) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      out.push({ method: method.toUpperCase(), path, op: raw as Operation });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const OVERVIEW = `# Music Assistant

> Self-hosted release radar and library manager for tracked bands: follows new
> releases and related artists, scores them against your scrobble-derived taste,
> and keeps the library under strict anti-overload budgets. Single-user web UI,
> documented REST API and \`ma\` CLI. Acquisition via yt-dlp; local files only.

Everything is a REST call under \`/api\`. Responses are JSON. Errors are typed:
\`422 {error, details}\` for validation, \`502 {error, service, upstreamStatus}\`
for upstream failures. The full OpenAPI document lives at \`/doc\`.

## Core concepts

- **Band** — a tracked artist with a score (1 casual / 2 fan / 3 favorite) and a
  plan. The plan size comes from the quota formula
  \`quota = clamp(multiplier[score] × √catalog, floor, cap)\` with banker's rounding.
- **Plan** — the desired top-N tracks per band, rank-prefixed files
  \`NN - Title.ext\` in \`<collection>/<Band>/\`. Pinned tracks survive re-plans.
- **Jobs** — durable queue (\`download\`, \`verify\`, \`scrobble_sync\`,
  \`release_radar\`, \`discovery\`, \`prune_scan\`, \`rotation_scan\`, \`plan_all\`,
  \`migrate\`).
- **Candidates** — suggestions (new release / related artist) with a 0-100
  taste-fit score and human-readable reasons; they never enter the library
  directly. Approval modes: manual / hybrid (auto ≥ 85 fit) / auto.
- **Policy** — anti-overload gates: taste-fit threshold, per-band cap, soft
  genre penalty, hard track/GB budgets, soft monthly target, decay → prune
  (retire to \`_retired/<Band>/\`, recoverable), rank rotation.

## CLI

\`ma\` mirrors the API: \`ma track <band> --score 2\`, \`ma sync <id>\`, \`ma pin\`,
\`ma jobs\`, \`ma verify\`, \`ma candidates\`, \`ma approve|reject\`, \`ma digest\`,
\`ma policy\`, \`ma prune\`, \`ma simulate\`, \`ma migrate --bands <csv> --plan <csv>\`,
\`ma api\`. Use \`--url\` to point at a remote instance.

## Endpoints
`;

/** Short reference: product overview + endpoint list. */
export function buildLlmsTxt(doc: Doc): string {
  const lines = operations(doc).map(
    ({ method, path, op }) => `- \`${method} ${path}\` — ${op.summary ?? "(no summary)"}`,
  );
  return `${OVERVIEW}\n${lines.join("\n")}\n\n## Full reference\n\n- /llms-full.txt — every endpoint with request/response schemas\n- /doc — OpenAPI JSON\n`;
}

const FULL_INTRO = `# Music Assistant — full API reference

Generated from the live OpenAPI document. Schemas use JSON Schema notation.
`;

/** Full reference: every endpoint with its request/response schemas. */
export function buildLlmsFullTxt(doc: Doc): string {
  const parts = [FULL_INTRO];
  for (const { method, path, op } of operations(doc)) {
    parts.push(`## ${method} ${path}`);
    if (op.summary) parts.push(`\n${op.summary}`);
    if (op.description) parts.push(`\n${op.description}`);
    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    if (bodySchema) {
      parts.push(
        `\nRequest body (application/json):\n\n\`\`\`json\n${JSON.stringify(bodySchema, null, 2)}\n\`\`\``,
      );
    }
    for (const [code, res] of Object.entries(op.responses ?? {})) {
      const schema = res.content?.["application/json"]?.schema;
      parts.push(`\nResponse ${code}: ${res.description ?? ""}`);
      if (schema) {
        parts.push(`\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}
