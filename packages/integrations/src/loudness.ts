import { execFile } from "node:child_process";

/**
 * ReplayGain measurement via ffmpeg's EBU R128 meter (the legacy port:
 * `ebur128=peak=true` summary, reference level -18 LUFS). Returns null rather
 * than raising: a missing gain tag makes a track play at its native level — a
 * cosmetic problem — and failing the whole download over it would not be.
 */

/** ReplayGain 2.0 reference level. */
export const RG_REFERENCE_LUFS = -18;

export type Loudness = {
  lufs: number;
  peakDbfs: number;
  /** Gain to apply to hit the reference level. */
  gainDb: number;
  peakLinear: number;
};

const I_RX = /^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/m;
const PEAK_RX = /^\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/m;

/** The ebur128 summary block ffmpeg prints on stderr. Pure — tested directly. */
export function parseEbur128(stderr: string): { lufs: number; peakDbfs: number } | null {
  const i = [...stderr.matchAll(new RegExp(I_RX.source, "gm"))];
  const p = [...stderr.matchAll(new RegExp(PEAK_RX.source, "gm"))];
  if (i.length === 0) return null;
  const lufs = Number.parseFloat(i[i.length - 1]?.[1] ?? "");
  const peakDbfs = p.length > 0 ? Number.parseFloat(p[p.length - 1]?.[1] ?? "") : 0;
  return {
    lufs,
    peakDbfs: Number.isNaN(peakDbfs) ? 0 : peakDbfs,
  };
}

function toLoudness(m: { lufs: number; peakDbfs: number }): Loudness {
  return {
    lufs: m.lufs,
    peakDbfs: m.peakDbfs,
    gainDb: RG_REFERENCE_LUFS - m.lufs,
    peakLinear: 10 ** (m.peakDbfs / 20),
  };
}

export async function measureLoudness(
  filePath: string,
  opts: { ffmpegBin?: string; timeoutMs?: number } = {},
): Promise<Loudness | null> {
  const bin = opts.ffmpegBin ?? "ffmpeg";
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        ["-nostats", "-hide_banner", "-i", filePath, "-af", "ebur128=peak=true", "-f", "null", "-"],
        { timeout: opts.timeoutMs ?? 300_000 },
        (err, _stdout, errStderr) => {
          // ffmpeg exits non-zero on some decoders even when it printed the
          // summary; the summary is what we need, so only give up without it.
          if (err && !errStderr) reject(err);
          else resolve(errStderr);
        },
      );
    });
    const m = parseEbur128(stderr);
    return m ? toLoudness(m) : null;
  } catch {
    return null;
  }
}
