import type { IntegrationProvider } from "@/store/integrations-store";
import type { ProviderAccountSnapshotMeta } from "@/lib/provider-account-snapshots";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";

interface ProviderAccountPayloadRow {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  isManager?: boolean;
  assigned?: boolean;
}

interface ProviderAccountsPayload {
  error?: string;
  data?: ProviderAccountPayloadRow[];
  message?: string;
  notice?: string;
  meta?: ProviderAccountSnapshotMeta;
}

export interface ProviderAccountSnapshot {
  accounts: Array<{
    id: string;
    name: string;
    currency?: string;
    timezone?: string;
    isManager?: boolean;
  }>;
  assignedAccountIds: string[];
  meta: ProviderAccountSnapshotMeta | null;
  notice: string | null;
}

const CLIENT_REFRESH_COOLDOWN_MS = 30_000;
const CLIENT_PREWARM_COOLDOWN_MS = 2 * 60_000;

function getClientRequestStore() {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsProviderAccountClientRequests?: Map<string, Promise<ProviderAccountSnapshot>>;
    __omniadsProviderAccountClientFailures?: Map<
      string,
      { failedAt: number; message: string }
    >;
    __omniadsProviderAccountClientPrewarms?: Map<string, number>;
  };
  if (!globalStore.__omniadsProviderAccountClientRequests) {
    globalStore.__omniadsProviderAccountClientRequests = new Map();
  }
  if (!globalStore.__omniadsProviderAccountClientFailures) {
    globalStore.__omniadsProviderAccountClientFailures = new Map();
  }
  if (!globalStore.__omniadsProviderAccountClientPrewarms) {
    globalStore.__omniadsProviderAccountClientPrewarms = new Map();
  }
  return {
    requests: globalStore.__omniadsProviderAccountClientRequests,
    failures: globalStore.__omniadsProviderAccountClientFailures,
    prewarms: globalStore.__omniadsProviderAccountClientPrewarms,
  };
}

function getClientRequestKey(provider: IntegrationProvider, businessId: string, refresh: boolean) {
  return `${provider}:${businessId}:${refresh ? "refresh" : "read"}`;
}

function normalizeProviderAccountSnapshot(payload: ProviderAccountsPayload | null): ProviderAccountSnapshot {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return {
    accounts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      timezone: row.timezone,
      isManager: row.isManager,
    })),
    assignedAccountIds: rows.filter((row) => row.assigned === true).map((row) => row.id),
    meta: payload?.meta ?? null,
    notice: payload?.notice ?? null,
  };
}

export class ProviderAccountSnapshotMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAccountSnapshotMissingError";
  }
}

export function supportsProviderAssignments(provider: IntegrationProvider) {
  return provider === "meta" || provider === "google";
}

export function getProviderAccountsFetchPath(
  provider: IntegrationProvider,
  businessId: string,
) {
  if (provider === "meta") {
    return `/integrations/meta/ad-accounts?businessId=${encodeURIComponent(businessId)}`;
  }
  if (provider === "google") {
    return `/api/google/accessible-accounts?businessId=${encodeURIComponent(businessId)}`;
  }
  return null;
}

export async function fetchProviderAccountSnapshot(
  provider: IntegrationProvider,
  businessId: string,
  options?: { refresh?: boolean },
): Promise<ProviderAccountSnapshot> {
  const path = getProviderAccountsFetchPath(provider, businessId);
  if (!path) {
    return { accounts: [], assignedAccountIds: [], meta: null, notice: null };
  }

  const url = options?.refresh ? `${path}&refresh=1` : path;
  const { requests, failures } = getClientRequestStore();
  const requestKey = getClientRequestKey(provider, businessId, options?.refresh === true);
  const failureKey = `${provider}:${businessId}`;
  const recentFailure = failures.get(failureKey);
  if (options?.refresh && recentFailure) {
    const retryAfterMs = recentFailure.failedAt + CLIENT_REFRESH_COOLDOWN_MS - Date.now();
    if (retryAfterMs > 0) {
      throw new Error(recentFailure.message);
    }
    failures.delete(failureKey);
  }

  const existingRequest = requests.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = (async () => {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as ProviderAccountsPayload | null;

    if (!response.ok) {
      const message =
        payload?.message ?? `Could not load ${provider} account assignments.`;
      if (options?.refresh && (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 429)) {
        failures.set(failureKey, { failedAt: Date.now(), message });
      }
      throw new Error(message);
    }

    failures.delete(failureKey);
    return normalizeProviderAccountSnapshot(payload);
  })().finally(() => {
    requests.delete(requestKey);
  });

  requests.set(requestKey, requestPromise);
  return requestPromise;
}

/**
 * A refresh is a provider call and a snapshot write, so on BOTH providers it is
 * a POST to the accounts endpoint. Never a GET with `refresh=1`.
 *
 * Google's route used to accept `refresh=1` on the GET and silently ignore it,
 * handing back the cached list as if it were current. When that was corrected
 * to a 405 pointing at POST, this client was not moved with it — so every
 * Google "Refresh" press returned 405, the snapshot kept ageing past the
 * 60-minute window that authorises a selection, and account assignment failed
 * with "The account list is out of date" that no amount of refreshing could
 * clear. Meta had already been on POST, which is why only Google broke.
 *
 * Both providers share one verb here so the pair cannot drift apart again.
 */
export async function warmProviderAccountSnapshot(
  provider: IntegrationProvider,
  businessId: string,
): Promise<ProviderAccountSnapshot> {
  const path = getProviderAccountsFetchPath(provider, businessId);
  if (!path) return { accounts: [], assignedAccountIds: [], meta: null, notice: null };

  const response = await fetch(path, {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as ProviderAccountsPayload | null;
  if (!response.ok) {
    throw new Error(payload?.message ?? `Could not refresh ${provider} account assignments.`);
  }
  return normalizeProviderAccountSnapshot(payload);
}

export function prewarmProviderAccountSnapshots(
  businessId: string,
  providers: IntegrationProvider[] = ["meta", "google"],
) {
  const { prewarms } = getClientRequestStore();
  const now = Date.now();

  for (const provider of providers) {
    if (!supportsProviderAssignments(provider)) continue;

    const key = `${provider}:${businessId}`;
    const lastStartedAt = prewarms.get(key) ?? 0;
    if (now - lastStartedAt < CLIENT_PREWARM_COOLDOWN_MS) {
      logClientAuthEvent("provider_snapshot_prewarm_skipped", {
        businessId,
        provider,
        reason: "cooldown",
        retryAfterMs: CLIENT_PREWARM_COOLDOWN_MS - (now - lastStartedAt),
      });
      continue;
    }

    prewarms.set(key, now);
    logClientAuthEvent("provider_snapshot_prewarm_requested", {
      businessId,
      provider,
    });
    void fetchProviderAccountSnapshot(provider, businessId)
      .then((snapshot) => {
        logClientAuthEvent("provider_snapshot_prewarm_succeeded", {
          businessId,
          provider,
          accountCount: snapshot.accounts.length,
          source: snapshot.meta?.source ?? null,
          stale: snapshot.meta?.stale ?? null,
        });
      })
      .catch((error: unknown) => {
        logClientAuthEvent("provider_snapshot_prewarm_failed", {
          businessId,
          provider,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
