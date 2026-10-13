import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { setSetting } from "../src/db/repositories";
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
    expect(body.paths["/api/plan"]).toBeDefined();
    expect(body.paths["/api/retag"]).toBeDefined();
  });
});

describe("bulk plan API", () => {
  it("queues one plan_all job and dedupes identical pending runs", async () => {
    const app = createApp(fakeDeps({ ranked: syntheticRanked(30) }));

    const first = await app.request("/api/plan", { method: "POST" });
    expect(first.status).toBe(202);
    expect((await first.json()).jobId).not.toBeNull();

    const second = await app.request("/api/plan", { method: "POST" });
    expect(second.status).toBe(202);
    expect((await second.json()).jobId).toBeNull(); // identical run already queued
  });
});

describe("settings upgrade path", () => {
  it("returns complete acquisition settings for rows written before embedArt/replayGain existed", async () => {
    const deps = fakeDeps();
    // A v1.1.x row: the tag-quality fields did not exist yet.
    setSetting(deps.db, "acquisition", {
      audioFormat: "mp3",
      audioQuality: "2",
      minDurationS: 60,
      maxDurationS: 900,
      playerClients: [null],
    });

    const res = await createApp(deps).request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { acquisition: { embedArt: boolean; replayGain: boolean } };
    };
    expect(body.settings.acquisition.embedArt).toBe(true);
    expect(body.settings.acquisition.replayGain).toBe(true);
  });
});

describe("retag API", () => {
  it("queues one retag job and dedupes identical pending runs", async () => {
    const app = createApp(fakeDeps());
    const post = (body: unknown) =>
      app.request("/api/retag", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    const first = await post({});
    expect(first.status).toBe(202);
    expect((await first.json()).jobId).not.toBeNull();

    const second = await post({});
    expect(second.status).toBe(202);
    expect((await second.json()).jobId).toBeNull(); // identical run already queued

    const scoped = await post({ artistId: 1 });
    expect(scoped.status).toBe(202);
    expect((await scoped.json()).jobId).not.toBeNull(); // different scope = different job
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

describe("jobs + verify API", () => {
  it("lists jobs, retries only failed ones, and verifies bands", async () => {
    const deps = fakeDeps({ ranked: syntheticRanked(30) });
    const app = createApp(deps);

    // tracking enqueues download jobs
    await app.request("/api/artists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Terror", score: 1 }),
    });

    const listed = await (await app.request("/api/jobs")).json();
    expect(listed.jobs).toHaveLength(7);
    expect(listed.jobs[0].type).toBe("download");
    expect(listed.jobs[0].status).toBe("pending");
    expect(listed.jobs[0].payload).toMatchObject({ norm: expect.any(String) });

    // filtered listing
    const empty = await (await app.request("/api/jobs?status=failed")).json();
    expect(empty.jobs).toHaveLength(0);

    // retry is only meaningful for failed jobs
    const retry = await app.request(`/api/jobs/${listed.jobs[0].id}/retry`, { method: "POST" });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: expect.stringContaining("pending") });

    const missing = await app.request("/api/jobs/999/retry", { method: "POST" });
    expect(missing.status).toBe(404);

    // deep verify (empty folder -> every planned track missing)
    const verify = await app.request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artistId: 1 }),
    });
    expect(verify.status).toBe(200);
    const { reports } = await verify.json();
    expect(reports).toHaveLength(1);
    expect(reports[0].band).toBe("Terror");
    expect(reports[0].ok).toBe(false);
    expect(reports[0].issues.every((i: { type: string }) => i.type === "missing")).toBe(true);
    expect(reports[0].issues).toHaveLength(7);
  });
});
