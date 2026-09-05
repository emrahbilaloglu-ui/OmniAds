import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import { runMetaSnapshotForAllBusinesses } from "@/lib/meta/snapshot";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";

export interface MetaSnapshotJobDueResult {
  skipped: boolean;
  reason?: "outside_slot" | "schema_not_ready" | "already_ran";
  snapshotDate: string;
  /** Which of the day's slots this call was about. */
  slot?: number;
  result?: Awaited<ReturnType<typeof runMetaSnapshotForAllBusinesses>>;
}

function snapshotDateFor(now: Date) {
  return now.toISOString().slice(0, 10);
}

/**
 * The two slots a structure snapshot may run in, and why there are two.
 *
 * The native creative path withholds a `cut` whose inputs are older than 12
 * hours. With one 03:00 UTC snapshot, everything produced after 15:00 is
 * already past that threshold — so the freshness rule was refusing decisions
 * for half of every day, not because the evidence was stale in any meaningful
 * sense but because nothing had run since morning. The answer is to produce
 * twice, not to loosen the threshold: the cut-off a decision is about is
 * unchanged, and genuinely stale inputs are still withheld.
 *
 * These are windows, not instants. The cron ticks every ten minutes and a tick
 * can be missed; `=== 3` meant a missed 03:00 tick lost the whole day.
 */
export const META_SNAPSHOT_SLOT_HOURS = [3, 15] as const;

export function metaSnapshotSlotFor(now: Date): number | null {
  const hour = now.getUTCHours();
  // The LATEST slot this hour has reached: at 16:00 the 15 slot is the one
  // that is due, and 03 is only outstanding if it never completed.
  let slot: number | null = null;
  for (const candidate of META_SNAPSHOT_SLOT_HOURS) {
    if (hour >= candidate) slot = candidate;
  }
  return slot;
}

/**
 * Has today's run already covered every business, in every assigned account?
 *
 * The account half is not a refinement — it is what stops a partial run from
 * looking complete. Generation is per assigned account now, so if account A
 * writes campaign and ad-set rows and account B then fails, a business-wide
 * `bool_or` reports the whole business covered and this guard skips the job for
 * the rest of the day. Account B silently gets no snapshot, daily, and the
 * result object says `already_ran`.
 *
 * Coverage is therefore counted per (business, account), and a business is
 * covered only when EVERY currently assigned account is. A business with no
 * assignment is covered by its single unattributed batch, which is what the
 * generator writes for it.
 */
async function alreadyRan(snapshotDate: string) {
  const sql = getDb();
  const coverage = (await sql`
    SELECT
      business_id,
      provider_account_id,
      bool_or(scope_type = 'campaign') AS has_campaign_rows,
      bool_or(scope_type = 'adset') AS has_adset_rows
    FROM meta_decision_snapshots_daily
    WHERE snapshot_date = ${snapshotDate}::date
      AND kind IN ('recommendation', 'anomaly')
      AND engine_version = ${META_RECOMMENDATION_ENGINE_VERSION}
    GROUP BY business_id, provider_account_id
  `) as Array<{
    business_id?: string | null;
    provider_account_id?: string | null;
    has_campaign_rows?: boolean | null;
    has_adset_rows?: boolean | null;
  }>;
  const activeBusinesses = await getActiveBusinesses();
  if (activeBusinesses.length === 0) return true;

  const coveredKeys = new Set(
    coverage
      .filter((row) => row.business_id && row.has_campaign_rows && row.has_adset_rows)
      .map((row) => `${row.business_id}|${row.provider_account_id ?? ""}`),
  );

  for (const business of activeBusinesses) {
    const assignment = await getProviderAccountAssignments(business.id, "meta").catch(
      () => null,
    );
    const accounts = assignment?.account_ids ?? [];
    // No assignment: one unattributed batch is the whole of this business.
    const required = accounts.length > 0 ? accounts : [""];
    for (const account of required) {
      if (!coveredKeys.has(`${business.id}|${account}`)) return false;
    }
  }
  return true;
}

/**
 * Record that this (business, account, day, slot) attempt finished, and how.
 *
 * The source cut-off is the newest source day the run actually read. It is the
 * honest reading and never a high-water mark: if this run saw less than the
 * last one did, that is what it records — the freshness rule is that genuinely
 * new data may move the cut-off forward, and nothing else may.
 */
