import { useAppStore } from "@/store/app-store";
import { CURRENCY_SYMBOLS, resolveCurrencySymbol } from "@/hooks/currency-support";

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
