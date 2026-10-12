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
  .command("sync <name>")
  .description("Preview (default) or apply the desired-state plan")
  .option("--apply", "apply the plan (rename/retire/queue downloads)")
  .action(async (name: string, opts: { apply?: boolean }) => {
    try {
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

program.parseAsync();
