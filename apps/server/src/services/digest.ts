import { count, eq, sql, sum } from "drizzle-orm";
import { getSetting, listCandidates } from "../db/repositories.js";
import { jobs, planItems, tracks } from "../db/schema.js";
import { DEFAULT_POLICY, type PolicySettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";

/**
 * Weekly digest (PLAN.md §4.3): one line answering "what needs my attention,
 * and how full is the library?" — rendered on the dashboard and as markdown.
 */

export type Digest = {
  generatedAt: string;
  pendingCandidates: number;
  newReleases: number;
  relatedArtists: number;
  library: {
    ownedTracks: number;
    maxTotalTracks: number;
    trackPct: number;
    bytesUsed: number;
    maxTotalGb: number;
    sizePct: number;
  };
  acquisition: { acquiredThisMonth: number; monthlyBudgetTracks: number };
  jobs: { pending: number; running: number; failed: number };
  headline: string;
  markdown: string;
};

export function buildDigest(deps: AppDeps): Digest {
  const db = deps.db;
  const policy = getSetting<PolicySettings>(db, "policy") ?? DEFAULT_POLICY;

  const pending = listCandidates(db, { status: "pending" });
  const newReleases = pending.filter((c) => c.type === "new_release").length;
  const relatedArtists = pending.filter((c) => c.type === "related").length;

  const owned =
    db.select({ n: count() }).from(tracks).where(eq(tracks.status, "OWNED")).get()?.n ?? 0;
  const planned = db.select({ n: count() }).from(planItems).get()?.n ?? 0;
  const bytes = Number(
    db
      .select({ n: sum(tracks.sizeBytes) })
      .from(tracks)
      .get()?.n ?? 0,
  );
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const acquiredThisMonth =
    db
      .select({ n: count() })
      .from(tracks)
      .where(sql`${tracks.acquiredAt} LIKE ${`${monthPrefix}%`}`)
      .get()?.n ?? 0;

  const jobCounts: Record<string, number> = {};
  for (const row of db
    .select({ status: jobs.status, n: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .all()) {
    jobCounts[row.status] = row.n;
  }

  const trackPct =
    policy.maxTotalTracks > 0
      ? Math.min(100, Math.round((owned / policy.maxTotalTracks) * 100))
      : 0;
  const maxBytes = policy.maxTotalGb * 1024 ** 3;
  const sizePct = maxBytes > 0 ? Math.min(100, Math.round((bytes / maxBytes) * 100)) : 0;

  const headline =
    `${pending.length} candidate${pending.length === 1 ? "" : "s"}` +
    ` (${newReleases} new release${newReleases === 1 ? "" : "s"}, ` +
    `${relatedArtists} related artist${relatedArtists === 1 ? "" : "s"}), ` +
    `library at ${trackPct}% of track budget`;

  const markdown = [
    `## Music Assistant digest`,
    ``,
    `- **${headline}**`,
    `- Library: ${owned}/${policy.maxTotalTracks} tracks owned (${planned} planned), ` +
      `${(bytes / 1024 ** 3).toFixed(1)}/${policy.maxTotalGb} GB (${sizePct}%)`,
    `- This month: ${acquiredThisMonth}/${policy.monthlyAcquisitionBudgetTracks} acquisitions`,
    `- Jobs: ${jobCounts.pending ?? 0} pending, ${jobCounts.running ?? 0} running, ${jobCounts.failed ?? 0} failed`,
  ].join("\n");

  return {
    generatedAt: new Date().toISOString(),
    pendingCandidates: pending.length,
    newReleases,
    relatedArtists,
    library: {
      ownedTracks: owned,
      maxTotalTracks: policy.maxTotalTracks,
      trackPct,
      bytesUsed: bytes,
      maxTotalGb: policy.maxTotalGb,
      sizePct,
    },
    acquisition: {
      acquiredThisMonth,
      monthlyBudgetTracks: policy.monthlyAcquisitionBudgetTracks,
    },
    jobs: {
      pending: jobCounts.pending ?? 0,
      running: jobCounts.running ?? 0,
      failed: jobCounts.failed ?? 0,
    },
    headline,
    markdown,
  };
}
