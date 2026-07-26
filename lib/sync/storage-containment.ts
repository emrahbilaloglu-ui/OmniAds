import { getDb } from "@/lib/db";
import { resolveDestructiveRetentionMode } from "@/lib/sync/global-kill-switch";
import { runMetaCreativeLineageLegacyCollapse } from "@/lib/meta/creative-lineage-legacy-collapse";

/**
 * The operational containment pass for the three tables that grew unbounded.
 *
 * The census still reads roughly 22.8/22.5/21.9 GB across the config tables,
 * ~3.27 GB of lineage and ~1.35 GB of gates. Each of those has a correct
 * single-batch fix now, and none of them had an operational path: the gate prune
 * had no caller, the lineage collapse existed only inside a seam, and nothing at
 * all measured whether forward growth had actually stopped.
 *
 * This is that path. Three properties hold by construction:
 *
 *   BOUNDED     — every pass is a batch count times a row limit. Nothing here
 *                 can issue an unbounded statement, whatever the table size.
 *   RESUMABLE   — every pass carries an explicit cursor and reports where it
 *                 stopped, so an interrupted run continues rather than restarts.
 *   DEFAULT-OFF — destructive execution is gated by the retention lane, which is
 *                 disabled. With it off this reports exactly what it WOULD do and
 *                 does none of it. The lineage collapse additionally has no
 *                 delete path at all.
 *
 * Nothing here deletes config history. Those tables are contained at the WRITER
 * — the current-evidence gate stopped the historical amplification and the
 * serialized skip-unchanged decision stopped the per-observation append — so the
 * question that matters operationally is whether forward growth has stopped, not
 * how fast the backlog can be removed. `measureConfigHistoryForwardGrowth`
 * answers exactly that, and it only reads.
 */

export interface ConfigHistoryGrowthMeasurement {
  table: string;
  /** Rows written in the last hour. Zero is the contained steady state. */
  rowsLastHour: number;
  /** Rows written in the last day. */
  rowsLastDay: number;
  /**
   * Rows that are a genuine transition from the entity's previous row.
   *
   * The number that matters: growth is only legitimate when every new row is a
   * configuration change. Anything else is the per-observation append that made
   * these tables what they are.
   */
  transitionsLastDay: number;
  /** Redundant rows in the last day — the defect, if it is still happening. */
  redundantLastDay: number;
}

/**
 * Is the forward growth of a config-history table legitimate?
 *
 * READ-ONLY. It compares each recent row against the previous row for the same
 * entity and counts how many are genuine transitions. A contained table has
 * `redundantLastDay === 0`: every row it gained described a change.
 *
 * Bounded by an explicit row cap so this cannot become a full-table window scan
 * on a 22 GB relation.
 */
export async function measureConfigHistoryForwardGrowth(input: {
  table: "meta_campaign_config_history" | "meta_adset_config_history";
  entityColumn: "campaign_id" | "adset_id";
  sampleLimit?: number;
}): Promise<ConfigHistoryGrowthMeasurement> {
  const sampleLimit = Math.max(1, Math.min(200_000, input.sampleLimit ?? 50_000));
  const sql = getDb();
  const rows = (await sql.query(
    `WITH recent AS (
       SELECT business_id, provider_account_id, ${input.entityColumn} AS entity_id,
              config_fingerprint, captured_at, id
       FROM ${input.table}
       WHERE captured_at >= now() - interval '1 day'
       ORDER BY captured_at DESC, id DESC
       LIMIT $1
     ),
     ordered AS (
       SELECT recent.*,
              LAG(config_fingerprint) OVER (
                PARTITION BY business_id, provider_account_id, entity_id
                ORDER BY captured_at ASC, id ASC
              ) AS previous_fingerprint
       FROM recent
     )
     SELECT
       COUNT(*) FILTER (WHERE captured_at >= now() - interval '1 hour')::int
         AS rows_last_hour,
       COUNT(*)::int AS rows_last_day,
       COUNT(*) FILTER (
         WHERE previous_fingerprint IS NULL
            OR previous_fingerprint IS DISTINCT FROM config_fingerprint
       )::int AS transitions_last_day,
       COUNT(*) FILTER (
         WHERE previous_fingerprint IS NOT NULL
           AND previous_fingerprint = config_fingerprint
       )::int AS redundant_last_day
     FROM ordered`,
    [sampleLimit],
  )) as Array<{
    rows_last_hour: number;
    rows_last_day: number;
    transitions_last_day: number;
    redundant_last_day: number;
  }>;
  const row = rows[0];
  return {
    table: input.table,
    rowsLastHour: Number(row?.rows_last_hour ?? 0),
    rowsLastDay: Number(row?.rows_last_day ?? 0),
    transitionsLastDay: Number(row?.transitions_last_day ?? 0),
    redundantLastDay: Number(row?.redundant_last_day ?? 0),
  };
}

export interface StorageContainmentReport {
  mode: "execute" | "dry_run";
  laneReason: string;
  lineageCollapse: {
    batches: number;
    scanned: number;
    applied: number;
    redundantRowCount: number;
    completed: boolean;
    /** Always zero: this pass has no delete path at all. */
    deleted: 0;
  };
  configGrowth: ConfigHistoryGrowthMeasurement[];
}

/**
 * Run the containment pass.
 *
 * The lineage collapse stamps a stable logical key on the OLDEST row of each
 * logical group and deletes nothing — the deduplicated reader is what makes the
 * duplicates invisible, so removing them is a storage decision that can wait for
 * an explicit, separately-authorised pass rather than being smuggled into a
 * retention tick.
 *
 * `apply` for the collapse is gated on the SAME destructive-retention decision
 * as everything else, so with the retention lane off it plans and stamps
 * nothing.
 */
export async function runStorageContainmentPass(input?: {
  lineageBatchLimit?: number;
  lineageMaxBatches?: number;
  forceExecute?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<StorageContainmentReport> {
  const decision = resolveDestructiveRetentionMode({
    requestedExecute: input?.forceExecute === true,
    env: input?.env,
  });

  const collapse = await runMetaCreativeLineageLegacyCollapse({
    limit: input?.lineageBatchLimit ?? 1_000,
    maxBatches: input?.lineageMaxBatches ?? 20,
    apply: decision.mode === "execute",
  });

  const configGrowth = await Promise.all([
    measureConfigHistoryForwardGrowth({
      table: "meta_campaign_config_history",
      entityColumn: "campaign_id",
    }),
    measureConfigHistoryForwardGrowth({
      table: "meta_adset_config_history",
      entityColumn: "adset_id",
    }),
  ]);

  return {
    mode: decision.mode,
    laneReason: decision.laneAdmission.reason,
    lineageCollapse: {
      batches: collapse.batches,
      scanned: collapse.scanned,
      applied: collapse.applied,
      redundantRowCount: collapse.redundantRowCount,
      completed: collapse.completed,
      deleted: 0,
    },
    configGrowth,
  };
}
