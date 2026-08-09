"use client";

import { TierZeroFreshness } from "@/components/states/TierZeroFreshness";
import type { TierZeroFreshnessReport } from "@/store/tier-zero-freshness-store";
import { useTierZeroFreshnessStore } from "@/store/tier-zero-freshness-store";

/**
 * What the bar shows for a given report.
 *
 * Split out from the component because the component cannot be observed in a
 * server render: this store is client state, and zustand hands server renders
 * the *initial* state, so `renderToStaticMarkup` would report "nothing active"
 * no matter what was reported. Testing the component under SSR would pass
 * without proving anything. The mapping is the part with decisions in it, so
 * the mapping is what gets tested.
 */
export function tierZeroFreshnessBarProps(
  active: TierZeroFreshnessReport | null,
  runRetry: (key: string) => void,
) {
  if (!active) return null;
  return {
    state: active.state,
    asOf: active.asOf,
    errorCode: active.errorCode ?? null,
    partialReason: active.partialReason ?? null,
    businessId: active.businessId ?? null,
    surface: active.surface,
    // Only offer a retry when the surface registered one it can actually run.
    onRetry: active.retryKey
      ? () => runRetry(active.retryKey as string)
      : undefined,
  };
}

/**
 * Renders the active Tier-0 surface's freshness, wherever the operator is.
 *
 * Mounted once in the console frame rather than pasted into ten pages, so the
 * wording and the rules cannot drift apart per surface. A surface that has not
 * reported renders nothing here and states its own age locally; a surface that
 * has reported gets the one shared contract.
 */
export function TierZeroFreshnessBar() {
  const active = useTierZeroFreshnessStore((store) => store.active);
  const runRetry = useTierZeroFreshnessStore((store) => store.runRetry);
  const props = tierZeroFreshnessBarProps(active, runRetry);
  if (!props) return null;

  return (
    <div data-testid="tier-zero-freshness" className="min-w-0">
      <TierZeroFreshness {...props} />
    </div>
  );
}
