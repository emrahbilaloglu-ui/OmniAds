"use client";

import type {
  ProductInstrumentationEventName,
  ProductInstrumentationFailureCode,
  ProductInstrumentationOutcome,
  ProductInstrumentationScope,
  ProductInstrumentationSurface,
} from "@/lib/product-instrumentation";

/**
 * Client-side emission for interactions that never reach a server route.
 *
 * Opening a client row, following a search result, applying a saved view or
 * printing a report all happen entirely in the browser, so they can only be
 * measured by telling the server they happened. This posts to the bounded
 * ingest endpoint, which re-validates everything against the same allowlists —
 * nothing here is trusted.
 *
 * Deliberately fire-and-forget with `keepalive`, and deliberately silent on
 * failure. Losing one interaction event is not worth interrupting the
 * interaction it describes, and the server already counts its own sink health,
 * so a broken sink is visible there rather than in a toast the operator cannot
 * act on. This is the one place a detached write is correct: the request the
 * user cares about is the navigation, not this.
 */
export interface ClientInstrumentationInput {
  eventName: ProductInstrumentationEventName;
  surface: ProductInstrumentationSurface;
  outcome: ProductInstrumentationOutcome;
  scope: ProductInstrumentationScope;
  businessId?: string | null;
  provider?: "meta" | "google" | null;
  itemCount?: number | null;
  durationMs?: number | null;
  failureCode?: ProductInstrumentationFailureCode | null;
}

export function emitProductInstrumentation(
  input: ClientInstrumentationInput,
): void {
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/instrumentation/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: input.eventName,
        surface: input.surface,
        outcome: input.outcome,
        scope: input.scope,
        businessId: input.scope === "business" ? (input.businessId ?? null) : null,
        provider: input.provider ?? null,
        itemCount: input.itemCount ?? null,
        durationMs: input.durationMs ?? null,
        failureCode: input.failureCode ?? null,
      }),
      // Survives the navigation this event usually describes.
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // An analytics call may never break an interaction.
  }
}
