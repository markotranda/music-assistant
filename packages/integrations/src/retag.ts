import { File } from "node-taglib-sharp";

/**
 * Canonical retagging. YouTube-derived metadata is unreliable, so the tags on
 * every acquired file are written from our own plan data with TagLib and then
 * read back (see audio-probe.ts) to prove they stuck.
 */

export type CanonicalTags = {
  artist: string;
  title: string;
  albumArtist: string;
  album?: string;
  /** The popularity rank — stored as the track number. */
  trackNumber?: number;
};

export function retagFile(filePath: string, tags: CanonicalTags): void {
  const file = File.createFromPath(filePath);
  try {
    file.tag.performers = [tags.artist];
    file.tag.title = tags.title;
    file.tag.albumArtists = [tags.albumArtist];
    if (tags.album) file.tag.album = tags.album;
    if (tags.trackNumber !== undefined) file.tag.track = tags.trackNumber;
    file.save();
  } finally {
    file.dispose();
  }
}
