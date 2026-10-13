import {
  ByteVector,
  File,
  Id3v2FrameClassType,
  type Id3v2Tag,
  Id3v2UniqueFileIdentifierFrame,
  Id3v2UserTextInformationFrame,
  Picture,
  PictureType,
  StringType,
  TagTypes,
} from "node-taglib-sharp";

/**
 * Canonical retagging. YouTube-derived metadata is unreliable, so the tags on
 * every acquired file are written from our own plan data with TagLib and then
 * read back (see audio-probe.ts) to prove they stuck.
 *
 * Frame spellings follow the legacy tool exactly (Picard's): TXXX "MusicBrainz
 * Artist Id" / "MusicBrainz Album Artist Id" / "MusicBrainz Release Group Id"
 * and UFID owner "http://musicbrainz.org" for the recording id — a mismatch
 * would leave a Picard-tagged collection half-readable.
 */

export type CanonicalTags = {
  artist: string;
  title: string;
  albumArtist: string;
  album?: string;
  year?: number;
  /** The ALBUM position (never the collection rank — rank lives in the file name). */
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  mbids?: {
    artist?: string;
    albumArtist?: string;
    releaseGroup?: string;
    recording?: string;
  };
  /** ReplayGain 2.0 (reference level -18 LUFS). */
  replayGain?: { gainDb: number; peakLinear: number };
};

export type Cover = { data: Uint8Array; mime: string };

export type RetagOptions = {
  /** Lazy cover source; only called when a cover is to be embedded. */
  cover?: () => Cover | null;
};

export type RetagResult = {
  art: boolean;
};

const MB_OWNER = "http://musicbrainz.org";

export function retagFile(
  filePath: string,
  tags: CanonicalTags,
  opts: RetagOptions = {},
): RetagResult {
  const file = File.createFromPath(filePath);
  try {
    const t = file.tag;
    t.performers = [tags.artist];
    t.title = tags.title;
    t.albumArtists = [tags.albumArtist];
    if (tags.album) t.album = tags.album;
    if (tags.year !== undefined) t.year = tags.year;
    if (tags.trackNumber !== undefined) {
      t.track = tags.trackNumber;
      if (tags.trackTotal !== undefined) t.trackCount = tags.trackTotal;
    }
    if (tags.discNumber !== undefined) t.disc = tags.discNumber;
    if (tags.mbids?.artist) t.musicBrainzArtistId = tags.mbids.artist;
    if (tags.mbids?.releaseGroup) t.musicBrainzReleaseGroupId = tags.mbids.releaseGroup;
    if (tags.replayGain) {
      t.replayGainTrackGain = tags.replayGain.gainDb;
      t.replayGainTrackPeak = tags.replayGain.peakLinear;
    }

    // Frames TagLib has no property for. MP3 only — everything else the
    // acquisition writes is mp3, and per-format extras would buy nothing.
    const id3 = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag | undefined;
    if (id3) {
      setUserText(id3, "MusicBrainz Album Artist Id", tags.mbids?.albumArtist ?? null);
      setUfid(id3, MB_OWNER, tags.mbids?.recording ?? null);
    }

    let art = false;
    const cover = opts.cover?.() ?? null;
    if (cover) {
      const picture = Picture.fromFullData(
        ByteVector.fromByteArray(cover.data),
        PictureType.FrontCover,
        cover.mime,
        "Front cover",
      );
      t.pictures = [picture];
      art = true;
    }

    file.save();
    return { art };
  } finally {
    file.dispose();
  }
}

/** Replace (or clear) one of the TXXX frames this app owns. */
function setUserText(id3: Id3v2Tag, desc: string, value: string | null): void {
  const frames = id3.getFramesByClassType<Id3v2UserTextInformationFrame>(
    Id3v2FrameClassType.UserTextInformationFrame,
  );
  const existing = Id3v2UserTextInformationFrame.findUserTextInformationFrame(frames, desc);
  if (existing) id3.removeFrame(existing);
  if (value) {
    const frame = Id3v2UserTextInformationFrame.fromDescription(desc);
    frame.text = [value];
    id3.addFrame(frame);
  }
}

/** Replace (or clear) the MusicBrainz recording id UFID. */
function setUfid(id3: Id3v2Tag, owner: string, value: string | null): void {
  const frames = id3.getFramesByClassType<Id3v2UniqueFileIdentifierFrame>(
    Id3v2FrameClassType.UniqueFileIdentifierFrame,
  );
  for (const frame of frames) {
    if (frame.owner === owner) id3.removeFrame(frame);
  }
  if (value) {
    id3.addFrame(
      Id3v2UniqueFileIdentifierFrame.fromData(
        owner,
        ByteVector.fromString(value, StringType.Latin1),
      ),
    );
  }
}
