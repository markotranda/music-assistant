import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { fakeDeps } from "./fakes";

describe("llms.txt", () => {
  it("serves the overview and full reference from the live OpenAPI doc", async () => {
    const app = createApp(fakeDeps());

    const overview = await (await app.request("/llms.txt")).text();
    expect(overview).toContain("# Music Assistant");
    expect(overview).toContain("quota formula");
    expect(overview).toContain("- `POST /api/migrate`");
    expect(overview).toContain("- `GET /api/policy`");
    expect(overview).toContain("/llms-full.txt");

    const full = await (await app.request("/llms-full.txt")).text();
    expect(full).toContain("# Music Assistant — full API reference");
    expect(full).toContain("## POST /api/migrate");
    expect(full).toContain('"bandsCsv"'); // request schema is inlined
  });
});
