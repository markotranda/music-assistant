import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { upsertTrack } from "../src/db/repositories";
import { getDashboard } from "../src/routes/dashboard";
import { trackBand } from "../src/services/bands";
import { maskSecret, readSettings, updateSettingsGroup } from "../src/services/settings";
import { fakeDeps, syntheticRanked } from "./fakes";

function json(res: Response) {
  return res.json() as Promise<Record<string, never>>;
}

describe("settings API", () => {
  it("masks secrets on read — the clear key never leaves the server", async () => {
    const deps = fakeDeps();
    const res = await createApp(deps).request("/api/settings");
    const body = JSON.stringify(await res.json());
    expect(res.status).toBe(200);
    expect(body).not.toContain("test-key");
    expect((await json(await createApp(deps).request("/api/settings"))).settings).toMatchObject({
      integrations: { lastfmApiKeyMasked: expect.anything() },
      auth: { tokenMasked: null },
    });
  });

  it("maskSecret identifies without revealing", () => {
    expect(maskSecret("")).toBeNull();
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret("abcd12345678")).toBe("abcd…678");
    expect(maskSecret("short")).toBe("••••••");
  });

  it("partial updates keep omitted fields; '' clears a secret", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);

    // Change one flag: the stored key must survive.
    const r1 = await app.request("/api/settings/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deezerEnabled: false }),
    });
    expect(r1.status).toBe(200);
    let settings = readSettings(deps);
    expect(settings.integrations.deezerEnabled).toBe(false);
    expect(settings.integrations.lastfmApiKeyMasked).not.toBeNull();

    // Replace the key.
    await app.request("/api/settings/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastfmApiKey: "brand-new-key-123" }),
    });
    settings = readSettings(deps);
    expect(settings.integrations.lastfmApiKeyMasked).toBe("bran…123");

    // "" clears it.
    await app.request("/api/settings/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastfmApiKey: "" }),
    });
    expect(readSettings(deps).integrations.lastfmApiKeyMasked).toBeNull();
  });

  it("rebuilds integration adapters when their settings change", () => {
    const deps = fakeDeps();
    const before = deps.lastfm;
    updateSettingsGroup(deps, "integrations", {
      musicbrainzUserAgent: "MusicAssistant/9 ( a@b.c )",
    });
    expect(deps.lastfm).not.toBe(before);
  });

  it("validates merged settings (422 with issues, nothing persisted)", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);

    const bad = await app.request("/api/settings/formula", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deepShare: 2 }),
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain("deepShare");

    // floor above cap fails the full-shape invariant.
    const floor = await app.request("/api/settings/formula", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ floors: { 1: 99 } }),
    });
    expect(floor.status).toBe(422);
    expect(JSON.stringify(await floor.json())).toContain("floor");

    const mode = await app.request("/api/settings/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalMode: "banana" }),
    });
    expect(mode.status).toBe(422);
  });

  it("updates formula numbers (partial tier merge)", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    await app.request("/api/settings/formula", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ multipliers: { 2: 1.5 } }),
    });
    const settings = readSettings(deps);
    expect(settings.formula.multipliers[2]).toBe(1.5);
    expect(settings.formula.multipliers[1]).toBe(0.65); // untouched
  });

  it("round-trips the overrides maps (merged acts, search-name fixes)", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    const res = await app.request("/api/settings/overrides", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pinnedMbids: { Terror: "697eba1a-bf52-46b1-a19f-4d7190b63e5c" },
        searchNameFixes: { Motorhead: "Motörhead" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: ReturnType<typeof readSettings> };
    expect(body.settings.overrides).toEqual({
      pinnedMbids: { Terror: "697eba1a-bf52-46b1-a19f-4d7190b63e5c" },
      searchNameFixes: { Motorhead: "Motörhead" },
    });
  });
});

describe("bearer token auth", () => {
  async function enableToken(app: ReturnType<typeof createApp>, token: string) {
    const res = await app.request("/api/settings/auth", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    return res;
  }

  it("guards /api/* only after a token is set, and accepts the right bearer", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);

    // Open by default.
    expect((await app.request("/api/jobs")).status).toBe(200);

    await enableToken(app, "secret-token-123");

    // Health stays open for probes.
    expect((await app.request("/health")).status).toBe(200);

    const bare = await app.request("/api/jobs");
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: expect.stringContaining("token") });

    const wrong = await app.request("/api/jobs", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);

    const ok = await app.request("/api/jobs", {
      headers: { authorization: "Bearer secret-token-123" },
    });
    expect(ok.status).toBe(200);

    // Clearing the token opens the API again.
    await app.request("/api/settings/auth", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token-123" },
      body: JSON.stringify({ token: "" }),
    });
    expect((await app.request("/api/jobs")).status).toBe(200);
  });

  it("changing the token requires the current one", async () => {
    const deps = fakeDeps();
    const app = createApp(deps);
    await enableToken(app, "first-token");

    const res = await app.request("/api/settings/auth", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "second-token" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("dashboard + events", () => {
  it("aggregates library, budgets, and job counts in one call", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const { artist } = await trackBand(deps, { name: "Terror", score: 1 });

    upsertTrack(deps.db, {
      artistId: artist.id,
      title: "Song 01",
      norm: "song01",
      rank: 1,
      pinned: false,
      status: "OWNED",
      filePath: "x/01 - Song 01.mp3",
      ext: ".mp3",
      durationS: 1,
      hash: "abc",
      sizeBytes: 1000,
    });

    const dash = getDashboard(deps);
    expect(dash.library).toMatchObject({
      bands: 1,
      plannedTracks: 7,
      ownedTracks: 1,
      bytesUsed: 1000,
    });
    expect(dash.acquisition.acquiredThisMonth).toBe(1);
    expect(dash.acquisition.monthlyBudgetTracks).toBe(40);
    expect(dash.jobs.pending).toBe(7);
    expect(dash.recentEvents.length).toBeGreaterThan(0);
    expect(dash.recentEvents[0]).toMatchObject({
      kind: expect.any(String),
      payload: expect.any(Object),
      createdAt: expect.any(String),
    });
  });

  it("serves the audit feed with filters", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    await trackBand(deps, { name: "Terror", score: 1 });

    const all = await (await createApp(deps).request("/api/events?limit=5")).json();
    expect(all.events.length).toBeGreaterThan(0);
    expect(all.events.length).toBeLessThanOrEqual(5);

    const filtered = await (
      await createApp(deps).request("/api/events?kind=artist_tracked")
    ).json();
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].payload).toMatchObject({ name: "Terror" });
  });
});