async function recordSlotRun(input: {
  snapshotDate: string;
  slot: number;
  businessId: string;
  providerAccountId: string;
  status: "success" | "failed";
  /**
   * What this attempt observed of the source, if it observed anything.
   *
   * `{ observed: true, maxDate: null }` is a reading — the source has nothing
   * at or before this day — and it is written. Omitted means the attempt never
   * got a reading, and the stored cut-off is then left alone: erasing the last
   * real observation would make a later freshness check believe the source had
   * never been seen at all.
   */
  source?: { observed: true; maxDate: string | null };
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_structure_snapshot_runs (
      business_id, provider_account_id, as_of_date, slot, status,
      source_max_date, finished_at
    ) VALUES (
      ${input.businessId}, ${input.providerAccountId},
      ${input.snapshotDate}::date, ${input.slot}, ${input.status},
      ${input.source ? input.source.maxDate : null}::date, NOW()
    )
    ON CONFLICT (business_id, provider_account_id, as_of_date, slot)
    DO UPDATE SET status = EXCLUDED.status,
                  source_max_date = CASE
                    WHEN ${input.source !== undefined}::boolean
                      THEN EXCLUDED.source_max_date
                    ELSE meta_structure_snapshot_runs.source_max_date
                  END,
                  finished_at = NOW()
  `.catch(() => null);
}

export async function runMetaSnapshotJobIfDue(
  now = new Date(),
): Promise<MetaSnapshotJobDueResult> {
  const snapshotDate = snapshotDateFor(now);
  const slot = metaSnapshotSlotFor(now);
  if (slot === null) {
    return { skipped: true, reason: "outside_slot", snapshotDate };
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      "meta_decision_snapshots_daily",
      "meta_decision_calibration_daily",
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { skipped: true, reason: "schema_not_ready", snapshotDate };
  }

  /*
    An outstanding EARLIER slot is run first.

    A tick missed at 03:00 must not be lost because the clock has since reached
    15:00: the day's first production is what every downstream freshness check
    is measured against. Whichever slot is chosen, the other stays outstanding
    and the next tick picks it up.
  */
  let dueSlot: number | null = null;
  let missing: Array<{ businessId: string; providerAccountId: string }> = [];
  for (const candidate of META_SNAPSHOT_SLOT_HOURS) {
    if (candidate > slot) break;
    const outstanding = await missingPairsForSlot(snapshotDate, candidate);
    // An unreadable run record returns every pair — run rather than skip. A
    // second run of a slot rewrites the same day's rows; a skipped slot
    // silently produces nothing.
    if (outstanding.length > 0) {
      dueSlot = candidate;
      missing = outstanding;
      break;
    }
  }
  if (dueSlot === null) {
    return { skipped: true, reason: "already_ran", snapshotDate, slot };
  }
  /*
    The second defence, for the FIRST slot only: the rows themselves.

    A day whose rows exist but whose run record does not is exactly what the
    first tick after this ships finds. Stamping the morning slot keeps the
    catch-up from re-running a day that is genuinely complete, without
    inventing a record for a slot that never ran.
  */
  if (dueSlot === META_SNAPSHOT_SLOT_HOURS[0] && (await alreadyRan(snapshotDate))) {
    await markSlotCoveredByExistingRows(snapshotDate, dueSlot);
    return { skipped: true, reason: "already_ran", snapshotDate, slot: dueSlot };
  }

  const result = await runMetaSnapshotForAllBusinesses(snapshotDate, {
    onlyPairs: missing,
  });
  await recordSlotOutcome(snapshotDate, dueSlot, result);
  return { skipped: false, snapshotDate, slot: dueSlot, result };
}

/**
 * The (business, account) pairs this slot still owes.
 *
 * Every currently required pair, minus the ones a SUCCESSFUL run of this exact
 * slot already recorded. An unreadable run table returns everything, because
 * running twice rewrites the same day's rows while skipping produces nothing.
 */
async function missingPairsForSlot(
  snapshotDate: string,
  slot: number,
): Promise<Array<{ businessId: string; providerAccountId: string }>> {
  const required = await requiredPairs();
  const sql = getDb();
  const rows = (await sql`
    SELECT business_id, provider_account_id
    FROM meta_structure_snapshot_runs
    WHERE as_of_date = ${snapshotDate}::date
      AND slot = ${slot}
      AND status = 'success'
  `.catch(() => null)) as Array<{
    business_id: string;
    provider_account_id: string;
  }> | null;
  if (rows === null) return required;
  const done = new Set(
    rows.map((row) => `${row.business_id}|${row.provider_account_id}`),
  );
  return required.filter(
    (pair) => !done.has(`${pair.businessId}|${pair.providerAccountId}`),
  );
}

/**
 * Every (business, account) pair a complete slot has to cover.
 *
 * A business with no assignment is covered by its single unattributed batch,
 * which the generator writes with a null account — `""` here and in the run
 * record, so the two agree about what "covered" means.
 */
async function requiredPairs(): Promise<
  Array<{ businessId: string; providerAccountId: string }>
> {
  const pairs: Array<{ businessId: string; providerAccountId: string }> = [];
  for (const business of await getActiveBusinesses()) {
    const assignment = await getProviderAccountAssignments(business.id, "meta")
      .catch(() => null);
    const accounts = assignment?.account_ids ?? [];
    for (const account of accounts.length > 0 ? accounts : [""]) {
      pairs.push({ businessId: business.id, providerAccountId: account });
    }
  }
  return pairs;
}

/**
 * A day whose rows exist but whose run record does not.
 *
 * It writes no source cut-off. This infers a slot from rows that already
 * exist and has read no warehouse day of its own; stamping one would be a
 * cut-off nobody observed, and it would overwrite a real observation recorded
 * earlier for the same key.
 */
async function markSlotCoveredByExistingRows(snapshotDate: string, slot: number) {
  for (const pair of await requiredPairs()) {
    await recordSlotRun({
      snapshotDate,
      slot,
      businessId: pair.businessId,
      providerAccountId: pair.providerAccountId,
      status: "success",
    });
  }
}

/**
 * Record what THIS attempt did, per (business, account).
 *
 * The previous version asked `meta_decision_snapshots_daily` which pairs had
 * rows for the day and stamped every one of them as this slot's success. Rows
 * written at 03:00 are still there at 15:00, so a failed afternoon run was
 * closed by the morning's own output and its retry suppressed — the exact
 * failure the run record exists to prevent. Nothing is inferred from rows
 * here: a pair is successful because this run said so.
 */
async function recordSlotOutcome(
  snapshotDate: string,
  slot: number,
  result: Awaited<ReturnType<typeof runMetaSnapshotForAllBusinesses>>,
) {
  for (const business of result.results) {
    const outcome = business.status === "fulfilled" ? business.value : null;
    const succeeded = outcome?.succeededAccountIds ?? [];
    const failed = outcome?.failedAccountIds ?? [];
    const observedSourceMaxDates = outcome?.sourceMaxDateByAccountId ?? {};
    for (const account of succeeded) {
      await recordSlotRun({
        snapshotDate, slot, businessId: business.businessId,
        providerAccountId: account, status: "success",
        /*
          The newest source day this account's generation actually READ.

          It used to be `outcome.snapshotDate` — the day the scheduler asked
          for — so the cut-off advanced on every successful slot whether or not
          the warehouse had received a single new day. An account the run
          reported no reading for has no key here, and passing nothing leaves
          the stored cut-off where it was.
        */
        ...(Object.hasOwn(observedSourceMaxDates, account)
          ? {
            source: {
              observed: true as const,
              maxDate: observedSourceMaxDates[account] ?? null,
            },
          }
          : {}),
      });
    }
    /*
      A failed account is recorded as failed, not left silent.

      Either way the pair stays outstanding for this slot — `missingPairsForSlot`
      counts only `success` — but writing the failure is what lets an operator
      see that the slot was attempted and where it stopped.
    */
    for (const account of failed) {
      await recordSlotRun({
        snapshotDate, slot, businessId: business.businessId,
        providerAccountId: account, status: "failed",
      });
    }
    if (business.status === "rejected") {
      // The whole business threw before any account outcome existed.
      for (const pair of (await requiredPairs())
        .filter((entry) => entry.businessId === business.businessId)) {
        await recordSlotRun({
          snapshotDate, slot, businessId: pair.businessId,
          providerAccountId: pair.providerAccountId, status: "failed",
        });
      }
    }
  }
}
