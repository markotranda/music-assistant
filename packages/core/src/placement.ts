import { normTitle } from "./text.js";

/**
 * Album placement — the legacy rule made explicit (legacy schema.sql): "a song
 * is attributed to its earliest official studio release, and the track number
 * is that album's position." Album choice and track-number meaning are NOT
 * settings; a non-album position makes the tag lie about the album's order.
 *
 * The inputs arrive as the artist's studio albums, earliest first, each with
 * the tracklist of its canonical release (earliest official release in the
 * group). A recording that appears on more than one studio album lands on the
 * first album walked.
 */

export type PlacementAlbumInput = {
  /** Release-group title (the album name that goes into the tag). */
  title: string;
  /** Year of the album's first release. */
  year: number | null;
  releaseGroupMbid: string;
  media: {
    /** Disc number; the media order is used when the release declares none. */
    position: number | null;
    /** Declared track count for the disc (falls back to the tracklist length). */
    trackCount: number;
    tracks: {
      position: number | null;
      title: string;
      recordingMbid: string | null;
    }[];
  }[];
};

export type Placement = {
  normTitle: string;
  album: string;
  year: number | null;
  /** Album position — never the collection rank. */
  trackNo: number | null;
  discNo: number | null;
  /** Album total (sum of the discs' track counts). */
  trackTotal: number | null;
  recordingMbid: string | null;
  releaseGroupMbid: string;
};

/**
 * Turn the studio-album walk into per-title placements. First mention wins:
 * albums are ordered earliest-first, so a song re-recorded for a later album
 * keeps its earliest official studio release.
 */
export function buildPlacements(albums: PlacementAlbumInput[]): Placement[] {
  const seen = new Set<string>();
  const out: Placement[] = [];
  for (const album of albums) {
    const trackTotal =
      album.media.reduce((acc, m) => acc + (m.trackCount || m.tracks.length), 0) || null;
    for (const [index, medium] of album.media.entries()) {
      const discNo = medium.position ?? index + 1;
      for (const track of medium.tracks) {
        const norm = normTitle(track.title);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push({
          normTitle: norm,
          album: album.title,
          year: album.year,
          trackNo: track.position,
          discNo,
          trackTotal,
          recordingMbid: track.recordingMbid,
          releaseGroupMbid: album.releaseGroupMbid,
        });
      }
    }
  }
  return out;
}
