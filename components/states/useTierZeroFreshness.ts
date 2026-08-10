"use client";

import { useEffect } from "react";

import type { TierZeroFreshnessState } from "@/components/states/TierZeroFreshness";
import type { ProductInstrumentationSurface } from "@/lib/product-instrumentation";
import { useTierZeroFreshnessStore } from "@/store/tier-zero-freshness-store";

/**
 * How a Tier-0 surface reports the age and health of its data.
 *
 * One call per surface, derived from the query state it already has. Deriving
 * it here rather than letting each surface invent its own wording is the point:
 * the operator learns one rule and it holds everywhere.
 *
 * `isLoading` deliberately outranks everything: while a first read is in
 * flight, the surface has no figures, and rendering a zero during load is
 * indistinguishable from a real zero to the person reading it.
 */
/**
 * The state a surface is in, given what its query knows.
 *
 * Pure and exported so the ordering can be asserted directly. The order is the
 * whole contract: `isLoading` first because a surface with no data yet must not
 * borrow a reassuring word from any other condition, then `error` because a
 * failed read must not be dressed up as merely stale.
 */
export function deriveTierZeroFreshnessState(input: {
  isLoading: boolean;
  isFetching?: boolean;
  error?: unknown;
  partialReason?: string | null;
}): TierZeroFreshnessState {
  if (input.isLoading) return "loading";
  if (input.error) return "error";
  if (input.partialReason) return "partial";
  if (input.isFetching) return "refreshing";
  return "ready";
}

export function useTierZeroFreshness(input: {
  surface: ProductInstrumentationSurface;
  isLoading: boolean;
  isFetching?: boolean;
  error?: unknown;
  asOf?: string | Date | null;
  partialReason?: string | null;
  businessId?: string | null;
  onRetry?: () => void;
  /** A bounded code. A raw provider message must never reach this. */
  errorCode?: string | null;
}): TierZeroFreshnessState {
  const report = useTierZeroFreshnessStore((store) => store.report);
  const clear = useTierZeroFreshnessStore((store) => store.clear);
  const registerRetry = useTierZeroFreshnessStore(
    (store) => store.registerRetry,
  );

  const state = deriveTierZeroFreshnessState(input);

  const asOf =
    input.asOf instanceof Date
      ? input.asOf.toISOString()
      : (input.asOf ?? null);

  useEffect(() => {
    const retryKey = input.onRetry ? `tier0:${input.surface}` : null;
    if (retryKey && input.onRetry) registerRetry(retryKey, input.onRetry);
    report({
      surface: input.surface,
      state,
      asOf,
      errorCode: input.errorCode ?? (input.error ? "upstream_unavailable" : null),
      partialReason: input.partialReason ?? null,
      businessId: input.businessId ?? null,
      retryKey,
    });
    return () => clear(input.surface);
  }, [
    input.surface,
    state,
    asOf,
    input.errorCode,
    input.partialReason,
    input.businessId,
  ]);

  return state;
}
