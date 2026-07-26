import {
  getProviderAccountAssignments,
  normalizeProviderAccountIds,
  replaceProviderAccountSelection,
  ProviderAccountSelectionError,
} from "@/lib/provider-account-assignments";
import type { IntegrationProviderType } from "@/lib/integrations";
import { normalizeProviderAccountIdentity } from "@/lib/provider-assignment-authorization";
import {
  forceProviderAccountSnapshotRefresh,
  readProviderConnectionGenerationToken,
  type ProviderAccountSnapshotItem,
} from "@/lib/provider-account-snapshots";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";

export type PostConnectScheduleReason =
  | "scheduled"
  | "nothing_selected"
  | "discovery_failed"
  | "no_accessible_selection"
  | "generation_changed"
  | "capacity_refused"
  | "schedule_failed";

export interface PostConnectScheduleResult {
  scheduled: boolean;
  reason: PostConnectScheduleReason;
  /** Accounts that were selected before AND are accessible under the new grant. */
  retainedAccountIds: string[];
  /** Previously selected accounts the new principal cannot see. */
  droppedAccountIds: string[];
  detail: string | null;
  /** True when the caller can safely try again without user action. */
  recoverable: boolean;
}

/**
 * What happens after an OAuth connect or reconnect, in the right order.
 *
 * The callbacks did four things wrong at once. The discovery refresh was
 * `.catch(() => null)`, so a failed discovery was indistinguishable from a
 * successful one. Scheduling then read the OLD canonical selection and enqueued
 * work for it — including accounts the NEW principal cannot see, because a
 * reconnect by a different user keeps the previous selection rows. The enqueue
 * itself was `.catch(() => null)`, so a lane or capacity refusal vanished. And
 * nothing bound any of it to the connection generation the grant produced, so a
 * second reconnect racing the first could schedule under a credential that no
 * longer existed.
 *
 * The order here is the contract:
 *   1. capture the generation this grant produced;
 *   2. AWAIT a real discovery under it — a failure stops everything;
 *   3. intersect the previous selection with what the provider actually
 *      returned, and narrow the canonical selection to that intersection;
 *   4. admit against the lane and fresh capacity;
 *   5. re-check the generation, then enqueue;
 * and at every step a refusal produces zero provider work and a truthful,
 * recoverable result rather than a silent success.
 */
