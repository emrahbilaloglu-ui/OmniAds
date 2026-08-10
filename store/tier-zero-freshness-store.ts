"use client";

import { create } from "zustand";

import type { TierZeroFreshnessState } from "@/components/states/TierZeroFreshness";
import type { ProductInstrumentationSurface } from "@/lib/product-instrumentation";

/**
 * One place every Tier-0 surface reports the age and health of its data.
 *
 * The surfaces used to each answer "how old is this?" differently, or not at
 * all. Silence is the worst of those answers because it reads as "current", so
 * the frame renders a reading for whichever surface is active and a surface
 * that has reported nothing is shown as unknown rather than omitted.
 *
 * Deliberately a report, not a fetch. The surface already knows its query
 * state; duplicating the fetch here would create a second source of truth about
 * freshness, which is the exact class of bug this replaces.
 */
export interface TierZeroFreshnessReport {
  surface: ProductInstrumentationSurface;
  state: TierZeroFreshnessState;
  asOf: string | null;
  errorCode?: string | null;
  partialReason?: string | null;
  businessId?: string | null;
  /** Set when the surface can genuinely re-run its own read. */
  retryKey?: string | null;
}

interface TierZeroFreshnessStore {
  active: TierZeroFreshnessReport | null;
  retryHandlers: Record<string, () => void>;
  report: (report: TierZeroFreshnessReport) => void;
  clear: (surface: ProductInstrumentationSurface) => void;
  registerRetry: (key: string, handler: () => void) => void;
  runRetry: (key: string) => void;
}

export const useTierZeroFreshnessStore = create<TierZeroFreshnessStore>(
  (set, get) => ({
    active: null,
    retryHandlers: {},
    report: (report) => set({ active: report }),
    clear: (surface) =>
      set((state) =>
        state.active?.surface === surface ? { active: null } : state,
      ),
    registerRetry: (key, handler) =>
      set((state) => ({
        retryHandlers: { ...state.retryHandlers, [key]: handler },
      })),
    // A retry button that does nothing is worse than no button: it tells the
    // operator the system is trying when it is not.
    runRetry: (key) => {
      const handler = get().retryHandlers[key];
      if (handler) handler();
    },
  }),
);
