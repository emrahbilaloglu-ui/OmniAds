import {
  getProviderAccountAssignments,
  normalizeProviderAccountIds,
  replaceProviderAccountSelection,
  withProviderAccountSelectionLock,
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
import { withSchedulingAttempt } from "@/lib/sync/scheduling-attempt";

export type PostConnectScheduleReason =
  | "scheduled"
  | "nothing_selected"
  | "discovery_failed"
  | "no_accessible_selection"
  | "generation_changed"
  | "capacity_refused"
  | "schedule_failed"
  /**
   * Every selected account has work that will run, but none of it was created
   * by this connect — a reconnect landing while a sync was already in flight.
   * Distinct from "scheduled" so a log or a support question can tell the two
   * apart; both mean the dashboard will fill in.
   */
  | "already_scheduled";

interface PartitionReceiptRow {
  provider_account_id: string;
  runnable: number;
  this_attempt: number;
}

export interface PostConnectScheduleResult {
  scheduled: boolean;
  reason: PostConnectScheduleReason;
  /** Accounts that were selected before AND are accessible under the new grant. */
  retainedAccountIds: string[];
  /** Previously selected accounts the new principal cannot see. */
  droppedAccountIds: string[];
  /** Partitions created by THIS connect, counted by immutable attempt id. */
  scheduledPartitionCount: number;
  /** Retained accounts whose runnable work predates this connect. */
  preexistingAccountIds: string[];
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
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
      detail: error instanceof Error ? error.message : String(error),
      // The connection itself is saved; the account list can be fetched again.
      recoverable: true,
    };
  }

  // 3. Read the selection, decide from it and write it back — all under the
  //    canonical selection lock.
  //
  // These three steps were separate, so an explicit selection saved by the user
  // in another tab between the read and the narrowing write was silently
  // overwritten by a set computed from a selection that no longer existed. The
  // lock is the same one every other selection writer takes, in the same order,
  // so the two serialise instead of racing.
  //
  // The previous selection is read INSIDE the lock rather than before discovery.
  // Reading it outside would put the provider round trip inside the critical
  // section and still leave the decision based on a pre-lock observation.
  //
  // An unreadable selection is not an empty selection: this read is not caught
  // to null, and the throw escapes the lock and this function unchanged.
  const decided = await withProviderAccountSelectionLock({
    businessId: input.businessId,
    provider: input.provider,
    work: async (): Promise<
      | { ok: true; previousIds: string[]; retained: string[]; dropped: string[] }
      | { ok: false; result: PostConnectScheduleResult }
    > => {
      const previous = await getProviderAccountAssignments(
        input.businessId,
        input.provider,
      );
      const previousIds = normalizeProviderAccountIds(previous?.account_ids ?? []);

      // A previously selected account the new grant cannot see is dropped from
      // the selection rather than synced under a credential with no access.
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
          ok: false,
          result: {
            scheduled: false,
            reason: "nothing_selected",
            retainedAccountIds: [],
            droppedAccountIds: [],
            scheduledPartitionCount: 0,
            preexistingAccountIds: [],
            detail: "No accounts were selected before this connection.",
            recoverable: false,
          },
        };
      }

      if (dropped.length > 0) {
        // Narrow under the same generation the discovery ran under. A reconnect
        // landing here refuses rather than writing a selection derived from a
        // superseded account list.
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
              ok: false,
              result: {
                scheduled: false,
                reason: "generation_changed",
                ...empty,
                scheduledPartitionCount: 0,
                preexistingAccountIds: [],
                detail: error.message,
                recoverable: true,
              },
            };
          }
          return {
            ok: false,
            result: {
              scheduled: false,
              reason: "schedule_failed",
              retainedAccountIds: retained,
              droppedAccountIds: dropped,
              scheduledPartitionCount: 0,
              preexistingAccountIds: [],
              detail: error instanceof Error ? error.message : String(error),
              recoverable: true,
            },
          };
        }
      }

      return { ok: true, previousIds, retained, dropped };
    },
  });

  if (!decided.ok) return decided.result;
  const { retained, dropped } = decided;

  if (retained.length === 0) {
    // A new principal that shares no accounts with the old selection. Nothing
    // is enqueued and nothing is invented; the user picks accounts explicitly.
    return {
      scheduled: false,
      reason: "no_accessible_selection",
      retainedAccountIds: [],
      droppedAccountIds: dropped,
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
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
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
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
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
      detail:
        "The connection changed again before work could be scheduled. Nothing was enqueued.",
      recoverable: true,
    };
  }

  let attemptId: string;
  try {
    // The enqueue receives the EXACT retained ids. A callback that ignores them
    // and re-derives its own set from the database is scheduling something this
    // function never decided.
    //
    // It runs inside a scheduling attempt so every partition it creates carries
    // this attempt's immutable id, which is what the readback below counts.
    const attempt = await withSchedulingAttempt(async () =>
      input.enqueue({ businessId: input.businessId, accountIds: retained }),
    );
    attemptId = attempt.attemptId;
  } catch (error: unknown) {
    const refusal = describeSyncSafetyRefusal(error);
    return {
      scheduled: false,
      reason: refusal ? "capacity_refused" : "schedule_failed",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
      detail: error instanceof Error ? error.message : String(error),
      recoverable: true,
    };
  }

  // 6. Durable readback, scoped to THIS attempt.
  //
  // "The enqueue did not throw" is not "work exists". Both provider enqueues
  // return normally when they decide there is nothing due, when a planner filter
  // drops the whole set, or when every partition they would have created already
  // exists — and the callback then redirected the user with `syncScheduled=1` to
  // a dashboard that never fills in.
  //
  // Two facts, from ONE statement so they describe one instant:
  //   `this_attempt` — partitions carrying THIS attempt's immutable id. Exact:
  //     no clock window, so a concurrent enqueue cannot satisfy it and skew
  //     between the app clock and the database clock cannot break it.
  //   `runnable` — any partition for that account in a state that will still be
  //     worked. This exists so a reconnect during an in-flight sync is not
  //     reported as a failure: this attempt created nothing, and work will
  //     nonetheless run. It is per-account and per-status, so it cannot be
  //     satisfied by unrelated work for a DIFFERENT account the way a
  //     business-wide count could.
  //
  // Success requires every retained account to be covered. The two facts are
  // reported separately rather than summed, so "we scheduled this" and "this was
  // already scheduled" never collapse into the same claim.
  let attemptQueued = 0;
  let runnableTotal = 0;
  let uncovered: string[] = [];
  let coveredByExisting: string[] = [];
  try {
    const { getDb } = await import("@/lib/db");
    const sql = getDb();
    const rows =
      input.provider === "meta"
        ? ((await sql`
            SELECT provider_account_id,
                   COUNT(*)::int AS runnable,
                   COUNT(*) FILTER (
                     WHERE scheduling_attempt_id = ${attemptId}::uuid
                   )::int AS this_attempt
            FROM meta_sync_partitions
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ANY(${retained}::text[])
              AND status IN ('queued', 'leased', 'running')
            GROUP BY provider_account_id
          `) as PartitionReceiptRow[])
        : ((await sql`
            SELECT provider_account_id,
                   COUNT(*)::int AS runnable,
                   COUNT(*) FILTER (
                     WHERE scheduling_attempt_id = ${attemptId}::uuid
                   )::int AS this_attempt
            FROM google_ads_sync_partitions
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ANY(${retained}::text[])
              AND status IN ('queued', 'leased', 'running')
            GROUP BY provider_account_id
          `) as PartitionReceiptRow[]);
    const byAccount = new Map(rows.map((row) => [row.provider_account_id, row]));
    uncovered = retained.filter(
      (accountId) => Number(byAccount.get(accountId)?.runnable ?? 0) === 0,
    );
    coveredByExisting = retained.filter(
      (accountId) =>
        Number(byAccount.get(accountId)?.runnable ?? 0) > 0 &&
        Number(byAccount.get(accountId)?.this_attempt ?? 0) === 0,
    );
    attemptQueued = rows.reduce((total, row) => total + Number(row.this_attempt ?? 0), 0);
    runnableTotal = rows.reduce((total, row) => total + Number(row.runnable ?? 0), 0);
  } catch (error: unknown) {
    // An unreadable receipt is not a receipt. Reporting success here would be
    // the same lie the readback exists to stop, one layer down.
    return {
      scheduled: false,
      reason: "schedule_failed",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      scheduledPartitionCount: 0,
      preexistingAccountIds: [],
      detail: `Work may have been scheduled but could not be confirmed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      recoverable: true,
    };
  }

  if (runnableTotal === 0 || uncovered.length > 0) {
    return {
      scheduled: false,
      reason: "schedule_failed",
      retainedAccountIds: retained,
      droppedAccountIds: dropped,
      scheduledPartitionCount: attemptQueued,
      preexistingAccountIds: coveredByExisting,
      detail:
        runnableTotal === 0
          ? "The connection was saved but no sync work was created."
          : `No sync work exists for ${uncovered.length} of ${retained.length} selected accounts.`,
      recoverable: true,
    };
  }

  return {
    scheduled: true,
    reason: attemptQueued > 0 ? "scheduled" : "already_scheduled",
    retainedAccountIds: retained,
    droppedAccountIds: dropped,
    scheduledPartitionCount: attemptQueued,
    preexistingAccountIds: coveredByExisting,
    detail:
      coveredByExisting.length === 0
        ? null
        : `${coveredByExisting.length} of ${retained.length} selected accounts already had sync work in flight.`,
    recoverable: false,
  };
}