export async function scheduleAfterProviderConnect(input: {
  businessId: string;
  provider: Extract<IntegrationProviderType, "meta" | "google">;
  /** Fetches the accounts this NEW grant can see. */
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  /** Enqueues initial work for the retained selection. */
  enqueue: (input: {
    businessId: string;
    accountIds: string[];
  }) => Promise<void>;
  growthScope: string;
  /**
   * The generation the grant COMMITTED under, taken from the row
   * `upsertIntegration` returned.
   *
   * Read separately, it is a different fact: a second reconnect landing between
   * the grant write and the read would hand this function the newer generation
   * and it would schedule under a credential the grant never had.
   */
  grantConnectionGeneration: string | null;
}): Promise<PostConnectScheduleResult> {
  const empty = { retainedAccountIds: [], droppedAccountIds: [] };

  const grantGeneration = input.grantConnectionGeneration;

  // Also not caught to null: an unreadable selection is not an empty selection.
  const previous = await getProviderAccountAssignments(
    input.businessId,
    input.provider,
  );
  const previousIds = normalizeProviderAccountIds(previous?.account_ids ?? []);

  // 2. A REAL discovery. Awaited, and its failure is terminal for this pass.
  let accessible: ProviderAccountSnapshotItem[];
  try {
    const refreshed = await forceProviderAccountSnapshotRefresh({
      businessId: input.businessId,
      provider: input.provider,
      reason: "oauth_callback_refresh",
      freshnessMs: 6 * 60 * 60_000,
      expectedConnectionGeneration: grantGeneration,
      liveLoader: input.liveLoader,
    });
    accessible = refreshed.accounts;
  } catch (error: unknown) {
    return {
      scheduled: false,
      reason: "discovery_failed",
      ...empty,
      detail: error instanceof Error ? error.message : String(error),
      // The connection itself is saved; the account list can be fetched again.
      recoverable: true,
    };
  }

  // 3. Intersect. A previously selected account the new grant cannot see is
  //    dropped from the selection rather than synced under a credential that
  //    has no access to it.
  const accessibleIdentities = new Set(
    accessible
      .map((account) => normalizeProviderAccountIdentity(input.provider, account.id))
      .filter(Boolean),
  );
  const retained = previousIds.filter((accountId) =>
    accessibleIdentities.has(
      normalizeProviderAccountIdentity(input.provider, accountId),
    ),
  );
  const dropped = previousIds.filter((accountId) => !retained.includes(accountId));

  if (previousIds.length === 0) {
    return {
      scheduled: false,
      reason: "nothing_selected",
      retainedAccountIds: [],
      droppedAccountIds: [],
      detail: "No accounts were selected before this connection.",
      recoverable: false,
    };
  }

  if (dropped.length > 0) {
    // Narrow the canonical selection under the same generation the discovery
    // ran under. A reconnect landing here refuses rather than writing a
    // selection derived from a superseded account list.
    try {
      await replaceProviderAccountSelection({
        businessId: input.businessId,
        provider: input.provider,
        accountIds: retained,
        expectedConnectionGeneration: grantGeneration,
      });
    } catch (error: unknown) {
      if (
        error instanceof ProviderAccountSelectionError &&
        error.code === "connection_generation_changed"
      ) {
        return {
          scheduled: false,
          reason: "generation_changed",
          ...empty,
          detail: error.message,
          recoverable: true,
        };
      }
      return {
        scheduled: false,
        reason: "schedule_failed",
        retainedAccountIds: retained,
        droppedAccountIds: dropped,
        detail: error instanceof Error ? error.message : String(error),
        recoverable: true,
      };
    }
  }

  if (retained.length === 0) {
    // A new principal that shares no accounts with the old selection. Nothing
    // is enqueued and nothing is invented; the user picks accounts explicitly.
    return {
      scheduled: false,
      reason: "no_accessible_selection",
      retainedAccountIds: [],
      droppedAccountIds: dropped,
      detail:
        "None of the previously selected accounts are accessible under the new connection. Select accounts to start syncing.",
      recoverable: false,
    };
  }

  // 4. Lane and fresh capacity, before any enqueue.
  try {
    await assertSyncGrowthBoundary(input.growthScope, { fresh: true });
  } catch (error: unknown) {
    return {
      scheduled: false,
      reason: "capacity_refused",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      detail: describeSyncSafetyRefusal(error)?.kind ??
        (error instanceof Error ? error.message : String(error)),
      recoverable: true,
    };
  }

  // 5. The generation must still be the one this whole decision was made under.
  //
  // NOT caught to null: an authority read that fails is "I cannot tell", and
  // treating that as "no generation" would disable the check exactly when the
  // database is the thing misbehaving.
  const beforeEnqueue = await readProviderConnectionGenerationToken(
    input.businessId,
    input.provider,
  );
  if (beforeEnqueue !== grantGeneration) {
    return {
      scheduled: false,
      reason: "generation_changed",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      detail:
        "The connection changed again before work could be scheduled. Nothing was enqueued.",
      recoverable: true,
    };
  }

  try {
    // The enqueue receives the EXACT retained ids. A callback that ignores them
    // and re-derives its own set from the database is scheduling something this
    // function never decided.
    await input.enqueue({ businessId: input.businessId, accountIds: retained });
  } catch (error: unknown) {
    const refusal = describeSyncSafetyRefusal(error);
    return {
      scheduled: false,
      reason: refusal ? "capacity_refused" : "schedule_failed",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      detail: error instanceof Error ? error.message : String(error),
      recoverable: true,
    };
  }

  return {
    scheduled: true,
    reason: "scheduled",
    retainedAccountIds: retained,
    droppedAccountIds: dropped,
    detail: null,
    recoverable: false,
  };
}
