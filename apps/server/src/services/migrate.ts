import { join } from "node:path";
import {
  DEFAULT_QUOTA_FORMULA,
  type LegacyPlanRow,
  mapLegacyStatus,
  matchFiles,
  parseBandsCsv,
  parsePlanCsv,
  type QuotaCheck,
  type QuotaFormula,
  quotaChecksum,
  safeName,
} from "@ma/core";
import { hashFile } from "@ma/integrations";
import {
  getPlanRowByNorm,
  getSetting,
  insertArtist,
  insertPlanRow,
  listArtists,
  upsertTrack,
} from "../db/repositories.js";
import { events } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { logEvent } from "./events.js";

/**
 * Legacy state migration (PLAN.md §6 Phase 7): one-shot import of the
 * PowerShell tool's `bands.csv` + `plan.csv` against the app's configured
 * collection. Every file is matched by norm title (legacy Norm kept verbatim);
 * anything unmappable is reported — never guessed. The collection is only read.
 */

export type MigrateInput = {
  bandsCsv: string;
  planCsv: string;
};

export type MigrateReport = {
  startedAt: string;
  finishedAt: string;
  bands: {
    imported: number;
    /** Already present (by name or mbid) — left untouched. */
    skipped: string[];
    /** Legacy Quota column vs our pinned formula — a live parity check. */
    quotaDiffs: { band: string; legacyQuota: number | null; computedQuota: number | null }[];
  };
  plan: {
    imported: number;
    /** Rows already present from a previous run — left untouched. */
    alreadyImported: number;
    owned: number;
    planned: number;
    pinned: number;
  };
  files: {
    matched: number;
    /** Files in the collection matching no plan row — left in place. */
    unmatched: string[];
    /** Collection folders with no bands.csv row. */
    unknownBandDirs: string[];
  };
  problems: string[];
  summary: string;
};

const MAX_LIST = 200;

