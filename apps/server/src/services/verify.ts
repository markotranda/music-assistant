import { join } from "node:path";
import { type DesiredTrack, indexOnDisk, splitFileName, targetFileName } from "@ma/core";
import { probeAudio } from "@ma/integrations";
import { getArtistById, getTrackByNorm, listArtists, listPlanRows } from "../db/repositories.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";

/**
 * Deep verify (PLAN.md §4.5 `verify`): compares plan vs disk by normalized
 * title AND file name AND content hash — not just row counts like the legacy
 * tool, which let renamed/replaced files pass undetected.
 */

export type VerifyIssue = {
  type: "missing" | "surplus" | "renamed" | "replaced" | "corrupt";
  norm?: string;
  fileName?: string;
  expected?: string;
  detail?: string;
};

export type BandVerifyReport = {
  artistId: number;
  band: string;
  planCount: number;
  onDiskCount: number;
  ok: boolean;
  issues: VerifyIssue[];
};

export async function verifyBand(deps: AppDeps, artistId: number): Promise<BandVerifyReport> {
  const artist = getArtistById(deps.db, artistId);
  if (!artist) throw new ApiError(404, `artist ${artistId} not found`);

  const planRows = listPlanRows(deps.db, artistId);
  const onDisk = indexOnDisk(deps.collection.listBandFiles(artist.name));
  const bandDir = deps.collection.bandDir(artist.name);
  const issues: VerifyIssue[] = [];
  const byNorm = new Map(onDisk.map((f) => [f.norm, f]));

  for (const row of planRows) {
    const expected = targetFileName(
      { rank: row.rank, title: row.title, norm: row.normTitle, pinned: row.pinned } as DesiredTrack,
      ".mp3",
    );
    const file = byNorm.get(row.normTitle);
    if (!file) {
      issues.push({ type: "missing", norm: row.normTitle, expected });
      continue;
    }

    const { base, extension } = splitFileName(file.fileName);
    const expectedBase = splitFileName(expected).base;
    if (base !== expectedBase) {
      issues.push({
        type: "renamed",
        norm: row.normTitle,
        fileName: file.fileName,
        expected: `${expectedBase}${extension}`,
      });
    }

    const probe = await probeAudio(join(bandDir, file.fileName));
    if (!probe) {
      issues.push({
        type: "corrupt",
        norm: row.normTitle,
        fileName: file.fileName,
        detail: "file is empty or has no recognizable audio stream",
      });
      continue;
    }

    const track = getTrackByNorm(deps.db, artistId, row.normTitle);
    if (track?.hash && track.hash !== probe.hash) {
      issues.push({
        type: "replaced",
        norm: row.normTitle,
        fileName: file.fileName,
        detail: `content hash changed (${track.hash.slice(0, 12)} -> ${probe.hash.slice(0, 12)})`,
      });
    }
  }

  const planned = new Set(planRows.map((r) => r.normTitle));
  for (const f of onDisk) {
    if (!planned.has(f.norm)) {
      issues.push({ type: "surplus", norm: f.norm, fileName: f.fileName });
    }
  }

  return {
    artistId,
    band: artist.name,
    planCount: planRows.length,
    onDiskCount: onDisk.length,
    ok: issues.length === 0,
    issues,
  };
}

export async function verifyAll(deps: AppDeps): Promise<BandVerifyReport[]> {
  const reports: BandVerifyReport[] = [];
  for (const artist of listArtists(deps.db)) {
    reports.push(await verifyBand(deps, artist.id));
  }
  return reports;
}
