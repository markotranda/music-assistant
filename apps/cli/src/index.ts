#!/usr/bin/env node
import { Command } from "commander";

const DEFAULT_API_URL = process.env.MA_API_URL ?? "http://localhost:8787";

type Artist = {
  id: number;
  name: string;
  mbid: string;
  score: number;
  catalogSize: number | null;
  quota: number | null;
  planCount: number;
  onDiskCount: number;
};

const program = new Command();
const api = {
  url: DEFAULT_API_URL,
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status} from ${this.url}${path}`);
    }
    return body;
  },
};

async function findArtist(name: string): Promise<Artist> {
  const { artists } = await api.request<{ artists: Artist[] }>("/api/artists");
  const hit = artists.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!hit) {
    const known = artists.map((a) => a.name).join(", ") || "(none tracked)";
    throw new Error(`'${name}' is not tracked. Tracked bands: ${known}`);
  }
  return hit;
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

program
  .name("ma")
  .description("Music Assistant CLI — follow trends, keep the library lean")
  .version("0.0.0")
  .option("-u, --url <url>", "API base URL", DEFAULT_API_URL)
  .hook("preAction", (thisCommand) => {
    api.url = thisCommand.opts().url as string;
  });

program
  .command("health")
  .description("Check that the Music Assistant API is reachable")
  .action(async () => {
    try {
      const body = await api.request<{ status: string; version: string; time: string }>("/health");
      console.log(`ok — version ${body.version} (${body.time})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("bands")
  .description("List tracked bands")
  .action(async () => {
    try {
      const { artists } = await api.request<{ artists: Artist[] }>("/api/artists");
      if (artists.length === 0) {
        console.log("no bands tracked yet — try: ma track <artist>");
        return;
      }
      for (const a of artists) {
        console.log(
          `${String(a.score)}  ${a.name.padEnd(30)} quota ${String(a.quota ?? "-").padEnd(4)} plan ${String(a.planCount).padEnd(4)} disk ${a.onDiskCount}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("resolve <name>")
  .description("Resolve a name to MusicBrainz candidates (no side effects)")
  .action(async (name: string) => {
    try {
      const r = await api.request<{
        mbid: string;
        name: string;
        country: string | null;
        disambiguation: string | null;
        alternatives: { name: string; country: string | null; disambiguation: string | null }[];
      }>("/api/artists/resolve", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      console.log(`best: ${r.name} [${r.country ?? "?"}] ${r.disambiguation ?? ""} (${r.mbid})`);
      for (const alt of r.alternatives) {
        console.log(`  alt: ${alt.name} [${alt.country ?? "?"}] ${alt.disambiguation ?? ""}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("track <name>")
  .description("Track a band: resolve, plan its top tracks, reconcile")
  .option("-s, --score <1-3>", "taste tier (default 1)", "1")
  .option("-m, --mbid <mbid>", "force a specific MusicBrainz artist id")
  .action(async (name: string, opts: { score: string; mbid?: string }) => {
    try {
      const r = await api.request<{
        artist: Artist;
        catalog: { catalog: number; method: string };
        sync: { acquire: unknown[] };
      }>("/api/artists", {
        method: "POST",
        body: JSON.stringify({
          name,
          score: Number(opts.score),
          ...(opts.mbid ? { mbid: opts.mbid } : {}),
        }),
      });
      console.log(
        `tracking ${r.artist.name} (${r.artist.mbid}) — score ${r.artist.score}, catalog ${r.catalog.catalog} (${r.catalog.method}), quota ${r.artist.quota}`,
      );
      console.log(`planned; ${r.sync.acquire.length} track(s) queued for acquisition`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("score <name> <score>")
  .description("Change a band's taste tier (1-3); re-plans immediately")
  .action(async (name: string, score: string) => {
    try {
      const artist = await findArtist(name);
      const r = await api.request<{
        artist: Artist;
        sync: { desired: unknown[]; retire: unknown[] };
      }>(`/api/artists/${artist.id}`, {
        method: "PATCH",
        body: JSON.stringify({ score: Number(score) }),
      });
      console.log(
        `${r.artist.name} -> score ${r.artist.score}, quota ${r.artist.quota}, plan ${r.sync.desired.length}, retired ${r.sync.retire.length}`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("plan <name>")
  .description("Show a band's planned tracks")
  .action(async (name: string) => {
    try {
      const artist = await findArtist(name);
      const r = await api.request<{
        plan: { rank: number; title: string; pinned: boolean; status: string }[];
        onDiskCount: number;
      }>(`/api/artists/${artist.id}`);
      for (const row of r.plan) {
        console.log(
          `${String(row.rank).padStart(2, "0")} - ${row.title}${row.pinned ? "  [pinned]" : ""}  ${row.status}`,
        );
      }
      console.log(`(${r.plan.length} planned, ${r.onDiskCount} on disk)`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("sync [name]")
  .description(
    "Preview (default) or apply the desired-state plan for one band; without a name, plan every tracked band as a job",
  )
  .option("--apply", "apply the plan (rename/retire/queue downloads)")
  .action(async (name: string | undefined, opts: { apply?: boolean }) => {
    try {
      if (!name) {
        const r = await api.request<{ jobId: number | null }>("/api/plan", {
          method: "POST",
          body: JSON.stringify({}),
        });
        console.log(
          r.jobId === null
            ? "a bulk plan is already queued (nothing to do)"
            : `bulk plan queued as job ${r.jobId} — progress shows in 'ma jobs'`,
        );
        return;
      }
      const artist = await findArtist(name);
      const r = await api.request<{
        applied: boolean;
        acquire: { rank: number; title: string }[];
        retire: { fileName: string }[];
        renames: { from: string; to: string }[];
        desired: unknown[];
      }>(`/api/artists/${artist.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ apply: Boolean(opts.apply) }),
      });
      for (const a of r.acquire)
        console.log(`WOULD GET    ${String(a.rank).padStart(2, "0")} - ${a.title}`);
      for (const t of r.retire) console.log(`WOULD RETIRE ${t.fileName}`);
      for (const rn of r.renames) console.log(`WOULD RENAME ${rn.from} -> ${rn.to}`);
      console.log(
        `${r.applied ? "applied" : "preview only (use --apply)"}: ${r.acquire.length} acquire, ${r.retire.length} retire, ${r.renames.length} rename`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("jobs")
  .description("List background jobs (downloads, verifies)")
  .option("-s, --status <status>", "filter: pending | running | done | failed")
  .action(async (opts: { status?: string }) => {
    try {
      const q = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
      const { jobs } = await api.request<{
        jobs: {
          id: number;
          type: string;
          status: string;
          attempts: number;
          error: string | null;
          payload: Record<string, unknown>;
        }[];
      }>(`/api/jobs${q}`);
      if (jobs.length === 0) {
        console.log("no jobs");
        return;
      }
      for (const j of jobs) {
        const what = j.payload.title ? `${j.payload.title}` : JSON.stringify(j.payload);
        console.log(
          `${String(j.id).padStart(4)}  ${j.status.padEnd(8)} ${j.type.padEnd(10)} x${j.attempts}  ${what}`,
        );
        if (j.error) console.log(`      error: ${j.error}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("retry <id>")
  .description("Re-queue a failed job")
  .action(async (id: string) => {
    try {
      const r = await api.request<{ job: { id: number; status: string } }>(
        `/api/jobs/${Number(id)}/retry`,
        { method: "POST" },
      );
      console.log(`job ${r.job.id} is ${r.job.status}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("retag [name]")
  .description(
    "Re-tag acquired files with the canonical tag set (album, year, album position, disc, MBIDs, art, ReplayGain); without a name, every band",
  )
  .action(async (name?: string) => {
    try {
      let artistId: number | undefined;
      if (name) artistId = (await findArtist(name)).id;
      const r = await api.request<{ jobId: number | null }>("/api/retag", {
        method: "POST",
        body: JSON.stringify(artistId ? { artistId } : {}),
      });
      console.log(
        r.jobId === null
          ? "an identical retag is already queued (nothing to do)"
          : `retag queued as job ${r.jobId} — progress shows in 'ma jobs'`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("verify [name]")
  .description("Deep verify: plan vs disk by title, name AND content hash")
  .action(async (name?: string) => {
    try {
      let artistId: number | undefined;
      if (name) artistId = (await findArtist(name)).id;
      const { reports } = await api.request<{
        reports: {
          band: string;
          planCount: number;
          onDiskCount: number;
          ok: boolean;
          issues: {
            type: string;
            norm?: string;
            fileName?: string;
            expected?: string;
            detail?: string;
          }[];
        }[];
      }>("/api/verify", {
        method: "POST",
        body: JSON.stringify(artistId ? { artistId } : {}),
      });
      for (const r of reports) {
        console.log(
          `${r.ok ? "OK  " : "BAD "} ${r.band} (${r.planCount} planned, ${r.onDiskCount} on disk)`,
        );
        for (const i of r.issues) {
          const what = i.fileName ?? i.norm ?? "";
          console.log(
            `     ${i.type.padEnd(9)} ${what}${i.expected ? ` -> ${i.expected}` : ""}${i.detail ? ` (${i.detail})` : ""}`,
          );
        }
      }
      const bad = reports.filter((r) => !r.ok).length;
      if (bad > 0) {
        console.error(`${bad} band(s) need attention`);
        process.exitCode = 1;
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("Library + queue summary")
  .action(async () => {
    try {
      const [{ artists }, { jobs }, { reports }] = await Promise.all([
        api.request<{
          artists: { name: string; quota: number | null; planCount: number; onDiskCount: number }[];
        }>("/api/artists"),
        api.request<{ jobs: { status: string }[] }>("/api/jobs?limit=200"),
        api.request<{ reports: { ok: boolean; issues: unknown[] }[] }>("/api/verify", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      ]);
      const byStatus = (s: string) => jobs.filter((j) => j.status === s).length;
      console.log(`bands: ${artists.length}`);
      console.log(
        `tracks: ${artists.reduce((n, a) => n + a.planCount, 0)} planned, ${artists.reduce((n, a) => n + a.onDiskCount, 0)} on disk`,
      );
      console.log(
        `jobs: ${byStatus("pending")} pending, ${byStatus("running")} running, ${byStatus("done")} done, ${byStatus("failed")} failed`,
      );
      const issues = reports.reduce((n, r) => n + r.issues.length, 0);
      console.log(`verify: ${issues === 0 ? "all clean" : `${issues} issue(s) — see: ma verify`}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("candidates [status]")
  .description("List candidates (pending | approved | rejected)")
  .action(async (status?: string) => {
    try {
      const { candidates } = await api.request<{
        candidates: {
          id: number;
          type: string;
          tasteFit: number | null;
          reason: string | null;
          payload: { name?: string; title?: string };
        }[];
      }>(`/api/candidates?status=${status ?? "pending"}`);
      if (candidates.length === 0) {
        console.log(`no ${status ?? "pending"} candidates`);
        return;
      }
      for (const c of candidates) {
        const what = c.payload.name ?? c.payload.title ?? JSON.stringify(c.payload);
        console.log(
          `#${c.id} [${c.type}] fit=${c.tasteFit ?? "?"} — ${what}${c.reason ? `\n     ${c.reason}` : ""}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("approve <id> <score>")
  .description("Approve a candidate (score 1-3 is applied to related artists)")
  .action(async (id: string, score: string) => {
    try {
      const res = await api.request<{ candidate: { status: string }; trackedArtistId?: number }>(
        `/api/candidates/${id}/approve`,
        { method: "POST", body: JSON.stringify({ score: Number(score) }) },
      );
      console.log(
        `approved (now ${res.candidate.status})${res.trackedArtistId ? ` — tracked as artist #${res.trackedArtistId}` : ""}`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("reject <id>")
  .description("Reject a candidate (it will not be suggested again)")
  .action(async (id: string) => {
    try {
      await api.request(`/api/candidates/${id}/reject`, { method: "POST", body: "{}" });
      console.log(`rejected #${id}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("digest")
  .description("Print the digest: candidates pending, new releases, library vs budgets")
  .action(async () => {
    try {
      const digest = await api.request<{ markdown: string }>("/api/digest");
      console.log(digest.markdown);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("scrobbles")
  .description("Scrobble stats + sync")
  .argument("[action]", "sync (default: stats)", "stats")
  .option("--full", "re-import the entire history")
  .action(async (action: string, opts: { full?: boolean }) => {
    try {
      if (action === "sync") {
        const res = await api.request<{ full: boolean }>("/api/scrobbles/sync", {
          method: "POST",
          body: JSON.stringify({ full: opts.full === true }),
        });
        console.log(`scrobble_sync job enqueued (full=${res.full}) — watch: ma jobs`);
        return;
      }
      const stats = await api.request<{
        total: number;
        lastPlayedAt: string | null;
        topArtists: { artistName: string; plays: number }[];
      }>("/api/scrobbles");
      console.log(`scrobbles: ${stats.total} (last: ${stats.lastPlayedAt ?? "never"})`);
      for (const a of stats.topArtists.slice(0, 10)) {
        console.log(`  ${String(a.plays).padStart(5)}  ${a.artistName}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("trends <action>")
  .description("Run discovery or the release radar (as a background job)")
  .action(async (action: string) => {
    try {
      const path = action === "radar" ? "/api/trends/release-radar" : "/api/trends/discover";
      await api.request(path, { method: "POST", body: "{}" });
      console.log(
        `${action === "radar" ? "release_radar" : "discovery"} job enqueued — watch: ma jobs`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("taste")
  .description("Show the taste profile (top bands, genres, eras)")
  .action(async () => {
    try {
      const { profile } = await api.request<{
        profile: {
          bandAffinity: Record<string, number>;
          genreWeights: Record<string, number>;
          eraWeights: Record<string, number>;
        };
      }>("/api/taste");
      const top = (m: Record<string, number>) =>
        Object.entries(m)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([k, v]) => `  ${(v * 100).toFixed(0).padStart(3)}%  ${k}`)
          .join("\n");
      console.log(`bands:\n${top(profile.bandAffinity) || "  (none yet)"}`);
      console.log(`genres:\n${top(profile.genreWeights) || "  (none yet)"}`);
      console.log(`eras:\n${top(profile.eraWeights) || "  (none yet)"}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("policy")
  .description("Policy state: approval mode, budgets, genre shares")
  .action(async () => {
    try {
      const state = await api.request<{
        policy: Record<string, unknown>;
        budget: {
          allowed: boolean;
          overBudget: boolean;
          gates: { name: string; pass: boolean; detail: string }[];
        };
        genreShares: Record<string, number>;
      }>("/api/policy");
      const p = state.policy;
      console.log(
        `mode: ${p.approvalMode} (taste-fit threshold ${p.tasteFitThreshold}, hybrid at ${p.autoApproveFit})`,
      );
      console.log(
        `caps: band ${p.bandHardMaxTracks} planned · genre soft ${(Number(p.genreSoftCapShare) * 100).toFixed(0)}% · library ${p.maxTotalTracks} tracks / ${p.maxTotalGb} GB`,
      );
      console.log(
        `monthly target: ${p.monthlyAcquisitionBudgetTracks} tracks (soft — overflow allowed)`,
      );
      for (const g of state.budget.gates) {
        console.log(`  ${g.pass ? "✓" : "✗"} ${g.name}: ${g.detail}`);
      }
      if (state.budget.overBudget) console.log("  ! monthly target exceeded (allowed by policy)");
      const genres = Object.entries(state.genreShares)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (genres.length > 0) {
        console.log("genres:");
        for (const [tag, share] of genres) {
          console.log(`  ${(share * 100).toFixed(0).padStart(3)}%  ${tag}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("prune [action]")
  .description("Prune report (default) or apply — retire decayed tracks to _retired/")
  .argument("[action]", "report | apply", "report")
  .option("--norm <norm...>", "apply only these tracks")
  .action(async (action: string, opts: { norm?: string[] }) => {
    try {
      if (action === "apply") {
        const res = await api.request<{
          retired: { artist: string; fileName: string }[];
          skipped: string[];
        }>("/api/policy/prune/apply", {
          method: "POST",
          body: JSON.stringify({ norms: opts.norm }),
        });
        console.log(`retired ${res.retired.length} track(s) to _retired/ (recoverable)`);
        for (const r of res.retired) console.log(`  ${r.artist}/${r.fileName}`);
        if (res.skipped.length > 0)
          console.log(`skipped (no file found): ${res.skipped.join(", ")}`);
        return;
      }
      const report = await api.request<{
        summary: string;
        autoPruneEnabled: boolean;
        proposals: {
          norm: string;
          title: string;
          artistName: string;
          reason: string;
          priority: number;
        }[];
      }>("/api/policy/prune-report");
      console.log(report.summary);
      if (report.autoPruneEnabled)
        console.log("(auto-prune is ON — the weekly scan retires these automatically)");
      for (const p of report.proposals) {
        console.log(`  [${p.priority}] ${p.artistName} — ${p.title}: ${p.reason}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("simulate <scores>")
  .description("Policy simulator, e.g. ma simulate '{\"Terror\": 3}'")
  .option("--max-tracks <n>", "also simulate a lower/higher global track budget")
  .option("--budget <n>", "also simulate a different monthly target")
  .action(async (scores: string, opts: { maxTracks?: string; budget?: string }) => {
    try {
      const policyPatch: Record<string, unknown> = {};
      if (opts.maxTracks) policyPatch.maxTotalTracks = Number(opts.maxTracks);
      if (opts.budget) policyPatch.monthlyAcquisitionBudgetTracks = Number(opts.budget);
      const sim = await api.request<{
        changes: {
          artist: string;
          scoreBefore: number;
          scoreAfter: number;
          quotaBefore: number;
          quotaAfter: number;
          deltaTracks: number;
        }[];
        summary: string;
      }>("/api/policy/simulate", {
        method: "POST",
        body: JSON.stringify({ scoreChanges: JSON.parse(scores), policyPatch }),
      });
      for (const c of sim.changes) {
        console.log(
          `${c.artist}: score ${c.scoreBefore}→${c.scoreAfter} ⇒ quota ${c.quotaBefore}→${c.quotaAfter} (${c.deltaTracks >= 0 ? "+" : ""}${c.deltaTracks})`,
        );
      }
      console.log(sim.summary);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("migrate")
  .description("One-shot import of legacy bands.csv (and optionally plan.csv)")
  .requiredOption("--bands <path>", "path to the legacy bands.csv")
  .option("--plan <path>", "path to the legacy plan.csv (omit for a bands-only import)")
  .action(async (opts: { bands: string; plan?: string }) => {
    try {
      const { readFileSync } = await import("node:fs");
      const queued = await api.request<{ jobId: number | null }>("/api/migrate", {
        method: "POST",
        body: JSON.stringify({
          bandsCsv: readFileSync(opts.bands, "utf8"),
          planCsv: opts.plan ? readFileSync(opts.plan, "utf8") : undefined,
        }),
      });
      console.log(
        queued.jobId === null
          ? "an identical migration is already queued — waiting for it"
          : `queued migration job ${queued.jobId}`,
      );

      // Wait for the worker to finish the import.
      for (let i = 0; i < 600; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const { jobs } = await api.request<{ jobs: { type: string; status: string }[] }>(
          "/api/jobs",
        );
        if (
          !jobs.some((j) => j.type === "migrate" && j.status !== "done" && j.status !== "failed")
        ) {
          break;
        }
      }

      const { report } = await api.request<{
        report: {
          summary: string;
          bands: {
            imported: number;
            skipped: string[];
            quotaDiffs: {
              band: string;
              legacyQuota: number | null;
              computedQuota: number | null;
            }[];
          };
          plan: {
            imported: number;
            alreadyImported: number;
            owned: number;
            planned: number;
            pinned: number;
          };
          files: { matched: number; unmatched: string[]; unknownBandDirs: string[] };
          problems: string[];
        } | null;
      }>("/api/migrate/report");
      if (!report) {
        console.log("no migration report yet — is the server worker running?");
        return;
      }
      console.log(report.summary);
      console.log(
        `plan: ${report.plan.owned} owned, ${report.plan.planned} planned, ${report.plan.pinned} pinned` +
          (report.plan.alreadyImported > 0
            ? `, ${report.plan.alreadyImported} already imported`
            : ""),
      );
      for (const d of report.bands.quotaDiffs) {
        console.log(
          `quota mismatch: ${d.band} legacy ${d.legacyQuota} vs computed ${d.computedQuota}`,
        );
      }
      for (const f of report.files.unmatched) console.log(`unmatched file (left in place): ${f}`);
      for (const p of report.problems) console.log(`note: ${p}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("api")
  .description("List the REST API endpoints (see /doc for full schemas)")
  .action(async () => {
    try {
      const doc = await api.request<{
        paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
      }>("/doc");
      for (const [path, methods] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          console.log(`${method.toUpperCase().padEnd(6)} ${path}  ${op.summary ?? ""}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
