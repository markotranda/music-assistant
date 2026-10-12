import { readFileSync } from "node:fs";

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export const fixtures = {
  mbArtistSearchTerror: load<Record<string, unknown>>("mb-artist-search-terror.json"),
  mbArtistSearchTurbonegro: load<Record<string, unknown>>("mb-artist-search-turbonegro.json"),
  mbReleaseGroupsTerror: load<Record<string, unknown>>("mb-release-groups-terror.json"),
  mbReleasesTerror: load<Record<string, unknown>>("mb-releases-terror.json"),
  mbAlbumReleases: load<Record<string, unknown>>("mb-album-releases.json"),
  mbAlbumReleaseFull: load<Record<string, unknown>>("mb-album-release-full.json"),
  lastfmToptracksTerror: load<Record<string, unknown>>("lastfm-toptracks-terror.json"),
  lastfmSimilarTerror: load<Record<string, unknown>>("lastfm-similar-terror.json"),
  deezerSearchTerror: load<Record<string, unknown>>("deezer-search-terror.json"),
  deezerTopTerror: load<Record<string, unknown>>("deezer-top-terror.json"),
};
