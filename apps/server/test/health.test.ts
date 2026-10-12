import { describe, expect, it } from "vitest";
import { app } from "../src/app";

describe("GET /health", () => {
  it("returns ok with version and time", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Date(body.time).getTime()).not.toBeNaN();
  });
});

describe("GET /doc", () => {
  it("exposes an OpenAPI 3.1 document", async () => {
    const res = await app.request("/doc");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/health"]).toBeDefined();
  });
});
