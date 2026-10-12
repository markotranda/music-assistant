import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeDeps, syntheticRanked } from "./fakes";

describe("GET /health", () => {
  it("returns ok with version and time", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Date(body.time).getTime()).not.toBeNaN();
  });
});

describe("GET /doc", () => {
  it("exposes an OpenAPI 3.1 document with the API routes", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/doc");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/health"]).toBeDefined();
    expect(body.paths["/api/artists"]).toBeDefined();
    expect(body.paths["/api/artists/{id}/sync"]).toBeDefined();
  });
});

describe("bands API", () => {
  it("tracks a band end to end and reports typed errors", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const app = createApp(deps);

    // resolve
    const resolve = await app.request("/api/artists/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Terror" }),
    });
    expect(resolve.status).toBe(200);

    // track
    const track = await app.request("/api/artists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Terror", score: 2 }),
    });
    expect(track.status).toBe(201);
    const tracked = await track.json();
    expect(tracked.artist.name).toBe("Terror");
    expect(tracked.artist.quota).toBe(14);
    expect(tracked.sync.applied).toBe(true);

    // list + detail
    const list = await (await app.request("/api/artists")).json();
    expect(list.artists).toHaveLength(1);
    expect(list.artists[0].planCount).toBe(14);

    const detail = await (await app.request("/api/artists/1")).json();
    expect(detail.plan).toHaveLength(14);
    expect(detail.onDiskCount).toBe(0);

    // duplicate -> 409 with details
    const dup = await app.request("/api/artists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Terror" }),
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: expect.stringContaining("already tracked") });

    // score change
    const patch = await app.request("/api/artists/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 3 }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).artist.score).toBe(3);

    // sync preview
    const sync = await app.request("/api/artists/1/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: false }),
    });
    expect(sync.status).toBe(200);
    expect((await sync.json()).applied).toBe(false);

    // pin track + remove it
    const pin = await app.request("/api/artists/1/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ruby Tuesday" }),
    });
    expect(pin.status).toBe(201);
    const rm = await app.request("/api/artists/1/tracks/rubytuesday", { method: "DELETE" });
    expect(rm.status).toBe(200);

    // untrack
    const del = await app.request("/api/artists/1", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/api/artists")).status).toBe(200);
    const empty = await (await app.request("/api/artists")).json();
    expect(empty.artists).toHaveLength(0);
  });

  it("returns 404 with a typed error body for unknown artists", async () => {
    const app = createApp(fakeDeps());
    const res = await app.request("/api/artists/99/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("99") });
  });
});
