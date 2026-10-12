/**
 * Shared HTTP plumbing for external services: typed errors, bounded retries
 * with backoff, and client-side rate limiting (MusicBrainz requires ≥1.1s
 * between requests). Nothing is swallowed — every failure ends as a typed
 * IntegrationError the caller can log or surface.
 */

export class IntegrationError extends Error {
  readonly service: string;
  readonly status?: number;
  readonly url?: string;

  constructor(
    message: string,
    opts: { service: string; url?: string; status?: number; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "IntegrationError";
    this.service = opts.service;
    this.status = opts.status;
    this.url = opts.url;
  }
}

/** Minimal JSON-over-HTTP client shape shared by all adapters (mockable). */
export type HttpJson = (
  url: string,
  opts?: { headers?: Record<string, string> },
) => Promise<unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type HttpOptions = {
  service: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  /** Minimum interval between requests. */
  rateLimitMs?: number;
  /** Attempts for retryable failures (legacy used 4). */
  maxAttempts?: number;
  /** Attempt N waits N × backoffBaseMs before retrying (legacy used 3s). */
  backoffBaseMs?: number;
};

export function createHttp(options: HttpOptions): HttpJson {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rateLimitMs = options.rateLimitMs ?? 0;
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffBaseMs = options.backoffBaseMs ?? 3000;
  let nextSlot = 0;

  return async (url, opts) => {
    const headers = { ...options.defaultHeaders, ...opts?.headers };
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Reserve a rate-limit slot atomically so concurrent callers queue up
      // instead of bursting through together.
      const slot = Math.max(nextSlot, Date.now());
      nextSlot = slot + rateLimitMs;
      const wait = slot - Date.now();
      if (wait > 0) await sleep(wait);

      try {
        const res = await fetchImpl(url, { headers });
        if (res.ok) return res.json();
        const retryable = res.status === 429 || res.status >= 500;
        const err = new IntegrationError(`HTTP ${res.status} from ${options.service}`, {
          service: options.service,
          url,
          status: res.status,
        });
        if (!retryable) throw err;
        lastError = err;
      } catch (err) {
        // Non-retryable HTTP errors rethrow immediately; network/5xx/429 retry.
        if (err instanceof IntegrationError && err.status !== undefined && err.status < 500) {
          throw err;
        }
        lastError = err;
      }

      if (attempt < maxAttempts) await sleep(attempt * backoffBaseMs);
    }

    throw new IntegrationError(
      `${options.service} request failed after ${maxAttempts} attempts: ${url}`,
      {
        service: options.service,
        url,
        status: lastError instanceof IntegrationError ? lastError.status : undefined,
        cause: lastError,
      },
    );
  };
}
