import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  readProviderAccountSnapshot,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";
import type { IntegrationProviderType } from "@/lib/integrations";

export interface ProviderScopeOption {
  id: string;
  label: string;
  currency: string | null;
  timezone: string | null;
}

export interface ProviderScopeCatalog {
  provider: "meta" | "google";
  accounts: ProviderScopeOption[];
}

function asOption(item: ProviderAccountSnapshotItem): ProviderScopeOption {
  return {
    id: item.id,
    label: item.name?.trim() || item.id,
    currency: item.currency?.trim() || null,
    timezone: item.timezone?.trim() || null,
  };
}

/**
 * Read the accounts the business has explicitly assigned to a provider.
 *
 * The discovery snapshot may contain many accounts the credential can see;
 * only assigned ids are exposed to the workspace picker.  A missing snapshot
 * does not erase a valid assignment: the id remains selectable with its id as
 * the honest fallback label.
 */
export async function readProviderScopeCatalog(
  businessId: string,
  provider: "meta" | "google",
): Promise<ProviderScopeCatalog> {
  const [assignment, snapshot] = await Promise.all([
    getProviderAccountAssignments(businessId, provider as IntegrationProviderType).catch(() => null),
    readProviderAccountSnapshot({ businessId, provider }).catch(() => null),
  ]);
  const assigned = assignment?.account_ids ?? [];
  const discovered = new Map((snapshot?.accounts ?? []).map((account) => [account.id, account]));

  return {
    provider,
    accounts: assigned.map((id) => {
      const item = discovered.get(id);
      return item
        ? asOption(item)
        : { id, label: id, currency: null, timezone: null };
    }),
  };
}

/**
 * Resolve an account requested by a URL without widening business scope.
 * One assigned account is selected automatically; multiple accounts require
 * an explicit selection.  An unassigned requested id is refused.
 */
export async function resolveProviderAccountId(input: {
  businessId: string;
  provider: "meta" | "google";
  requestedAccountId?: string | null;
}): Promise<string | null> {
  const catalog = await readProviderScopeCatalog(input.businessId, input.provider);
  const requested = input.requestedAccountId?.trim() || null;
  if (requested) {
    return catalog.accounts.some((account) => account.id === requested) ? requested : null;
  }
  return catalog.accounts.length === 1 ? catalog.accounts[0]!.id : null;
}
