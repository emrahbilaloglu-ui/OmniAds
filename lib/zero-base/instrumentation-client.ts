"use client";

/**
 * Non-blocking client emitter.
 *
 * Three properties, in order of importance:
 *
 * 1. It never blocks or throws into a render path. Every failure is swallowed;
 *    a broken sink must not break navigation.
 * 2. It retries **once**, then drops. An unbounded retry queue on a flaky
 *    connection turns a telemetry blip into a request storm, and the event is
 *    not worth that.
 * 3. It carries a UUID `eventId`, so the retry cannot double-count — the
 *    server treats a repeat as a no-op via a partial unique index.
 *
 * `actor_role` and `width_bucket` are deliberately not sent: the server
 * derives both. Only the raw viewport width goes over the wire, and the server
 * buckets it.
 */
import { GENERATED_INSTRUMENTATION } from "@/lib/zero-base/generated-contracts";

const ENDPOINT = "/api/instrumentation/event";

export interface ScreenViewInput {
  surface: string;
  businessId?: string | null;
  accountId?: string | null;
  properties?: Record<string, string>;
}

function isDeclaredSurface(surface: string): boolean {
  return GENERATED_INSTRUMENTATION.some(
    (row) => row.surface === surface && row.event === "screen_view",
  );
}

async function post(body: unknown, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      signal,
    });
    // A 4xx is a contract problem: retrying cannot fix it, so do not.
    if (response.status >= 400 && response.status < 500) return true;
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Emits one screen view. Resolves when the attempt is finished; callers are
 * not expected to await it.
 */
export async function emitScreenView(input: ScreenViewInput): Promise<void> {
  // An undeclared surface is a bug in the caller, not something to send.
  if (!isDeclaredSurface(input.surface)) return;

  const body = {
    contract: "zero-base.v2",
    surface: input.surface,
    event: "screen_view",
    eventId: globalThis.crypto?.randomUUID?.() ?? null,
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    businessId: input.businessId ?? null,
    accountId: input.accountId ?? null,
    properties: input.properties ?? {},
  };

  if (await post(body)) return;
  // Exactly one retry, with the same eventId so it cannot double-count.
  await post(body);
}
