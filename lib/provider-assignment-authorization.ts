import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegration, type IntegrationProviderType, type IntegrationRow } from "@/lib/integrations";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { computeProviderConnectionFingerprint } from "@/lib/provider-connection-fingerprint";

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
 * The most accounts one business may select at once.
 *
 * Meta accepted an unbounded array of unbounded strings. A bound is not a
 * usability limit — nobody manages 200 ad accounts from one business — it is
 * what stops a single request from allocating unbounded work downstream.
 */
export const MAX_SELECTED_ACCOUNTS = 100;
export const MAX_ACCOUNT_ID_LENGTH = 64;

/** Provider-specific shape for a canonical account id. */
const ACCOUNT_ID_PATTERN: Partial<Record<IntegrationProviderType, RegExp>> = {
  meta: /^act_[0-9]{1,32}$/,
  google: /^[0-9-]{1,32}$/,
};

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

export { computeProviderConnectionFingerprint };

export type ProviderConnectionRefusal =
  | "integration_not_found"
  | "not_connected"
  | "credential_missing"
  | "credential_expired";

export interface ProviderConnectionAuthority {
  integration: IntegrationRow;
  connectionFingerprint: string;
}

/**
 * Current, usable connection — not merely "a row exists".
 *
 * Both assignment handlers checked only that `getIntegration` returned
 * something. A disconnected integration, one whose credential had been cleared,
 * and one whose token expired last month all passed that check and went on to
 * write canonical selection and start work.
 */
export async function resolveProviderConnectionAuthority(input: {
  businessId: string;
  provider: IntegrationProviderType;
  nowMs?: number;
}): Promise<
  { ok: true; authority: ProviderConnectionAuthority } | { ok: false; reason: ProviderConnectionRefusal }
> {
  const integration = await getIntegration(input.businessId, input.provider);
  if (!integration) return { ok: false, reason: "integration_not_found" };
  if (integration.status !== "connected") return { ok: false, reason: "not_connected" };
  if (!integration.access_token) return { ok: false, reason: "credential_missing" };
  if (integration.token_expires_at) {
    const expiresAt = Date.parse(integration.token_expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= (input.nowMs ?? Date.now())) {
      return { ok: false, reason: "credential_expired" };
    }
  }
  return {
    ok: true,
    authority: {
      integration,
      connectionFingerprint: computeProviderConnectionFingerprint(integration),
    },
  };
}

export type AssignmentSelectionRefusal =
  | { kind: "snapshot_missing" }
  | { kind: "snapshot_not_fresh"; detail: string }
  | { kind: "snapshot_connection_mismatch" }
  | { kind: "too_many_accounts"; requested: number; limit: number }
  | { kind: "malformed_account_id"; invalidIds: string[] }
  | { kind: "ambiguous_account_ids"; collisions: string[] }
  | { kind: "unknown_accounts"; invalidIds: string[]; snapshotCount: number };

/**
 * Validate a requested selection against the account set the provider actually
 * reported for THIS business, under THIS connection generation.
 *
 * Returns the CANONICAL ids from the snapshot, not the caller's spelling. The
 * writer persists exactly what comes back, so a request for `100` against a
 * snapshot that reported `act_100` stores `act_100` — not a second, noncanonical
 * identity for the same real account.
 *
 * Fails closed in every direction: no snapshot, a stale or failed snapshot, a
 * snapshot from a superseded credential, an oversized request, a malformed id,
 * two spellings of one account, or any id outside the snapshot.
 */
export async function validateRequestedProviderAccounts(input: {
  businessId: string;
  provider: IntegrationProviderType;
  requestedIds: readonly string[];
  connectionFingerprint: string;
  freshnessMs?: number;
}): Promise<
  | { ok: true; canonicalIds: string[]; snapshotCount: number }
  | { ok: false; refusal: AssignmentSelectionRefusal }
> {
  if (input.requestedIds.length > MAX_SELECTED_ACCOUNTS) {
    return {
      ok: false,
      refusal: {
        kind: "too_many_accounts",
        requested: input.requestedIds.length,
        limit: MAX_SELECTED_ACCOUNTS,
      },
    };
  }

  const pattern = ACCOUNT_ID_PATTERN[input.provider];
  const malformed = input.requestedIds.filter((id) => {
    const canonical = normalizeProviderAccountIdentity(input.provider, id);
    if (!canonical || canonical.length > MAX_ACCOUNT_ID_LENGTH) return true;
    return pattern ? !pattern.test(canonical) : false;
  });
  if (malformed.length > 0) {
    return { ok: false, refusal: { kind: "malformed_account_id", invalidIds: malformed } };
  }

  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs ?? ASSIGNMENT_SNAPSHOT_FRESHNESS_MS,
  });
  if (!snapshot) {
    return { ok: false, refusal: { kind: "snapshot_missing" } };
  }
  // Stale, failed and degraded snapshots are BLOCKING, not metadata. A cached
  // list from before a revocation is exactly the evidence that must not
  // authorise a new selection.
  if (snapshot.meta.stale || snapshot.meta.refreshFailed) {
    return {
      ok: false,
      refusal: {
        kind: "snapshot_not_fresh",
        detail: `stale=${snapshot.meta.stale} refreshFailed=${snapshot.meta.refreshFailed} health=${snapshot.meta.sourceHealth}`,
      },
    };
  }
  if (
    snapshot.meta.connectionFingerprint == null ||
    snapshot.meta.connectionFingerprint !== input.connectionFingerprint
  ) {
    // Captured under a different credential generation — a disconnect,
    // reconnect, rotation or owner change since. Its timestamp says nothing
    // about what the CURRENT credential can reach.
    return { ok: false, refusal: { kind: "snapshot_connection_mismatch" } };
  }

  const canonicalByIdentity = new Map<string, string>();
  for (const account of snapshot.accounts) {
    const canonical = normalizeProviderAccountIdentity(input.provider, account.id);
    if (canonical) canonicalByIdentity.set(canonical, account.id.trim());
  }

  const invalidIds: string[] = [];
  const seen = new Map<string, string[]>();
  const canonicalIds: string[] = [];
  for (const requested of input.requestedIds) {
    const identity = normalizeProviderAccountIdentity(input.provider, requested);
    const authoritative = canonicalByIdentity.get(identity);
    if (!authoritative) {
      invalidIds.push(requested);
      continue;
    }
    const spellings = seen.get(identity);
    if (spellings) {
      spellings.push(requested);
      continue;
    }
    seen.set(identity, [requested]);
    canonicalIds.push(authoritative);
  }

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

  // Two spellings of one account is not a de-duplication problem to solve
  // silently: the request means something the caller did not intend, and
  // guessing which one they meant is how a selection ends up wrong.
  const collisions = [...seen.entries()]
    .filter(([, spellings]) => spellings.length > 1)
    .map(([identity, spellings]) => `${identity} <- ${spellings.join(", ")}`);
  if (collisions.length > 0) {
    return { ok: false, refusal: { kind: "ambiguous_account_ids", collisions } };
  }

  return { ok: true, canonicalIds, snapshotCount: snapshot.accounts.length };
}
