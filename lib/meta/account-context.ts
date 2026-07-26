import { getIntegration } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { readThroughCache } from "@/lib/server-cache";

const META_ACCOUNT_CONTEXT_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.META_ACCOUNT_CONTEXT_CACHE_TTL_MS ?? 60_000) || 60_000
);
const META_ACCOUNT_PROFILE_TIMEOUT_MS = 8_000;
const META_CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

export function normalizeMetaCurrencyCode(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return META_CURRENCY_CODE_REGEX.test(currency) ? currency : null;
}

export interface MetaAccountProfileContext {
  currency: string | null;
  timezone: string | null;
  name: string | null;
}

export interface MetaAccountContext {
  businessId: string;
  connected: boolean;
  accessToken: string | null;
  accountIds: string[];
  primaryAccountId: string | null;
  primaryAccountTimezone: string | null;
  currency: string | null;
  accountProfiles: Record<string, MetaAccountProfileContext>;
}

function shouldBypassMetaAccountContextCache() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function buildMetaAccountContextCacheKey(businessId: string) {
  return `meta-account-context:v2:${businessId}`;
}

async function fetchMetaAccountProfile(
  accountId: string,
  accessToken: string
): Promise<MetaAccountProfileContext> {
  try {
    const url = new URL(`https://graph.facebook.com/v25.0/${accountId}`);
    url.searchParams.set("fields", "currency,name,timezone_name");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(META_ACCOUNT_PROFILE_TIMEOUT_MS),
    });
    if (!res.ok) return { currency: null, timezone: null, name: null };
    const json = (await res.json()) as {
      currency?: string;
      name?: string;
      timezone_name?: string;
    };
    return {
      currency: normalizeMetaCurrencyCode(json.currency),
      timezone: json.timezone_name ?? null,
      name: json.name ?? null,
    };
  } catch {
    return { currency: null, timezone: null, name: null };
  }
}

async function loadMetaAccountContext(businessId: string): Promise<MetaAccountContext> {
  const [integration, assignments, snapshot] = await Promise.all([
    getIntegration(businessId, "meta").catch(() => null),
    getProviderAccountAssignments(businessId, "meta").catch(() => null),
    readProviderAccountSnapshot({
      businessId,
      provider: "meta",
    }).catch(() => null),
  ]);

  const accessToken = integration?.access_token ?? null;
  const connected = integration?.status === "connected";
  const accountIds = assignments?.account_ids ?? [];
  const snapshotProfiles = new Map(
    (snapshot?.accounts ?? []).map((account) => [
      account.id,
      {
        currency: normalizeMetaCurrencyCode(account.currency),
        timezone: account.timezone ?? null,
        name: account.name ?? null,
      } satisfies MetaAccountProfileContext,
    ])
  );

  const accountProfiles = Object.fromEntries(
    await Promise.all(
      accountIds.map(async (accountId) => {
        const snapshotProfile = snapshotProfiles.get(accountId);
        if (
          snapshotProfile?.currency &&
          (snapshotProfile.timezone || snapshotProfile.name)
        ) {
          return [accountId, snapshotProfile] as const;
        }
        // A disconnected integration keeps its credential row. Enriching from
        // the live API here would keep calling Meta for a workspace the user
        // has disconnected, so fall back to whatever the snapshot already knows.
        if (!accessToken || !connected) {
          return [
            accountId,
            snapshotProfile ?? {
              currency: null,
              timezone: null,
              name: null,
            },
          ] as const;
        }
        const liveProfile = await fetchMetaAccountProfile(accountId, accessToken);
        return [
          accountId,
          {
            currency: liveProfile.currency ?? snapshotProfile?.currency ?? null,
            timezone: liveProfile.timezone ?? snapshotProfile?.timezone ?? null,
            name: liveProfile.name ?? snapshotProfile?.name ?? null,
          },
        ] as const;
      })
    )
  );

  const primaryAccountId = accountIds[0] ?? null;
  const primaryAccountTimezone =
    primaryAccountId && accountProfiles[primaryAccountId]?.timezone
      ? accountProfiles[primaryAccountId].timezone
      : null;

  return {
    businessId,
    connected: integration?.status === "connected",
    accessToken,
    accountIds,
    primaryAccountId,
    primaryAccountTimezone,
    currency: primaryAccountId
      ? accountProfiles[primaryAccountId]?.currency ?? null
      : null,
    accountProfiles,
  };
}

/**
 * Uncached authority check for one account, for use at a work-unit boundary.
 *
 * `getMetaAccountContext` is memoised for up to a minute and a long batch
 * resolves credentials once, so a deselection or disconnect made during the
 * batch would otherwise stay invisible and the worker would keep fetching a
 * revoked account. This reads the SAME two sources `loadMetaAccountContext`
 * reads — connection status and the selected binding — so the batch gate and
 * the unit gate cannot diverge.
 *
 * Fails closed: any read error means "not authorised".
 */
/**
 * Three outcomes, because two are not enough.
 *
 * `confirmed_revoked` means the authority sources were READ and they say the
 * account is not authorised. `unknown_error` means they could not be read at
 * all — a database outage, a schema that is mid-migration, a timeout. Those are
 * opposite situations that a boolean collapsed into the same `false`, and the
 * caller then cancelled valid partitions terminally because a database was
 * briefly unreachable.
 */
export type MetaAccountAuthorityState =
  | "authorized"
  | "confirmed_revoked"
  | "unknown_error";

export interface MetaAccountAuthorityDecision {
  state: MetaAccountAuthorityState;
  /** Present only for unknown_error, for logs and for the requeue reason. */
  errorMessage: string | null;
}

export async function resolveMetaAccountAuthority(
  businessId: string,
  providerAccountId: string,
): Promise<MetaAccountAuthorityDecision> {
  try {
    const [integration, assignments] = await Promise.all([
      getIntegration(businessId, "meta"),
      getProviderAccountAssignments(businessId, "meta"),
    ]);
    if (integration?.status !== "connected" || !integration.access_token) {
      return { state: "confirmed_revoked", errorMessage: null };
    }
    return (assignments?.account_ids ?? []).includes(providerAccountId)
      ? { state: "authorized", errorMessage: null }
      : { state: "confirmed_revoked", errorMessage: null };
  } catch (error) {
    // Still fails closed — the caller must not proceed — but it fails closed as
    // "I could not tell", which is requeueable, not as "revoked", which is
    // terminal.
    return {
      state: "unknown_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Boolean form, kept for callers that genuinely only need "may I proceed".
 *
 * It answers false for BOTH revocation and uncertainty, so it must never be
 * used to decide whether to cancel anything.
 */
export async function isMetaAccountStillAuthorized(
  businessId: string,
  providerAccountId: string
): Promise<boolean> {
  const decision = await resolveMetaAccountAuthority(businessId, providerAccountId);
  return decision.state === "authorized";
}

export async function getMetaAccountContext(
  businessId: string
): Promise<MetaAccountContext> {
  if (shouldBypassMetaAccountContextCache()) {
    return loadMetaAccountContext(businessId);
  }

  return readThroughCache({
    key: buildMetaAccountContextCacheKey(businessId),
    ttlMs: META_ACCOUNT_CONTEXT_CACHE_TTL_MS,
    loader: () => loadMetaAccountContext(businessId),
  });
}
