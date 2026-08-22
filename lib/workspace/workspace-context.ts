/**
 * The serializable envelope a server page hands to the client shell.
 *
 * It is deliberately narrow. Everything in it is either identity, scope, or an
 * explicit statement about how much we trust the data — never a metric. Two
 * fields exist purely to stop a familiar class of lie:
 *
 * - `proof.currency` is never `"proven"` just because `business.currency` is
 *   set. A configured currency is a preference; a proven one has been observed
 *   on the provider account.
 * - `evidence.freshness` is `"unknown"` rather than `"fresh"` when we have no
 *   snapshot time, so a stale surface cannot look current by omission.
 */
import type { AppLanguage } from "@/lib/i18n";
import type { MembershipRole } from "@/lib/auth";

export type WorkspaceMode = "agency" | "client" | "ops" | "account";
export type ProviderId = "meta" | "google" | "shopify" | "ga4" | "search_console";
export type ProviderScopeMode = "none" | "single" | "portfolio";
export type EvidenceFreshness = "fresh" | "stale" | "unknown";
export type CurrencyProof = "proven" | "configured-only" | "mixed" | "unknown";
export type TimezoneProof = "aligned" | "missing" | "disagreement" | "unknown";

export type WorkspaceContextEnvelope = {
  actor: {
    userId: string;
    name: string;
    language: AppLanguage;
    membershipRole: MembershipRole | null;
    reviewerReadOnly: boolean;
    demo: boolean;
  };
  mode: WorkspaceMode;
  business: null | {
    id: string;
    /**
     * `null` when the authorized business record could not be read.
     *
     * The two layouts used to fall back to `name: businessId`, which printed a
     * raw UUID in the workspace switcher and passed it off as a workspace name.
     * A name we do not have is not a name: presentation says "select business"
     * / renders the unavailable mark instead of a value that looks like data.
     */
    name: string | null;
    configuredCurrency: string | null;
    businessTimezone: string | null;
  };
  provider: null | {
    id: ProviderId;
    /**
     * What was actually SELECTED. Empty means nothing is selected.
     *
     * It used to be filled with every assigned account whenever no single one
     * had been chosen, so "the operator has not picked an account yet" and
     * "the operator is looking at all of these accounts" became the same value.
     * That is the master plan's D6 ("null: seçilmedi; asla tüm hesaplar
     * değil") and its §17 prohibition 11, and it is the difference between a
     * surface refusing honestly and a surface serving a figure that is the sum
     * of accounts nobody asked about.
     *
     * Use `assignedAccountIds` for "what could be selected".
     */
    selectedAccountIds: string[];
    /**
     * Every account this business has assigned for the provider, whether or not
     * one is selected. This is the picker's option list and the basis for the
     * 0 / 1 / N decision; it is never a scope.
     */
    assignedAccountIds: string[];
    selectedAccountLabel: string | null;
    mode: ProviderScopeMode;
  };
  evidence: {
    windowLabel: string | null;
    snapshotAt: string | null;
    sourceUpdatedAt: string | null;
    freshness: EvidenceFreshness;
  };
  proof: {
    currency: CurrencyProof;
    timezone: TimezoneProof;
  };
  rollout: {
    zeroBaseEnabled: boolean;
    mutationUiEnabled: boolean;
  };
};

/**
 * Derives provider scope from what the server actually validated.
 *
 * A surface with several assigned accounts and no selection is `portfolio`; it
 * is up to the read model to support that or require a selection. It is never
 * `single` by silently picking the first account.
 */
export function resolveProviderScopeMode(selectedAccountIds: readonly string[]): ProviderScopeMode {
  if (selectedAccountIds.length === 0) return "none";
  if (selectedAccountIds.length === 1) return "single";
  return "portfolio";
}

/**
 * A configured currency alone is `configured-only`. `proven` requires the
 * currency to have been observed on the provider account, and a disagreement
 * between the two is `mixed`.
 */
export function resolveCurrencyProof(input: {
  configuredCurrency: string | null;
  observedCurrencies: readonly string[];
}): CurrencyProof {
  const observed = [...new Set(input.observedCurrencies.filter(Boolean))];
  if (observed.length === 0) {
    return input.configuredCurrency ? "configured-only" : "unknown";
  }
  if (observed.length > 1) return "mixed";
  if (!input.configuredCurrency) return "unknown";
  return observed[0] === input.configuredCurrency ? "proven" : "mixed";
}

export function resolveTimezoneProof(input: {
  businessTimezone: string | null;
  accountTimezone: string | null;
}): TimezoneProof {
  if (!input.businessTimezone || !input.accountTimezone) return "missing";
  return input.businessTimezone === input.accountTimezone ? "aligned" : "disagreement";
}

/** Freshness is only claimed when a snapshot time exists to claim it from. */
export function resolveEvidenceFreshness(input: {
  snapshotAt: string | null;
  now: Date;
  staleAfterMinutes?: number;
}): EvidenceFreshness {
  if (!input.snapshotAt) return "unknown";
  const snapshot = Date.parse(input.snapshotAt);
  if (Number.isNaN(snapshot)) return "unknown";
  const ageMinutes = (input.now.getTime() - snapshot) / 60_000;
  if (ageMinutes < 0) return "unknown";
  return ageMinutes <= (input.staleAfterMinutes ?? 24 * 60) ? "fresh" : "stale";
}
