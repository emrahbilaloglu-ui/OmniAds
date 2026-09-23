import { useAppStore } from "@/store/app-store";
import {
  CURRENCY_SYMBOLS,
  resolveCurrencyCode,
  resolveCurrencySymbol,
} from "@/hooks/currency-support";

/**
 * Use inside React components.
 *
 * `null` means the selected workspace has no configured currency. Callers must
 * render the money value as unavailable in that case; they must not fall back
 * to "$" (INVARIANTS.md: missing currency must not silently become USD or $).
 */
export function useCurrencySymbol(): string | null {
  const businesses = useAppStore((s) => s.businesses);
  const selectedBusinessId = useAppStore((s) => s.selectedBusinessId);
  return resolveCurrencySymbol(businesses, selectedBusinessId);
}

/** Use outside React (e.g. in plain formatter functions). `null` = unknown. */
export function getCurrencySymbol(): string | null {
  const state = useAppStore.getState();
  return resolveCurrencySymbol(state.businesses, state.selectedBusinessId);
}

/**
 * The selected workspace's currency CODE, for callers that need to scale a
 * provider minor-unit amount rather than only label it. `null` = unknown, and
 * the caller must render the amount as unavailable rather than assume a scale.
 */
export function useCurrencyCode(): string | null {
  const businesses = useAppStore((s) => s.businesses);
  const selectedBusinessId = useAppStore((s) => s.selectedBusinessId);
  return resolveCurrencyCode(businesses, selectedBusinessId);
}
