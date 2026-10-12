import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnResult } from "../src/index";
import {
  buildArgs,
  createYtDlp,
  findProduced,
  IntegrationError,
  searchQueries,
} from "../src/index";

function tempDestBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-ytdlp-"));
  mkdirSync(dir, { recursive: true });
  return join(dir, "01 - Keepers of the Faith");
}

/** Simulates yt-dlp: writes the produced file when the script says so. */
function scriptedSpawn(script: ((args: string[], n: number) => SpawnResult | "produce")[]): {
  spawnImpl: SpawnImpl;
  calls: string[][];
} {
  const calls: string[][] = [];
  let n = 0;
  return {
    calls,
    spawnImpl: async (_cmd, args) => {
      calls.push(args);
      const step = script[Math.min(n, script.length - 1)] as (
        a: string[],
        i: number,
      ) => SpawnResult;
      n += 1;
      const out = step(args, n);
      if (out === "produce") {
        const template = args[args.indexOf("-o") + 1] as string;
        const dest = template.replace(".%(ext)s", ".mp3");
        writeFileSync(dest, "fake audio");
        return { code: 0, stdout: "[download] Destination: x", stderr: "" };
      }
      return out;
    },
  };
}

const fail: SpawnResult = {
  code: 1,
  stdout: "",
  stderr: "ERROR: Sign in to confirm you're not a bot",
};

describe("searchQueries / buildArgs", () => {
  it("uses the legacy query chain: tight search, then punctuation-stripped + widened", () => {
    const qs = searchQueries("Terror", "Keep Your Mouth Shut (Deluxe)");
    expect(qs[0]).toEqual({
      query: "ytsearch1:Terror Keep Your Mouth Shut (Deluxe) audio",
      playlistItems1: false,
    });
    expect(qs[1]).toEqual({
      query: "ytsearch3:Terror Keep Your Mouth Shut Deluxe",
      playlistItems1: true,
    });
  });

  it("builds the legacy quality-filtered args", () => {
    const args = buildArgs(
      { band: "Terror", title: "Overcome", destBase: "/x/01 - Overcome" },
      { query: "ytsearch1:Terror Overcome audio", playlistItems1: false },
      "web_safari",
      { ffmpegLocation: "/ff", nodeExe: "/node" },
    );
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--no-playlist");
    expect(args[args.indexOf("--match-filter") + 1]).toBe("duration>60 & duration<900");
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("/ff");
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node:/node");
    expect(args[args.indexOf("--extractor-args") + 1]).toBe("youtube:player_client=web_safari");
    expect(args[args.indexOf("-o") + 1]).toBe("/x/01 - Overcome.%(ext)s");
  });
});

describe("createYtDlp.download", () => {
  it("returns the produced file on first success and keeps the attempt log", async () => {
    const destBase = tempDestBase();
    const { spawnImpl, calls } = scriptedSpawn([() => "produce"]);
    const ytdlp = createYtDlp({ spawnImpl, retryDelayMs: 0 });

    const res = await ytdlp.download({ band: "Terror", title: "Overcome", destBase });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.filePath).toBe(`${destBase}.mp3`);
    }
    expect(calls).toHaveLength(1);
    expect(res.attempts).toHaveLength(1);
  });

  it("walks the full query x player-client chain and records every failure", async () => {
    const destBase = tempDestBase();
    const { spawnImpl, calls } = scriptedSpawn([
      () => fail,
      () => fail,
      () => fail,
      () => fail,
      () => fail,
      () => "produce", // last combination finally works
    ]);
    const ytdlp = createYtDlp({ spawnImpl, retryDelayMs: 0 });

    const res = await ytdlp.download({ band: "Terror", title: "Overcome", destBase });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(6);

    // Legacy order: query 1 × 3 clients, then query 2 × 3 clients.
    const combos = calls.map((a) => ({
      query: a[0],
      client: a.includes("--extractor-args") ? a[a.indexOf("--extractor-args") + 1] : null,
    }));
    expect(combos.map((c) => c.client)).toEqual([
      null,
      "youtube:player_client=web_safari",
      "youtube:player_client=android,web",
      null,
      "youtube:player_client=web_safari",
      "youtube:player_client=android,web",
    ]);
    expect(combos[3].query).toContain("ytsearch3:");
    expect(res.attempts.every((a) => a.summary.includes("not a bot") || a.code === 0)).toBe(true);
  });

  it("fails with the real yt-dlp output instead of silence (legacy Out-Null)", async () => {
    const destBase = tempDestBase();
    const { spawnImpl } = scriptedSpawn([() => fail]);
    const ytdlp = createYtDlp({ spawnImpl, retryDelayMs: 0 });

    const res = await ytdlp.download({ band: "Terror", title: "Overcome", destBase });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toHaveLength(6);
      expect(res.error).toContain("not a bot");
    }
  });

  it("throws a typed error when the binary itself cannot run", async () => {
    const ytdlp = createYtDlp({
      retryDelayMs: 0,
      spawnImpl: async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(
      ytdlp.download({ band: "Terror", title: "Overcome", destBase: tempDestBase() }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe("findProduced", () => {
  it("ignores in-progress sidecar files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-prod-"));
    const base = join(dir, "01 - X");
    writeFileSync(`${base}.mp3.part`, "");
    writeFileSync(`${base}.mp3.ytdl`, "");
    expect(findProduced(base)).toBeNull();
    writeFileSync(`${base}.mp3`, "audio");
    expect(findProduced(base)).toBe(`${base}.mp3`);
    expect(findProduced(join(dir, "nope"))).toBeNull();
  });
});