export async function runMigration(deps: AppDeps, input: MigrateInput): Promise<MigrateReport> {
  const startedAt = new Date().toISOString();
  const formula = getSetting<QuotaFormula>(deps.db, "formula") ?? DEFAULT_QUOTA_FORMULA;
  const problems: string[] = [];

  // ------------------------------------------------------------- bands.csv
  const bandsParsed = parseBandsCsv(input.bandsCsv);
  problems.push(...bandsParsed.problems);

  const existing = listArtists(deps.db);
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));
  const byMbid = new Map(existing.map((a) => [a.mbid, a]));

  const quotaChecks: QuotaCheck[] = quotaChecksum(bandsParsed.rows, formula);
  let imported = 0;
  const skipped: string[] = [];
  for (const row of bandsParsed.rows) {
    if (byName.has(row.band.toLowerCase()) || (row.mbid && byMbid.has(row.mbid))) {
      skipped.push(row.band);
      continue;
    }
    if (!row.mbid) {
      problems.push(`no MBID for band '${row.band}' — skipped (identity needs an MBID)`);
      continue;
    }
    const check = quotaChecks.find((c) => c.band === row.band);
    insertArtist(deps.db, {
      mbid: row.mbid,
      name: row.band,
      disambig: row.disambig,
      score: row.score,
      catalogSize: row.catalog,
      quota: check?.computedQuota ?? null,
    });
    imported += 1;
  }

  const quotaDiffs = quotaChecks
    .filter((c) => !c.ok)
    .map((c) => ({ band: c.band, legacyQuota: c.legacyQuota, computedQuota: c.computedQuota }));
  for (const diff of quotaDiffs) {
    problems.push(
      `quota mismatch for '${diff.band}': legacy ${diff.legacyQuota}, computed ${diff.computedQuota}`,
    );
  }

  // ------------------------------------------------------------- plan.csv
  const planParsed = parsePlanCsv(input.planCsv);
  problems.push(...planParsed.problems);

  // Unique (artist, norm) is a schema rule — keep the first row, report the rest.
  const seen = new Set<string>();
  const planRows: LegacyPlanRow[] = [];
  for (const row of planParsed.rows) {
    const key = `${row.band.toLowerCase()}\u0000${row.norm}`;
    if (seen.has(key)) {
      problems.push(`duplicate plan row for '${row.band}' / '${row.norm}' — kept first`);
      continue;
    }
    seen.add(key);
    planRows.push(row);
  }

  // Files by normalized folder name so legacy folder quirks still resolve.
  const filesByBand = new Map<string, { fileName: string }[]>();
  for (const dir of deps.collection.listBandNames()) {
    filesByBand.set(safeName(dir), deps.collection.listBandFiles(dir));
  }
  const artistsNow = new Map(listArtists(deps.db).map((a) => [a.name.toLowerCase(), a]));

  const matchedNorms = new Set<string>();
  let planImported = 0;
  let alreadyImported = 0;
  let owned = 0;
  let planned = 0;
  let pinned = 0;

  const byBand = new Map<string, typeof planRows>();
  for (const row of planRows) {
    const list = byBand.get(row.band) ?? [];
    list.push(row);
    byBand.set(row.band, list);
  }

  for (const [band, rows] of byBand) {
    const artist = artistsNow.get(band.toLowerCase());
    if (!artist) {
      problems.push(
        `plan rows for '${band}' have no bands.csv entry — ${rows.length} row(s) skipped`,
      );
      continue;
    }
    const files = filesByBand.get(safeName(band)) ?? [];
    const { matched, unmatchedRows, unmatchedFiles } = matchFiles(rows, files);

    for (const row of matched) {
      matchedNorms.add(`${safeName(band)}\u0000${row.fileName}`);
      if (getPlanRowByNorm(deps.db, artist.id, row.norm)) {
        alreadyImported += 1;
        continue;
      }
      const abs = join(deps.collection.bandDir(band), row.fileName);
      const { hash, sizeBytes, mtime } = await hashFile(abs);
      const status = mapLegacyStatus(row.status, true);
      upsertTrack(deps.db, {
        artistId: artist.id,
        title: row.title,
        norm: row.norm,
        rank: row.rank,
        pinned: row.pinned,
        status,
        filePath: abs,
        ext: splitExt(row.fileName),
        durationS: null,
        hash,
        sizeBytes,
        // The file's mtime is when it entered the collection — keeps the
        // monthly budget honest and the decay clock realistic for imports.
        acquiredAt: mtime,
      });
      insertPlanRow(deps.db, {
        artistId: artist.id,
        title: row.title,
        norm: row.norm,
        rank: row.rank,
        pinned: row.pinned,
        source: "migrated",
        status,
      });
      owned += 1;
      if (row.pinned) pinned += 1;
      planImported += 1;
    }

    for (const row of unmatchedRows) {
      if (getPlanRowByNorm(deps.db, artist.id, row.norm)) {
        alreadyImported += 1;
        continue;
      }
      // No file on disk: imported as PLANNED so the normal sync can acquire it.
      insertPlanRow(deps.db, {
        artistId: artist.id,
        title: row.title,
        norm: row.norm,
        rank: row.rank,
        pinned: row.pinned,
        source: "migrated",
        status: mapLegacyStatus(row.status, false),
      });
      planned += 1;
      if (row.pinned) pinned += 1;
      planImported += 1;
    }

    if (unmatchedFiles.length > 0) {
      problems.push(
        `${unmatchedFiles.length} file(s) in '${band}' match no plan row — left in place`,
      );
    }
  }

  // Files matching nothing at all — reported, left untouched (owner's rule).
  const unmatched: string[] = [];
  const knownFolders = new Set([...byBand.keys()].map((b) => safeName(b)));
  const unknownBandDirs: string[] = [];
  for (const [folder, files] of filesByBand) {
    if (!knownFolders.has(folder)) unknownBandDirs.push(folder);
    for (const f of files) {
      if (!matchedNorms.has(`${folder}\u0000${f.fileName}`)) {
        unmatched.push(`${folder}/${f.fileName}`);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const report: MigrateReport = {
    startedAt,
    finishedAt,
    bands: {
      imported,
      skipped: skipped.slice(0, MAX_LIST),
      quotaDiffs: quotaDiffs.slice(0, MAX_LIST),
    },
    plan: { imported: planImported, alreadyImported, owned, planned, pinned },
    files: {
      matched: owned,
      unmatched: unmatched.slice(0, MAX_LIST),
      unknownBandDirs: unknownBandDirs.slice(0, MAX_LIST),
    },
    problems: problems.slice(0, MAX_LIST),
    summary:
      `imported ${imported} band(s) and ${planImported} plan row(s) ` +
      `(${owned} owned, ${planned} planned, ${pinned} pinned); ` +
      `${quotaDiffs.length} quota mismatch(es), ${unmatched.length} unmatched file(s), ` +
      `${problems.length} note(s)`,
  };

  logEvent(deps, "migrate_completed", {
    ...report,
    skippedCount: skipped.length,
    unmatchedCount: unmatched.length,
    problemsCount: problems.length,
  });
  return report;
}

function splitExt(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx > 0 ? fileName.slice(idx) : "";
}

/** Latest migration report, for the wizard, CLI and curious operators. */
export function latestMigrateReport(deps: AppDeps): MigrateReport | null {
  const row = deps.db
    .select()
    .from(events)
    .all()
    .filter((e) => e.kind === "migrate_completed")
    .sort((a, b) => b.id - a.id)[0];
  return row ? (JSON.parse(row.payloadJson) as MigrateReport) : null;
}
