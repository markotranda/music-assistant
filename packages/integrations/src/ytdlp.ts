import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { IntegrationError } from "./http.js";

/**
 * yt-dlp acquisition adapter. Ports the legacy Invoke-Download recipe exactly
 * (search fallback chain × player-client fallbacks, duration match filter) but
 * with the output captured and returned — the legacy tool piped everything to
 * Out-Null and swallowed errors, which is why failed downloads were invisible.
 */

export type SpawnResult = { code: number; stdout: string; stderr: string };
export type SpawnImpl = (command: string, args: string[]) => Promise<SpawnResult>;

export type YtDlpOptions = {
  /** Path to the yt-dlp binary (default: "yt-dlp" on PATH). */
  binary?: string;
  /** Directory containing ffmpeg (yt-dlp --ffmpeg-location). */
  ffmpegLocation?: string;
  /** Node executable for --js-runtimes (EJS challenge solvers need Node). */
  nodeExe?: string;
  spawnImpl?: SpawnImpl;
  /** Pause between fallback attempts (legacy slept 2s). */
  retryDelayMs?: number;
};

export type DownloadRequest = {
  /** Band search name (already passed through searchNameFixes). */
  band: string;
  title: string;
  /** Destination path WITHOUT extension: `<dir>/NN - Title`. */
  destBase: string;
  minDurationS?: number;
  maxDurationS?: number;
  audioFormat?: string;
  audioQuality?: string;
  /** Fallback player clients; null = yt-dlp default. */
  playerClients?: (string | null)[];
};

export type DownloadAttempt = {
  query: string;
  playerClient: string | null;
  code: number;
  /** Condensed yt-dlp output — the part the legacy tool discarded. */
  summary: string;
};

export type DownloadResult =
  | { ok: true; filePath: string; attempts: DownloadAttempt[] }
  | { ok: false; attempts: DownloadAttempt[]; error: string };

const DEFAULT_CLIENTS: (string | null)[] = [null, "web_safari", "android,web"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Legacy query chain: tight search first, then punctuation-stripped and widened. */
export function searchQueries(
  band: string,
  title: string,
): { query: string; playlistItems1: boolean }[] {
  const plain = title
    .replace(/[()[\]']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    { query: `ytsearch1:${band} ${title} audio`, playlistItems1: false },
    { query: `ytsearch3:${band} ${plain}`, playlistItems1: true },
  ];
}

export function buildArgs(
  req: DownloadRequest,
  q: { query: string; playlistItems1: boolean },
  playerClient: string | null,
  options: YtDlpOptions,
): string[] {
  const args = [
    q.query,
    "--extract-audio",
    "--audio-format",
    req.audioFormat ?? "mp3",
    "--audio-quality",
    req.audioQuality ?? "2",
    ...(options.ffmpegLocation ? ["--ffmpeg-location", options.ffmpegLocation] : []),
    ...(options.nodeExe ? ["--js-runtimes", `node:${options.nodeExe}`] : []),
    "--match-filter",
    `duration>${req.minDurationS ?? 60} & duration<${req.maxDurationS ?? 900}`,
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    "--no-progress",
    "-o",
    `${req.destBase}.%(ext)s`,
  ];
  if (playerClient) {
    args.push("--extractor-args", `youtube:player_client=${playerClient}`);
  }
  if (q.playlistItems1) {
    args.push("--playlist-items", "1");
  }
  return args;
}

/** The produced audio file next to the template (ignoring .part/.ytdl noise). */
export function findProduced(destBase: string): string | null {
  const dir = dirname(destBase);
  const stem = basename(destBase);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(`${stem}.`)) continue;
    if (/\.(part|ytdl|json|description|jpg)$/i.test(name)) continue;
    return join(dir, name);
  }
  return null;
}

function summarize(res: SpawnResult): string {
  const text = `${res.stdout}\n${res.stderr}`.trim();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return `exit code ${res.code} with no output`;
  return lines.slice(-4).join(" | ").slice(0, 500);
}

function defaultSpawn(command: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject); // e.g. ENOENT when the binary is missing
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function createYtDlp(options: YtDlpOptions = {}) {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const retryDelayMs = options.retryDelayMs ?? 2000;

  return {
    /**
     * Downloads one track to `destBase.<ext>`, trying every query × player
     * client combination (legacy order) before giving up — with every attempt's
     * output returned to the caller instead of discarded.
     */
    async download(req: DownloadRequest): Promise<DownloadResult> {
      const attempts: DownloadAttempt[] = [];
      const clients = req.playerClients ?? DEFAULT_CLIENTS;

      for (const q of searchQueries(req.band, req.title)) {
        for (const playerClient of clients) {
          const args = buildArgs(req, q, playerClient, options);
          let res: SpawnResult;
          try {
            res = await spawnImpl(options.binary ?? "yt-dlp", args);
          } catch (err) {
            // The binary itself is broken/missing — retrying won't help.
            throw new IntegrationError(
              `yt-dlp could not run: ${err instanceof Error ? err.message : err}`,
              {
                service: "ytdlp",
                cause: err,
              },
            );
          }
          attempts.push({
            query: q.query,
            playerClient,
            code: res.code,
            summary: summarize(res),
          });

          const produced = findProduced(req.destBase);
          if (produced) {
            return { ok: true, filePath: produced, attempts };
          }
          if (retryDelayMs > 0) await sleep(retryDelayMs);
        }
      }

      return {
        ok: false,
        attempts,
        error: `no audio produced after ${attempts.length} attempts (last: ${attempts.at(-1)?.summary ?? "no output"})`,
      };
    },
  };
}

export type YtDlpApi = ReturnType<typeof createYtDlp>;
