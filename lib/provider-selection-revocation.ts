import { getDb, runDbTransaction } from "@/lib/db";
import type { IntegrationProviderType } from "@/lib/integrations";
import { PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE } from "@/lib/provider-account-assignments";

/**
 * Deselect everything, as a safety action.
 *
 * "Stop using my accounts" is the one selection change that must always be
 * available. Routing it through the ordinary assignment path made it fail
 * closed for the same reasons a NEW selection should: a missing, disconnected or
 * expired integration, a stale discovery snapshot, a disabled lane. Every one of
 * those is a state in which a user is MORE likely to want to revoke, not less —
 * and refusing leaves the product syncing accounts the owner has asked it to
 * stop touching.
 *
 * So revocation gets its own path, and the thing that makes it safe to exempt
 * from those guards is that it can only ever REDUCE authority:
 *
 *  - it sets `is_selected = FALSE` and nothing else. There is no code path here
 *    that can set it TRUE, insert a binding, or change which provider account a
 *    binding points at;
 *  - it makes no provider call and enqueues no work;
 *  - it cancels queued work that has not started, so revocation takes effect
 *    now rather than after the queue drains;
 *  - it runs in one transaction under the same advisory locks ordinary
 *    selection takes, so it cannot interleave with a concurrent replacement.
 *
 * A NON-empty selection is not this. Adding or changing an account is an
 * increase in authority and stays behind every normal rule.
 */

export interface ProviderSelectionRevocationResult {
  businessId: string;
  provider: IntegrationProviderType;
  /** Bindings that were selected and are not any more. */
  deselected: string[];
  /** Queued, unstarted partitions cancelled so revocation takes effect now. */
  cancelledPartitions: number;
  /** Bindings still selected afterwards. Must always be empty. */
  remainingSelected: string[];
}

const PARTITION_TABLE: Partial<Record<IntegrationProviderType, string>> = {
  meta: "meta_sync_partitions",
  google: "google_ads_sync_partitions",
};

export async function revokeAllProviderAccountSelection(input: {
  businessId: string;
  provider: IntegrationProviderType;
}): Promise<ProviderSelectionRevocationResult> {
  return runDbTransaction(async () => {
    const sql = getDb();
    // The same two locks, in the same order, that replaceProviderAccountSelection
    // takes — so a revocation and a concurrent replacement serialise instead of
    // interleaving into a half-applied selection.
    await sql`
      SELECT pg_advisory_xact_lock_shared(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${`provider_account_selection:${input.provider}`})
      )
    `;
    await sql`
      SELECT pg_advisory_xact_lock(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${`provider_account_selection:${input.provider}:${input.businessId}`})
      )
    `;

    // Deselect, never delete: the binding is the identity historical attribution
    // resolves through, and removing it would orphan past facts.
    const deselected = (await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE, updated_at = now()
      WHERE business_id = ${input.businessId}
        AND provider = ${input.provider}
        AND is_selected
      RETURNING provider_account_id
    `) as Array<{ provider_account_id: string }>;

    // Cancel work that has not started. Leased and running partitions are left
    // alone deliberately: something is mid-flight on them, and yanking the row
    // out from under a live worker is how two writers end up disagreeing about
    // one partition. They finish, and nothing new is queued behind them.
    let cancelledPartitions = 0;
    const partitionTable = PARTITION_TABLE[input.provider];
    if (partitionTable) {
      const cancelled = (await sql.query(
        `UPDATE ${partitionTable}
         SET status = 'cancelled', updated_at = now()
         WHERE business_id = $1
           AND status = 'queued'
         RETURNING id`,
        [input.businessId],
      )) as Array<{ id: string }>;
      cancelledPartitions = cancelled.length;
    }

    // Exact readback inside the transaction. "We deselected everything" is only
    // true if nothing is selected afterwards.
    const remaining = (await sql`
      SELECT provider_account_id
      FROM business_provider_accounts
      WHERE business_id = ${input.businessId}
        AND provider = ${input.provider}
        AND is_selected
    `) as Array<{ provider_account_id: string }>;
    if (remaining.length > 0) {
      throw new Error(
        `Revocation readback failed: ${remaining.length} account(s) are still selected.`,
      );
    }

    return {
      businessId: input.businessId,
      provider: input.provider,
      deselected: deselected.map((row) => row.provider_account_id),
      cancelledPartitions,
      remainingSelected: [],
    };
  });
}
