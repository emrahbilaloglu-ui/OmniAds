import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import type { IntegrationProvider, ProviderDomainState } from "@/store/integrations-store";
export type WorkspaceRole = "admin" | "collaborator" | "guest";

export async function fetchSettingsAccount() {
  const response = await fetch("/api/settings/account", { cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as
    | {
        user?: {
          name?: string;
          email?: string;
          language?: "en" | "tr";
          createdAt?: string;
        };
        message?: string;
      }
    | null;
  if (!response.ok || !payload?.user) {
    throw new Error(payload?.message ?? "Could not load account settings.");
  }
  return payload.user;
}

/**
 * Provider health for the Settings surface.
 *
 * Settings used to judge health from the account-list snapshot alone, so a
 * revoked token could read "Healthy" here while Integrations showed action
 * required for the same provider at the same moment. Both surfaces now project
 * this one derivation, so they cannot disagree.
 */
export function projectProviderHealth(
  domains: Record<IntegrationProvider, ProviderDomainState> | undefined,
  providers: readonly IntegrationProvider[] = ["meta", "google"],
): Record<string, { label: string; value: string }> {
  const resolved = domains ?? buildDefaultProviderDomains();
  const health: Record<string, { label: string; value: string }> = {};
  for (const provider of providers) {
    const view = deriveProviderViewState(provider, resolved[provider]);
    health[provider] = {
      label: view.statusLabel,
      value: view.errorMessage ?? view.notice ?? view.assignedSummary,
    };
  }
  return health;
}
