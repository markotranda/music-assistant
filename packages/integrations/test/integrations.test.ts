import { describe, expect, it } from "vitest";
import { type IntegrationName, MA_INTEGRATIONS_VERSION } from "../src/index";

describe("integrations package", () => {
  it("exposes a version", () => {
    expect(MA_INTEGRATIONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("declares the known integrations", () => {
    const names: IntegrationName[] = ["musicbrainz", "lastfm", "deezer", "ytdlp", "filesystem"];
    expect(names).toHaveLength(5);
  });
});
