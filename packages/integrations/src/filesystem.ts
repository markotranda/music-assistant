import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { extname, join } from "node:path";
import { type RenameAction, safeName } from "@ma/core";

/**
 * Collection folder adapter — the managed library on disk. Files live in
 * `<collection>/<Safe Band Name>/NN - Title.ext` where NN is the popularity
 * rank. Retiring MOVES files to `<retired>/<Band>/` (outside the collection:
 * anything left inside would still be picked up by a player scanning the
 * folder, which defeats the point).
 */

export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".flac", ".aiff", ".ogg"];

export type CollectionFsOptions = {
  collectionDir: string;
  retiredDir: string;
};

export function createCollectionFs(opts: CollectionFsOptions) {
  const bandDir = (bandName: string) => join(opts.collectionDir, safeName(bandName));

  return {
    bandDir,

    /** Audio files in a band's folder (missing folder = empty). */
    listBandFiles(bandName: string): { fileName: string }[] {
      const dir = bandDir(bandName);
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(extname(e.name).toLowerCase()))
        .map((e) => ({ fileName: e.name }));
    },

    /** Two-phase renames: everything goes through ~tmp~ first (legacy discipline). */
    applyRenames(bandName: string, renames: RenameAction[]): void {
      const dir = bandDir(bandName);
      for (const r of renames) {
        renameSync(join(dir, r.from), join(dir, r.viaTemp));
      }
      for (const r of renames) {
        renameSync(join(dir, r.viaTemp), join(dir, r.to));
      }
    },

    /** Move files out of the collection — reversible by design. */
    retireFiles(bandName: string, files: { fileName: string }[]): void {
      const retireDir = join(opts.retiredDir, safeName(bandName));
      mkdirSync(retireDir, { recursive: true });
      for (const f of files) {
        renameSync(join(bandDir(bandName), f.fileName), join(retireDir, f.fileName));
      }
    },
  };
}

export type CollectionFs = ReturnType<typeof createCollectionFs>;
