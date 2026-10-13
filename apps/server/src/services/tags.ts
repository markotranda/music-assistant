import { join } from "node:path";
import { indexOnDisk, type Placement } from "@ma/core";
import {
  type AudioProbe,
  type Cover,
  measureLoudness,
  probeAudio,
  retagFile,
} from "@ma/integrations";
import {
  type ArtistRow,
  getArtistById,
  getPlacement,
  getTrackByNorm,
  listArtists,
  listPlanRows,
  replacePlacements,
  setPlacementsSynced,
  upsertTrack,
} from "../db/repositories.js";
import type { AcquisitionSettings } from "../db/seed.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { readAcquisition } from "./settings.js";

/**
 * Canonical tagging service (PLAN.md §4.2): resolve where a song sits in the
 * artist's studio discography and write the full legacy tag set onto acquired
 * files — album, year, album position, disc, MusicBrainz ids, cover art and
 * ReplayGain. Placement resolution is cached per artist (one MusicBrainz walk
 * per band, ever) so weekly passes and re-plans cost nothing.
 */

export type RetagSummary = {
  bands: number;
  files: number;
  retagged: number;
  art: number;
  replayGain: number;
  errors: { file: string; error: string }[];
};

function ffmpegBin(): string {
  const dir = process.env.MA_FFMPEG_DIR;
  if (!dir) return "ffmpeg";
  return join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

/**
 * Where this title sits in the artist's discography, from the placement cache.
 * On a cache miss the studio-album walk runs once (and is then cached even for
 * titles that have no placement). Throws on integration failure — the callers
 * treat album metadata as cosmetic and report the miss instead of failing.
 */
export async function placementFor(
  deps: AppDeps,
  artist: ArtistRow,
  normTitle: string,
): Promise<Placement | null> {
  const cached = getPlacement(deps.db, artist.id, normTitle);
  if (cached) {
    return {
      normTitle: cached.normTitle,
      album: cached.album,
      year: cached.year,
      trackNo: cached.trackNo,
      discNo: cached.discNo,
      trackTotal: cached.trackTotal,
      recordingMbid: cached.recordingMbid,
      releaseGroupMbid: cached.releaseGroupMbid ?? "",
    };
  }
  if (artist.placementsSyncedAt) return null; // the walk already covered this title

  const placements = await deps.musicbrainz.syncPlacements(artist.mbid);
  replacePlacements(deps.db, artist.id, placements);
  setPlacementsSynced(deps.db, artist.id, new Date().toISOString());
  return placements.find((p) => p.normTitle === normTitle) ?? null;
}

export type TagWriteResult = {
  probe: AudioProbe | null;
  art: boolean;
  replayGain: boolean;
  /** Read-back mismatch ("field=value"), or null when the tags stuck. */
  mismatch: string | null;
};

/**
 * Write the canonical tag set onto one acquired file and prove it stuck.
 * Album placement is the fact; the collection rank only fills the track
 * number when no placement is known (the rank itself lives in the file name).
 */
export async function writeCanonicalTags(
  deps: AppDeps,
  filePath: string,
  artist: ArtistRow,
  track: { title: string; rank: number },
  placement: Placement | null,
  acq: AcquisitionSettings,
  coverMemo: Map<string, Cover | null> = new Map(),
): Promise<TagWriteResult> {
  const loudness = acq.replayGain
    ? await measureLoudness(filePath, { ffmpegBin: ffmpegBin() })
    : null;

  let cover: Cover | null = null;
  const rgid = placement?.releaseGroupMbid;
  if (acq.embedArt && rgid) {
    cover = coverMemo.get(rgid) ?? null;
    if (!coverMemo.has(rgid)) {
      cover = await deps.coverart.front(rgid);
      coverMemo.set(rgid, cover);
    }
  }

  const trackNumber = placement?.trackNo ?? (track.rank > 0 ? track.rank : undefined);
  retagFile(
    filePath,
    {
      artist: artist.name,
      title: track.title,
      albumArtist: artist.name,
      album: placement?.album,
      year: placement?.year ?? undefined,
      trackNumber,
      trackTotal: placement?.trackTotal ?? undefined,
      discNumber: placement?.discNo ?? undefined,
      mbids: {
        artist: artist.mbid,
        albumArtist: artist.mbid,
        releaseGroup: rgid || undefined,
        recording: placement?.recordingMbid ?? undefined,
      },
    },
    { cover: cover ? () => cover : undefined },
  );

  const probe = await probeAudio(filePath);
  return {
    probe,
    art: cover !== null,
    replayGain: loudness !== null,
    mismatch: probe ? mismatchOf(probe, artist, track.title, placement) : "file unreadable/corrupt",
  };
}

function mismatchOf(
  probe: AudioProbe,
  artist: ArtistRow,
  title: string,
  placement: Placement | null,
): string | null {
  if (probe.title !== title) return `title=${JSON.stringify(probe.title)}`;
  if (probe.artist !== artist.name) return `artist=${JSON.stringify(probe.artist)}`;
  if (probe.albumArtist !== artist.name) return `albumArtist=${JSON.stringify(probe.albumArtist)}`;
  if (placement && probe.album !== placement.album) {
    return `album=${JSON.stringify(probe.album)} expected=${JSON.stringify(placement.album)}`;
  }
  return null;
}

/**
 * Re-tag every acquired file of one band (or all bands) with the canonical
 * tag set — the fix-up path for files downloaded before the album metadata
 * landed. Per-file problems are collected, never swallowed, and never stop
 * the rest of the run.
 */
export async function retagBands(
  deps: AppDeps,
  opts: { artistId?: number } = {},
): Promise<RetagSummary> {
  const artists = opts.artistId
    ? [getArtistById(deps.db, opts.artistId)].filter((a): a is ArtistRow => Boolean(a))
    : listArtists(deps.db);
  if (opts.artistId && artists.length === 0) {
    throw new ApiError(404, `artist ${opts.artistId} not found`);
  }

  const acq = readAcquisition(deps);
  const summary: RetagSummary = {
    bands: 0,
    files: 0,
    retagged: 0,
    art: 0,
    replayGain: 0,
    errors: [],
  };
  const coverMemo = new Map<string, Cover | null>();

  for (const artist of artists) {
    summary.bands += 1;
    const planByNorm = new Map(listPlanRows(deps.db, artist.id).map((r) => [r.normTitle, r]));
    for (const f of indexOnDisk(deps.collection.listBandFiles(artist.name))) {
      summary.files += 1;
      const planRow = planByNorm.get(f.norm);
      let placement: Placement | null = null;
      try {
        placement = await placementFor(deps, artist, f.norm);
      } catch (err) {
        summary.errors.push({
          file: `${artist.name}/${f.fileName}`,
          error: `placement lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const filePath = join(deps.collection.bandDir(artist.name), f.fileName);
      const result = await writeCanonicalTags(
        deps,
        filePath,
        artist,
        { title: planRow?.title ?? f.title, rank: planRow?.rank ?? 0 },
        placement,
        acq,
        coverMemo,
      );
      if (result.mismatch || !result.probe) {
        summary.errors.push({
          file: `${artist.name}/${f.fileName}`,
          error: result.mismatch ?? "file unreadable/corrupt",
        });
        continue;
      }
      summary.retagged += 1;
      if (result.art) summary.art += 1;
      if (result.replayGain) summary.replayGain += 1;
      recordProbe(deps, artist, planRow?.title ?? f.title, f.norm, planRow, result.probe);
    }
  }
  return summary;
}

/** The file changed on disk — keep the recorded hash/duration in step. */
function recordProbe(
  deps: AppDeps,
  artist: ArtistRow,
  title: string,
  norm: string,
  planRow: { rank: number; pinned: boolean } | undefined,
  probe: AudioProbe,
): void {
  const existing = getTrackByNorm(deps.db, artist.id, norm);
  upsertTrack(deps.db, {
    artistId: artist.id,
    title,
    norm,
    rank: existing?.rank ?? planRow?.rank ?? 0,
    pinned: existing?.pinned ?? planRow?.pinned ?? false,
    status: existing?.status ?? "OWNED",
    filePath: probe.filePath,
    ext: probe.filePath.split(".").pop() ?? "mp3",
    durationS: probe.durationS,
    hash: probe.hash,
    sizeBytes: probe.sizeBytes,
    acquiredAt: existing?.acquiredAt ?? undefined,
  });
}
