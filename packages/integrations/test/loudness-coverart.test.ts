import { describe, expect, it } from "vitest";
import { createCoverArt, parseEbur128 } from "../src/index";

/** ffmpeg's ebur128 summary, as captured from a real run (stderr tail). */
const EBU_STDERR = `
[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -14.20 LUFS
    Threshold: -24.32 LUFS

  Loudness range:
    LRA:         6.10 LU
    Threshold: -34.42 LUFS
    LRA low:   -19.80 LUFS
    LRA high:  -13.70 LUFS

  True peak:
    Peak:       -1.23 dBFS
`;

describe("parseEbur128", () => {
  it("reads integrated loudness and true peak (the last summary wins)", () => {
    const m = parseEbur128(EBU_STDERR);
    expect(m).toEqual({ lufs: -14.2, peakDbfs: -1.23 });
  });

  it("handles a negative-positive mix and missing peak", () => {
    expect(parseEbur128("  I:          0.50 LUFS\n")).toEqual({ lufs: 0.5, peakDbfs: 0 });
    expect(parseEbur128("nothing useful here")).toBeNull();
  });
});

describe("createCoverArt", () => {
  it("returns the front cover bytes and mime", async () => {
    const calls: string[] = [];
    const coverart = createCoverArt({
      userAgent: "test",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }) as typeof fetch,
    });
    await expect(coverart.front("rg-1")).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      mime: "image/jpeg",
    });
    expect(calls[0]).toContain("/release-group/rg-1/front");
  });

  it("treats 404 (no art published) and network failure as null, never a throw", async () => {
    const notFound = createCoverArt({
      userAgent: "test",
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    await expect(notFound.front("rg-none")).resolves.toBeNull();

    const offline = createCoverArt({
      userAgent: "test",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    await expect(offline.front("rg-none")).resolves.toBeNull();
  });
});
