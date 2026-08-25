"use client";

/**
 * Emit one `screen_view` per mounted Meta surface.
 *
 * WP17's first telemetry requirement — "her mounted Meta yüzeyi screen_view" —
 * and until now it was unmeetable rather than unmet: the vendored leaf ledger
 * declares `event: "screen_view"` for every leaf, and the runtime vocabulary in
 * `lib/product-instrumentation.ts` had no such name, so nothing could emit one.
 *
 * ## Once per surface, not once per render
 *
 * The dependency key is the surface plus the business, so a re-render, a lane
 * change, a filter or a window change does not re-emit. A `screen_view` that
 * fires on every state change stops counting screens and starts counting
 * renders, which is a different number that looks like the same one.
 *
 * Changing business DOES re-emit, because that is a different screen in every
 * sense the metric cares about.
 *
 * ## What it carries
 *
 * The closed `surface` allowlist, the business scope, and nothing else. No
 * account id, no entity id, no window: `emitProductInstrumentation` is
 * deliberately narrow (the sink re-validates against the same allowlists), and
 * a screen view is a fact about a screen, not about what was on it.
 */
import { useEffect } from "react";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import type { ProductInstrumentationSurface } from "@/lib/product-instrumentation";

/**
 * Registry surface id → the instrumentation surface allowlist.
 *
 * Two vocabularies exist for good reasons — the registry names product
 * surfaces, the instrumentation allowlist is a closed set the sink re-validates
 * — and this is the single mapping between them. A surface with no entry emits
 * nothing rather than guessing a name the sink would reject.
 */
export const INSTRUMENTATION_SURFACE_BY_SURFACE_ID: Readonly<
  Record<string, ProductInstrumentationSurface>
> = {
  "meta-decisions": "meta_decisions",
  "meta-intelligence": "meta_intelligence",
  "meta-history": "meta_history",
  "meta-launchpad": "launchpad",
  "meta-automation": "automation",
  /*
   * One name per tab, not one name for eight.
   *
   * These eight all mapped to `creative_studio`, so every Creative Studio tab
   * emitted the same surface and per-tab adoption could not be read from the
   * data at all. Each contracted leaf now carries its own contracted name; the
   * old collapsed value stays in the vocabulary because production rows hold
   * it and the stored CHECK validates existing rows.
   */
  "creative-studio": "creative_performance",
  "creative-copies": "creative_copies",
  "creative-landing-pages": "creative_landing_pages",
  "creative-inbox": "creative_inbox",
  "creative-audiences": "creative_audiences",
  "creative-briefs": "creative_briefs",
  "creative-shares": "creative_shares",
  "creative-detail": "creative_detail",
  "manage-integrations": "integrations",
};

/**
 * The last (surface, business) pair a `screen_view` was emitted for.
 *
 * Module scope, not a ref. A ref only remembers within one component instance,
 * and the shell's emitter is remounted during the first load — measured on the
 * mounted routes, where every Meta surface emitted the identical `screen_view`
 * twice. Every adoption number built on that event was doubled.
 *
 * Not a set: navigating away and back IS a second view and must count again.
 * Only an immediate repeat of the pair that is already current is suppressed,
 * which is exactly "once per surface and business, not once per render".
 */
let lastEmittedScreenViewKey: string | null = null;

/** Test seam: a fresh page load starts with nothing emitted. */
export function resetScreenViewForTest(): void {
  lastEmittedScreenViewKey = null;
}

export function useScreenView(input: {
  surface: ProductInstrumentationSurface;
  businessId: string | null | undefined;
  /**
   * Hold the emission until the surface can actually be said to have been
   * viewed. A skeleton is not a screen view, and counting one would inflate
   * every surface's numbers by its own loading states.
   */
  ready?: boolean;
}) {
  const businessId = input.businessId ?? null;
  const ready = input.ready ?? true;

  useEffect(() => {
    if (!ready || !businessId) return;
    const key = `${input.surface}:${businessId}`;
    if (lastEmittedScreenViewKey === key) return;
    lastEmittedScreenViewKey = key;
    emitProductInstrumentation({
      eventName: "screen_view",
      surface: input.surface,
      outcome: "ok",
      scope: "business",
      businessId,
    });
  }, [businessId, input.surface, ready]);
}
