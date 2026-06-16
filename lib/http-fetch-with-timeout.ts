/**
 * lib/http-fetch-with-timeout.ts
 *
 * A single place that bounds every outbound HTTP request with a timeout.
 *
 * Why this exists: the durable sync worker runs a strictly sequential loop on a
 * single event loop. An `await fetch()` with no `AbortSignal` parks the loop
 * forever if the remote TCP connection stalls mid-flight (accepted but never
 * answered). That is exactly what froze adsecute-worker-1 for 12 days on
 * 2026-06-04 — no crash, no OOM, just an idle process waiting on a socket that
 * never replied. Routing provider calls through this helper makes "forgot the
 * timeout" impossible to reintroduce silently.
 *
 * It mirrors the existing `AbortSignal.timeout(...)` idiom already used in
 * lib/api/meta.ts and lib/google-ads-gaql.ts.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label?: string) {
    super(`${label ?? "HTTP request"} timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchTimeoutOptions {
  /** Per-request budget in milliseconds. Defaults to DEFAULT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Human-readable label used in the thrown timeout error message. */
  label?: string;
}

/**
 * Drop-in replacement for `fetch()` that aborts the request after `timeoutMs`.
 * A timeout surfaces as a `FetchTimeoutError` (an `Error` subclass), so existing
 * try/catch and error-classification paths keep working — the only behavioural
 * change is that a stalled request now fails instead of hanging forever.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  options: FetchTimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (
      name === "TimeoutError" ||
      name === "AbortError" ||
      /timed out|aborted|abort/i.test(message)
    ) {
      throw new FetchTimeoutError(timeoutMs, options.label);
    }
    throw error;
  }
}
