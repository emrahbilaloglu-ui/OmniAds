import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type { IntegrationProviderType } from "@/lib/integrations";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";

/**
 * Authorization for provider account-selection mutation.
 *
 * The two assign-accounts routes took a business UUID from the path and acted on
 * it. `proxy.ts` establishes only that SOME session cookie exists; it never binds
 * that session to the business in the path. So any authenticated user who knew or
 * guessed another tenant's business id could rewrite that tenant's selected
 * accounts — and on the Meta side trigger an initial sync against them.
 *
 * Selection is not a preference. It decides which accounts every lane reads and
 * writes, so this is the authorization boundary for the whole selection
 * contract. It is centralised here so a third route cannot be added without it.
 *
 * Two separate obligations, both required before any mutation:
 *
 *  1. the caller must hold an ACTIVE membership on THIS business with at least
 *     collaborator rights (guests read; they do not re-point the account set);
 *  2. every requested account id must appear in an acceptably fresh
 *     provider-account snapshot for that same business, compared on normalized
 *     identity. Otherwise a caller could bind an arbitrary — or another
 *     tenant's — provider account id to their own business.
 */

/**
 * Selection mutation is a collaborator action. Guests can see which accounts are
 * selected; changing them re-points every downstream lane.
 */
export const ASSIGNMENT_MUTATION_MIN_ROLE = "collaborator" as const;

/**
 * How stale a provider account snapshot may be and still authorise a selection.
 *
 * Deliberately the same window the Google route already enforced. A longer
 * window would let a revoked account stay selectable; a shorter one would make
 * the page unusable whenever the provider is rate-limiting.
 */
export const ASSIGNMENT_SNAPSHOT_FRESHNESS_MS = 60 * 60_000;

export async function authorizeAssignmentMutation(input: {
  request: NextRequest;
  businessId: string;
}): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const access = await requireBusinessAccess({
    request: input.request,
    businessId: input.businessId,
    minRole: ASSIGNMENT_MUTATION_MIN_ROLE,
  });
  if ("error" in access) return { ok: false, response: access.error };
  return { ok: true };
}

/**
 * Canonical comparison form for a provider account id.
 *
 * Meta writes `act_123` into snapshots but accepts `123` from a client, and a
 * copy-pasted id often carries whitespace. Comparing raw strings would reject
 * legitimate input and — worse — could accept two spellings of one account as
 * two different accounts.
 */
export function normalizeProviderAccountIdentity(
  provider: IntegrationProviderType,
  accountId: string,
): string {
  const trimmed = String(accountId ?? "").trim();
  if (!trimmed) return "";
  if (provider === "meta") {
    const bare = trimmed.startsWith("act_") ? trimmed.slice(4) : trimmed;
    return bare ? `act_${bare}` : "";
  }
  return trimmed;
}

export type AssignmentSelectionRefusal =
  | { kind: "snapshot_missing" }
  | { kind: "unknown_accounts"; invalidIds: string[]; snapshotCount: number };

/**
 * Validate a requested selection against the account set the provider actually
 * reported for THIS business.
 *
 * Fails closed in both directions: no acceptable snapshot means no selection can
 * be authorised, and any id outside the snapshot rejects the whole request
 * rather than silently dropping the unknown entries.
 */
export async function validateRequestedProviderAccounts(input: {
  businessId: string;
  provider: IntegrationProviderType;
  requestedIds: readonly string[];
  freshnessMs?: number;
}): Promise<{ ok: true; snapshotCount: number } | { ok: false; refusal: AssignmentSelectionRefusal }> {
  // An empty selection is a deselect-everything, which needs no account to
  // exist — but it still needs the authorization above, which has already run.
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs ?? ASSIGNMENT_SNAPSHOT_FRESHNESS_MS,
  });
  if (!snapshot) {
    return { ok: false, refusal: { kind: "snapshot_missing" } };
  }

  const known = new Set(
    snapshot.accounts
      .map((account) => normalizeProviderAccountIdentity(input.provider, account.id))
      .filter(Boolean),
  );
  const invalidIds = input.requestedIds.filter(
    (id) => !known.has(normalizeProviderAccountIdentity(input.provider, id)),
  );
  if (invalidIds.length > 0) {
    return {
      ok: false,
      refusal: {
        kind: "unknown_accounts",
        invalidIds,
        snapshotCount: snapshot.accounts.length,
      },
    };
  }
  return { ok: true, snapshotCount: snapshot.accounts.length };
}
