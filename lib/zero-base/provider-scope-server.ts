import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  readProviderAccountSnapshot,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";
import type { IntegrationProviderType } from "@/lib/integrations";
import { sameMetaAccount } from "@/lib/meta/provider-account-param";

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
 * Why no account resolved — the three cases `null` used to flatten into one.
 *
 * `resolveProviderAccountId` answers `null` for a business with no assigned
 * account, for a business with several and no choice made, and for a request
 * naming an account this business does not have. Those call for three different
 * things from the operator — connect one, choose one, and "that link is not
 * yours" — and a surface handed a bare `null` could only offer the same dead
 * end for all three. That is the `account_required` dead-end WP4 removes, and
 * these codes are the §9.1 failure-code vocabulary for it.
 */
export type ProviderScopeRefusal =
  /** Nothing is assigned. The operator must assign an account first. */
  | "provider_account_none_assigned"
  /** Several are assigned and none was chosen. The picker can fix this. */
  | "account_required"
  /** An id was requested that this business is not assigned. Never falls back. */
  | "provider_account_not_assigned";

export type ProviderScopeResolution =
  | { providerAccountId: string; refusal: null; requestedButUnassigned: null }
  | {
      providerAccountId: null;
      refusal: ProviderScopeRefusal;
      /** The rejected id, for a message that can name it. Never used as scope. */
      requestedButUnassigned: string | null;
    };

/** Matching rule per provider. Meta spellings differ across its own edges. */
function accountMatches(
  provider: "meta" | "google",
  candidate: string,
  requested: string,
): boolean {
  return provider === "meta"
    ? sameMetaAccount(candidate, requested)
    : candidate === requested;
}

/**
 * Resolve an account requested by a URL without widening business scope, and
 * say why when none resolves.
 *
 * One assigned account is selected automatically; several require an explicit
 * choice and are never auto-picked. An unassigned requested id is refused and
 * never silently replaced by another account the business does have — a silent
 * fallback would answer a question about account A with account B's data.
 *
 * For Meta, `act_123` and `123` are compared as the same account (§7.2).
 * Meta returns both spellings from different edges, so a raw string comparison
 * made a correctly-assigned account fail to match itself, and the surface
 * refused for a selection that was in the URL all along. The id returned is
 * always the CATALOG's spelling, so everything downstream — cache keys, query
 * parameters, receipts — agrees on one form.
 */
export async function resolveProviderAccountScope(input: {
  businessId: string;
  provider: "meta" | "google";
  requestedAccountId?: string | null;
  /**
   * Reuse an already-authorized catalog when the route also needs account
   * presentation metadata. This keeps identity and the chosen id on one
   * assignment snapshot instead of racing two independent reads.
   */
  catalog?: ProviderScopeCatalog;
}): Promise<ProviderScopeResolution> {
  const catalog =
    input.catalog?.provider === input.provider
      ? input.catalog
      : await readProviderScopeCatalog(input.businessId, input.provider);
  const requested = input.requestedAccountId?.trim() || null;

  if (requested) {
    const match = catalog.accounts.find((account) =>
      accountMatches(input.provider, account.id, requested),
    );
    if (match) {
      // The catalog's spelling, not the caller's.
      return { providerAccountId: match.id, refusal: null, requestedButUnassigned: null };
    }
    return {
      providerAccountId: null,
      refusal: "provider_account_not_assigned",
      requestedButUnassigned: requested,
    };
  }

  if (catalog.accounts.length === 1) {
    return {
      providerAccountId: catalog.accounts[0]!.id,
      refusal: null,
      requestedButUnassigned: null,
    };
  }
  return {
    providerAccountId: null,
    refusal:
      catalog.accounts.length === 0
        ? "provider_account_none_assigned"
        : "account_required",
    requestedButUnassigned: null,
  };
}

/**
 * The id alone, for callers that only need the scope.
 *
 * Kept as the common case so every existing caller keeps working unchanged.
 * A caller that needs to explain the refusal calls `resolveProviderAccountScope`
 * instead — the two share one implementation, so they cannot disagree.
 */
export async function resolveProviderAccountId(input: {
  businessId: string;
  provider: "meta" | "google";
  requestedAccountId?: string | null;
  catalog?: ProviderScopeCatalog;
}): Promise<string | null> {
  return (await resolveProviderAccountScope(input)).providerAccountId;
}
