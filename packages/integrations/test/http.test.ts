import { describe, expect, it } from "vitest";
import type { HttpJson } from "../src/index";
import { createHttp, IntegrationError } from "../src/index";

function fakeFetch(
  responses:
    | (() => Response | Promise<Response>)[]
    | ((url: string) => Response | Promise<Response>),
): typeof fetch {
  let calls = 0;
  return (async (url: RequestInfo | URL) => {
    const fn = Array.isArray(responses)
      ? (responses[Math.min(calls, responses.length - 1)] as () => Response)
      : (responses as (url: string) => Response);
    calls += 1;
    return fn(String(url));
  }) as typeof fetch;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("createHttp", () => {
  it("returns parsed JSON on success", async () => {
    const http = createHttp({ service: "test", fetchImpl: fakeFetch([() => ok({ a: 1 })]) });
    await expect(http("https://x.test/")).resolves.toEqual({ a: 1 });
  });

  it("retries retryable failures and eventually succeeds", async () => {
    const http = createHttp({
      service: "test",
      backoffBaseMs: 1,
      fetchImpl: fakeFetch([
        () => new Response("boom", { status: 500 }),
        () => new Response("boom", { status: 503 }),
        () => ok({ ok: true }),
      ]),
    });
    await expect(http("https://x.test/")).resolves.toEqual({ ok: true });
  });

  it("gives up after maxAttempts with a typed error", async () => {
    const http = createHttp({
      service: "test",
      backoffBaseMs: 1,
      maxAttempts: 3,
      fetchImpl: fakeFetch([() => new Response("boom", { status: 500 })]),
    });
    const err = await http("https://x.test/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).service).toBe("test");
    expect((err as IntegrationError).status).toBe(500);
  });

  it("does not retry non-retryable statuses (legacy swallowed these)", async () => {
    let calls = 0;
    const http = createHttp({
      service: "test",
      backoffBaseMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("nope", { status: 404 });
      }) as typeof fetch,
    });
    const err = await http("https://x.test/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).status).toBe(404);
    expect(calls).toBe(1);
  });

  it("spaces requests by rateLimitMs", async () => {
    const http: HttpJson = createHttp({
      service: "test",
      rateLimitMs: 40,
      fetchImpl: fakeFetch([() => ok({})]),
    });
    const start = Date.now();
    await Promise.all([
      http("https://x.test/1"),
      http("https://x.test/2"),
      http("https://x.test/3"),
    ]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });
});
