/**
 * Legacy state import (PLAN.md §6 Phase 7 migration strategy) — pure parsing
 * and matching for the PowerShell tool's `bands.csv` / `plan.csv` state.
 * Rule of the migration: report everything that can't be mapped, never guess.
 * The server wires these into the migrate service/job; no I/O lives here.
 */

import { DEFAULT_QUOTA_FORMULA, getQuota, type QuotaFormula } from "./formula.js";
import { splitFileName } from "./plan.js";
import { normTitle } from "./text.js";
import type { ScoreTier } from "./types.js";

// ------------------------------------------------------------ CSV parsing

/**
 * Minimal RFC 4180 parser: quoted fields, commas and newlines inside quotes,
 * doubled quotes as escapes. Returns rows of fields (header included if the
 * caller passes the raw text).
 */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/**
 * Repairs legacy mojibake: UTF-8 bytes that were written through a latin-1
 * channel ("singerâ€”songwriter" for "singer—songwriter"). Returns the input
 * untouched when no repair is possible, so callers can flag suspicious text.
 */
export function recoverText(s: string): string {
  if (!/[âÃ]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Only accept the repair when it actually differs and looks sane.
    return decoded !== s ? decoded : s;
  } catch {
    return s;
  }
}

const num = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};

const score = (s: string): ScoreTier | null => {
  const n = num(s);
  return n === 1 || n === 2 || n === 3 ? n : null;
};

// ------------------------------------------------------------ bands.csv

export type LegacyBandRow = {
  band: string;
  score: ScoreTier;
  mbid: string | null;
  studioAlbums: number | null;
  catalog: number | null;
  /** Quota as computed by the legacy tool — used as a checksum only. */
  legacyQuota: number | null;
  disambig: string | null;
};

export type ParseResult<T> = { rows: T[]; problems: string[] };

/** bands.csv: Band, Score, MBID, StudioAlbums, Catalog, Quota, Disambig */
export function parseBandsCsv(text: string): ParseResult<LegacyBandRow> {
  const rows: LegacyBandRow[] = [];
  const problems: string[] = [];
  const [, ...data] = csvRows(text);

  for (const fields of data) {
    const [bandRaw, scoreRaw, mbid, studioAlbums, catalog, quota, disambig] = fields;
    const band = recoverText(bandRaw ?? "").trim();
    const parsedScore = score(scoreRaw ?? "");
    if (!band || !parsedScore) {
      problems.push(`unparsed bands.csv row: ${fields.join(",")}`);
      continue;
    }
    rows.push({
      band,
      score: parsedScore,
      mbid: (mbid ?? "").trim() || null,
      studioAlbums: num(studioAlbums ?? ""),
      catalog: num(catalog ?? ""),
      legacyQuota: num(quota ?? ""),
      disambig: recoverText(disambig ?? "").trim() || null,
    });
  }
  return { rows, problems };
}

// ------------------------------------------------------------ plan.csv

export type LegacyPlanRow = {
  band: string;
  score: ScoreTier;
  rank: number;
  title: string;
  /** The legacy Norm-Title value — kept verbatim (golden normalization). */
  norm: string;
  status: string;
  pinned: boolean;
};

/** plan.csv: Band, Score, Rank, Title, Norm, Status, Source, Ext, Pinned */
export function parsePlanCsv(text: string): ParseResult<LegacyPlanRow> {
  const rows: LegacyPlanRow[] = [];
  const problems: string[] = [];
  const [, ...data] = csvRows(text);

  for (const fields of data) {
    const [bandRaw, scoreRaw, rankRaw, titleRaw, normRaw, statusRaw, , , pinnedRaw] = fields;
    const band = recoverText(bandRaw ?? "").trim();
    const parsedScore = score(scoreRaw ?? "");
    const rank = num(rankRaw ?? "");
    const title = recoverText(titleRaw ?? "").trim();
    const norm = (normRaw ?? "").trim();
    if (!band || !parsedScore || !rank || !title || !norm) {
      problems.push(`unparsed plan.csv row: ${fields.join(",")}`);
      continue;
    }
    rows.push({
      band,
      score: parsedScore,
      rank,
      title,
      norm,
      status: (statusRaw ?? "").trim().toUpperCase(),
      pinned: (pinnedRaw ?? "").trim().toLowerCase() === "true",
    });
  }
  return { rows, problems };
}

// -------------------------------------------------------- status mapping

export type TrackStatus = "OWNED" | "PLANNED";

/**
 * Legacy statuses are stale (OWNED was kept even after files vanished), so
 * reality wins: a row is OWNED only when its file is actually on disk. The
 * legacy status is an input for reporting, not for the decision.
 */
export function mapLegacyStatus(_status: string, fileFound: boolean): TrackStatus {
  return fileFound ? "OWNED" : "PLANNED";
}

// ------------------------------------------------------- quota checksum

export type QuotaCheck = {
  band: string;
  catalog: number | null;
  legacyQuota: number | null;
  computedQuota: number | null;
  ok: boolean;
};

/**
 * Recomputes each band's quota with the pinned formula and flags differences
 * against the legacy Quota column — a live parity check on real state.
 */
export function quotaChecksum(
  bands: LegacyBandRow[],
  formula: QuotaFormula = DEFAULT_QUOTA_FORMULA,
): QuotaCheck[] {
  return bands.map((b) => {
    const computedQuota =
      b.catalog !== null && b.catalog > 0 ? getQuota(b.score, b.catalog, formula) : null;
    return {
      band: b.band,
      catalog: b.catalog,
      legacyQuota: b.legacyQuota,
      computedQuota,
      ok: b.legacyQuota === null || computedQuota === null || computedQuota === b.legacyQuota,
    };
  });
}

// ------------------------------------------------------ file matching

/** "<NN> - Title.ext" (or "Title.ext") on disk -> the plan's norm title. */
export function normFromFileName(fileName: string): string {
  const { base } = splitFileName(fileName);
  const titlePart = base.replace(/^\d+\s*-\s*/, "");
  return normTitle(titlePart);
}

export type FileMatch<T> = T & { fileName: string };

/**
 * Matches collection files to plan rows by norm title (rank prefix stripped).
 * Every file matches at most one row and vice versa; leftovers are reported,
 * never guessed.
 */
export function matchFiles<T extends { norm: string; rank: number }>(
  rows: T[],
  files: { fileName: string }[],
): {
  matched: FileMatch<T>[];
  unmatchedRows: T[];
  unmatchedFiles: string[];
} {
  const byNorm = new Map<string, T[]>();
  for (const row of rows) {
    const list = byNorm.get(row.norm) ?? [];
    list.push(row);
    byNorm.set(row.norm, list);
  }

  const matched: FileMatch<T>[] = [];
  const used = new Set<string>();
  const unmatchedFiles: string[] = [];

  for (const file of files) {
    const norm = normFromFileName(file.fileName);
    const candidates = byNorm.get(norm);
    const row = candidates?.find((c) => !used.has(`${c.norm}#${c.rank}`));
    if (!row) {
      unmatchedFiles.push(file.fileName);
      continue;
    }
    used.add(`${row.norm}#${row.rank}`);
    matched.push({ ...row, fileName: file.fileName });
  }

  const unmatchedRows = rows.filter((r) => !used.has(`${r.norm}#${r.rank}`));
  return { matched, unmatchedRows, unmatchedFiles };
}
