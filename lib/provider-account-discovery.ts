import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { normalizeProviderAccountIdentity } from "@/lib/provider-assignment-authorization";
import {
  readProviderAccountSnapshot,
  type ProviderAccountSnapshotItem,
  type ProviderAccountSnapshotMeta,
  type ProviderAccountSnapshotResult,
} from "@/lib/provider-account-snapshots";

export interface ProviderDiscoveryRow extends ProviderAccountSnapshotItem {
  assigned: boolean;
}

export interface ProviderDiscoveryPayload {
  data: ProviderDiscoveryRow[];
  meta: ProviderAccountSnapshotMeta;
  notice: string | null;
  /**
   * Selected account ids the provider did NOT report as currently accessible.
   *
   * These used to be appended to `data` with `assigned: true` and a name equal
   * to the id, which laundered an arbitrary or revoked id back into what every
   * caller treats as authoritative provider data — including
   * `toSnapshotResultFromPayload`, which writes it back as a snapshot. A
   * selected id that the provider does not list is a RECONCILIATION problem, and
   * it is reported as one: separate from the account data, never merged into it.
   *
   * Empty is the healthy case. Non-empty means selection and provider truth
   * disagree, which is worth surfacing and is never worth papering over.
   */
  invalidAssignedAccountIds: string[];
}

const DEFAULT_FRESHNESS_MS = 6 * 60 * 60_000;

function buildMeta(input: Partial<ProviderAccountSnapshotMeta>): ProviderAccountSnapshotMeta {
  return {
    source: input.source ?? "snapshot",
    sourceHealth: input.sourceHealth ?? "degraded_blocking",
    fetchedAt: input.fetchedAt ?? null,
    stale: input.stale ?? true,
    refreshFailed: input.refreshFailed ?? false,
    failureClass: input.failureClass ?? null,
    lastError: input.lastError ?? null,
    lastKnownGoodAvailable: input.lastKnownGoodAvailable ?? false,
    refreshRequestedAt: input.refreshRequestedAt ?? null,
    lastRefreshAttemptAt: input.lastRefreshAttemptAt ?? null,
    nextRefreshAfter: input.nextRefreshAfter ?? null,
    retryAfterAt: input.retryAfterAt ?? null,
    refreshInProgress: input.refreshInProgress ?? false,
    sourceReason: input.sourceReason ?? null,
    trustLevel: input.trustLevel,
    trustScore: input.trustScore,
    snapshotAgeHours: input.snapshotAgeHours ?? null,
    lastSuccessfulRefreshAgeHours: input.lastSuccessfulRefreshAgeHours ?? null,
    refreshFailureStreak: input.refreshFailureStreak ?? 0,
  };
}

function buildDiscoveryNotice(input: {
  snapshot: ProviderAccountSnapshotResult;
  degradedNotice: string;
  quotaNotice?: (retryAfterAt: string | null) => string;
}) {
  if (!input.snapshot.meta.refreshFailed) {
    return null;
  }

  if (input.snapshot.meta.failureClass === "quota") {
    return input.quotaNotice?.(input.snapshot.meta.retryAfterAt) ?? input.degradedNotice;
  }

  if (input.snapshot.meta.sourceHealth === "stale_cached") {
    return input.snapshot.meta.trustLevel === "risky"
      ? "Cached accounts are available, but freshness is currently risky."
      : input.degradedNotice;
  }

  return input.degradedNotice;
}

/**
 * Mark which reported accounts are selected, and report which selected ids the
 * provider did not report at all.
 *
 * Comparison is on normalized identity, so `100` and `act_100` are one account
 * rather than one selected account plus one phantom.
 */
export function reconcileAssignments(
  provider: "meta" | "google",
  accounts: ProviderAccountSnapshotItem[],
  assignedIds: string[],
): { rows: ProviderDiscoveryRow[]; invalidAssignedAccountIds: string[] } {
  const canonicalAssigned = new Set(
    assignedIds.map((id) => normalizeProviderAccountIdentity(provider, id)).filter(Boolean),
  );
  const reported = new Set(
    accounts.map((account) => normalizeProviderAccountIdentity(provider, account.id)).filter(Boolean),
  );
  return {
    rows: accounts.map((account) => ({
      ...account,
      assigned: canonicalAssigned.has(
        normalizeProviderAccountIdentity(provider, account.id),
      ),
    })),
    invalidAssignedAccountIds: assignedIds.filter(
      (id) => !reported.has(normalizeProviderAccountIdentity(provider, id)),
    ),
  };
}

export async function resolveProviderDiscoveryPayload(input: {
  businessId: string;
  provider: "meta" | "google";
  refreshRequested: boolean;
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  missingSnapshotNotice: string;
  degradedNotice: string;
  unavailableNotice: string;
  quotaNotice?: (retryAfterAt: string | null) => string;
  freshnessMs?: number;
}): Promise<ProviderDiscoveryPayload> {
  const freshnessMs = input.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const assignmentRow = await getProviderAccountAssignments(input.businessId, input.provider).catch(
    () => null
  );
  const assignedIds = assignmentRow?.account_ids ?? [];

  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs,
  });

  if (snapshot) {
    const reconciled = reconcileAssignments(input.provider, snapshot.accounts, assignedIds);
    // An EMPTY account list with a non-empty selection is the loudest possible
    // disagreement between selection and provider truth. It previously produced
    // a list of synthesized rows that looked exactly like real accounts.
    const notice =
      snapshot.accounts.length === 0 && assignedIds.length > 0 && !snapshot.meta.refreshFailed
        ? input.missingSnapshotNotice
        : buildDiscoveryNotice({
            snapshot,
            degradedNotice: input.degradedNotice,
            quotaNotice: input.quotaNotice,
          });
    return {
      data: reconciled.rows,
      meta: snapshot.meta,
      notice,
      invalidAssignedAccountIds: reconciled.invalidAssignedAccountIds,
    };
  }

  // No snapshot at all. There is no evidence about ANY account, including the
  // selected ones, so there is no account data to return. Reporting a selected
  // id here as `healthy_cached` / `safe` while `stale: true` was the exact
  // combination that made an unverified id look authoritative.
  return {
    data: [],
    meta: buildMeta({
      stale: true,
      sourceHealth: "degraded_blocking",
      lastKnownGoodAvailable: false,
      refreshInProgress: false,
      sourceReason: "initial_snapshot_refresh",
      trustLevel: "blocking",
      trustScore: 0,
    }),
    notice: assignedIds.length > 0 ? input.missingSnapshotNotice : input.unavailableNotice,
    invalidAssignedAccountIds: assignedIds,
  };
}

/**
 * Only rows the provider actually reported become snapshot content.
 *
 * `data` no longer contains synthesized rows, so this can no longer write a
 * selected-but-unverified id back into the snapshot store as though the
 * provider had returned it.
 */
export function toSnapshotResultFromPayload(
  payload: ProviderDiscoveryPayload
): ProviderAccountSnapshotResult {
  return {
    accounts: payload.data.map(({ assigned: _assigned, ...account }) => account),
    meta: payload.meta,
  };
}
