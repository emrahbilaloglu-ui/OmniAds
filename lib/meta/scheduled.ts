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
 * Has this exact slot already succeeded for every business and account?
 *
 * Two questions, and both have to be asked. The run record answers "did the
 * 15:00 slot complete", which the row-coverage query cannot: rows written at
 * 03:00 are still there at 15:00 and would report the day as done. The
 * coverage query answers "are the rows actually there", which the run record
 * cannot: a row-level failure after a successful-looking run would otherwise
 * go unnoticed.
 *
 * An unreadable run record returns `false` — run again rather than skip. A
 * second run of the same slot rewrites the same day's rows; a skipped slot
 * silently produces nothing.
 */
async function slotAlreadyRan(snapshotDate: string, slot: number) {
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
  if (rows === null) return false;

  const activeBusinesses = await getActiveBusinesses();
  if (activeBusinesses.length === 0) return true;
  const done = new Set(
    rows.map((row) => `${row.business_id}|${row.provider_account_id}`),
  );
  for (const business of activeBusinesses) {
    const assignment = await getProviderAccountAssignments(business.id, "meta")
      .catch(() => null);
    const accounts = assignment?.account_ids ?? [];
    const required = accounts.length > 0 ? accounts : [""];
    for (const account of required) {
      if (!done.has(`${business.id}|${account}`)) return false;
    }
  }
  return true;
}

/** Record that this (business, account, day, slot) completed. */
async function recordSlotRun(input: {
  snapshotDate: string;
  slot: number;
  businessId: string;
  providerAccountId: string;
  status: "success" | "failed";
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_structure_snapshot_runs (
      business_id, provider_account_id, as_of_date, slot, status, finished_at
    ) VALUES (
      ${input.businessId}, ${input.providerAccountId},
      ${input.snapshotDate}::date, ${input.slot}, ${input.status}, NOW()
    )
    ON CONFLICT (business_id, provider_account_id, as_of_date, slot)
    DO UPDATE SET status = EXCLUDED.status, finished_at = NOW()
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
    15:00: the day's first production is the one every downstream freshness
    check is measured against. Whichever slot is chosen, the other stays
    outstanding and the next tick picks it up.
  */
  let dueSlot: number | null = null;
  for (const candidate of META_SNAPSHOT_SLOT_HOURS) {
    if (candidate > slot) break;
    if (!(await slotAlreadyRan(snapshotDate, candidate))) {
      dueSlot = candidate;
      break;
    }
  }
  if (dueSlot === null) {
    return { skipped: true, reason: "already_ran", snapshotDate, slot };
  }
  // The second defence: the rows themselves. Kept because a run record that
  // says success and a table with no rows in it disagree, and the rows win.
  if (dueSlot === META_SNAPSHOT_SLOT_HOURS[0] && (await alreadyRan(snapshotDate))) {
    await markSlotCoveredByExistingRows(snapshotDate, dueSlot);
    return { skipped: true, reason: "already_ran", snapshotDate, slot: dueSlot };
  }

  const result = await runMetaSnapshotForAllBusinesses(snapshotDate);
  await recordCompletedSlot(snapshotDate, dueSlot);
  return { skipped: false, snapshotDate, slot: dueSlot, result };
}

/**
 * A day whose rows exist but whose run record does not.
 *
 * The first tick after this ships finds exactly that: rows written by the
 * single-slot job, and an empty run table. Stamping the first slot keeps the
 * catch-up loop from re-running a day that is genuinely complete, without
 * inventing a record for a slot that never ran.
 */
async function markSlotCoveredByExistingRows(snapshotDate: string, slot: number) {
  for (const business of await getActiveBusinesses()) {
    const assignment = await getProviderAccountAssignments(business.id, "meta")
      .catch(() => null);
    for (const account of assignment?.account_ids ?? [""]) {
      await recordSlotRun({
        snapshotDate, slot, businessId: business.id,
        providerAccountId: account, status: "success",
      });
    }
  }
}

async function recordCompletedSlot(snapshotDate: string, slot: number) {
  /*
    Recorded per (business, account), from the coverage the generator actually
    produced — not from "the job returned". A business whose account failed
    must stay outstanding for this slot, which is exactly what the next tick
    will then retry.
  */
  const sql = getDb();
  const coverage = (await sql`
    SELECT DISTINCT business_id, COALESCE(provider_account_id, '') AS provider_account_id
    FROM meta_decision_snapshots_daily
    WHERE snapshot_date = ${snapshotDate}::date
      AND kind IN ('recommendation', 'anomaly')
      AND engine_version = ${META_RECOMMENDATION_ENGINE_VERSION}
  `.catch(() => null)) as Array<{
    business_id: string;
    provider_account_id: string;
  }> | null;
  for (const row of coverage ?? []) {
    await recordSlotRun({
      snapshotDate,
      slot,
      businessId: row.business_id,
      providerAccountId: row.provider_account_id,
      status: "success",
    });
  }
}
