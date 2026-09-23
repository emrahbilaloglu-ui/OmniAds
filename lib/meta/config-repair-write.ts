import { getDb, runDbTransaction } from "@/lib/db";
import { createHash } from "node:crypto";

export interface MetaConfigRepairWriteChange {
  scope: "campaign_daily" | "adset_daily";
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: {
    kind: "meta_raw_snapshots" | "meta_config_snapshots";
    id: string | null;
    sourceSnapshotId?: string | null;
    corroboratingSourceSnapshotId?: string | null;
    corroboratingObservedAt?: string | null;
  };
}

const CAMPAIGN_COLUMNS: Record<string, string> = {
  objective: "objective",
  optimizationGoal: "optimization_goal",
  customEventType: "custom_event_type",
  bidStrategyType: "bid_strategy_type",
  bidValue: "bid_value",
  bidValueFormat: "bid_value_format",
  dailyBudget: "daily_budget",
  lifetimeBudget: "lifetime_budget",
  isBudgetMixed: "is_budget_mixed",
  isConfigMixed: "is_config_mixed",
  isOptimizationGoalMixed: "is_optimization_goal_mixed",
  isCustomEventTypeMixed: "is_custom_event_type_mixed",
  isBidStrategyMixed: "is_bid_strategy_mixed",
  isBidValueMixed: "is_bid_value_mixed",
};

const ADSET_COLUMNS: Record<string, string> = {
  optimizationGoal: "optimization_goal",
  customEventType: "custom_event_type",
  pixelId: "pixel_id",
  customConversionId: "custom_conversion_id",
  promotedObjectJson: "promoted_object_json",
  bidStrategyType: "bid_strategy_type",
  bidValue: "bid_value",
  bidValueFormat: "bid_value_format",
  dailyBudget: "daily_budget",
  lifetimeBudget: "lifetime_budget",
  isBudgetMixed: "is_budget_mixed",
  isConfigMixed: "is_config_mixed",
  isOptimizationGoalMixed: "is_optimization_goal_mixed",
  isBidStrategyMixed: "is_bid_strategy_mixed",
  isBidValueMixed: "is_bid_value_mixed",
};

/**
 * Apply a reviewed manifest with exact old-value guards. This updates only
 * stored configuration columns. A slice replacement could delete another row
 * and rewrite unrelated spend/conversion facts, so it is inappropriate here.
 */
export async function applyMetaConfigRepairChanges(
  changes: MetaConfigRepairWriteChange[],
  audit: {
    manifestHash: string;
    businessId: string;
    startDate: string;
    endDate: string;
  },
) {
  if (changes.length === 0 || !changes.every((change) =>
    change.businessId === audit.businessId && Boolean(change.accountTimezone) &&
    change.date >= audit.startDate && change.date <= audit.endDate &&
    change.source?.kind === "meta_raw_snapshots" &&
    Boolean(change.source.id && change.source.sourceSnapshotId &&
      change.source.corroboratingSourceSnapshotId &&
      change.source.corroboratingObservedAt))) {
    throw new Error("meta_config_repair_audit_scope_invalid");
  }
  const actualHash = createHash("sha256")
    .update(JSON.stringify(changes)).digest("hex");
  if (actualHash !== audit.manifestHash) {
    throw new Error("meta_config_repair_audit_hash_mismatch");
  }
  const groups = new Map<string, MetaConfigRepairWriteChange[]>();
  for (const change of changes) {
    const key = [change.scope, change.businessId, change.providerAccountId,
      change.date, change.entityId].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(change);
    groups.set(key, group);
  }
  return runDbTransaction(async () => {
    const sql = getDb();
    let rowsUpdated = 0;
    for (const group of groups.values()) {
      const sample = group[0]!;
      if (group.some((change) =>
        change.accountTimezone !== sample.accountTimezone)) {
        throw new Error(`meta_config_repair_timezone_changed:${sample.scope}:${sample.entityId}`);
      }
      const campaign = sample.scope === "campaign_daily";
      const table = campaign ? "meta_campaign_daily" : "meta_adset_daily";
      const entityColumn = campaign ? "campaign_id" : "adset_id";
      const columns = campaign ? CAMPAIGN_COLUMNS : ADSET_COLUMNS;
      const values: unknown[] = [sample.businessId, sample.providerAccountId,
        sample.date, sample.entityId, sample.accountTimezone];
      const assignments: string[] = [];
      const preimages: string[] = [];
      for (const change of group) {
        const column = columns[change.field];
        if (!column) throw new Error(`meta_config_repair_field_not_allowlisted:${change.field}`);
        const cast = column === "promoted_object_json" ? "::jsonb" : "";
        const newValue = column === "promoted_object_json" && change.newValue != null
          ? JSON.stringify(change.newValue) : change.newValue;
        const oldValue = column === "promoted_object_json" && change.oldValue != null
          ? JSON.stringify(change.oldValue) : change.oldValue;
        values.push(newValue);
        assignments.push(`${column} = $${values.length}${cast}`);
        values.push(oldValue);
        preimages.push(`${column} IS NOT DISTINCT FROM $${values.length}${cast}`);
      }
      if (assignments.length === 0) {
        throw new Error(`meta_config_repair_has_no_stored_change:${sample.scope}:${sample.entityId}`);
      }
      const updated = await sql.query<{ id: string }>(
        `UPDATE ${table} SET ${assignments.join(", ")}
         WHERE business_id = $1 AND provider_account_id = $2
           AND date = $3::date AND ${entityColumn} = $4
           AND account_timezone = $5
           AND ${preimages.join(" AND ")}
         RETURNING id::text AS id`,
        values,
      );
      if (updated.length !== 1) {
        throw new Error(`meta_config_repair_preimage_changed:${sample.scope}:${sample.entityId}:${sample.date}`);
      }
      rowsUpdated++;
    }
    await sql.query(
      `INSERT INTO meta_config_repair_audits (
         manifest_hash, business_id, start_date, end_date,
         changes_json, rows_updated
       ) VALUES ($1, $2, $3::date, $4::date, $5::jsonb, $6)`,
      [audit.manifestHash, audit.businessId, audit.startDate,
        audit.endDate, JSON.stringify(changes), rowsUpdated],
    );
    return { rowsUpdated };
  });
}

/**
 * A reviewed manifest may be submitted twice after a successful transaction.
 * The second submission is a successful no-op only while its recorded
 * postimages are still present; an audit row alone cannot hide a later change.
 */
export async function verifyPreviouslyAppliedMetaConfigRepair(input: {
  manifestHash: string;
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<{ rowsUpdated: 0; alreadyApplied: true } | null> {
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const [audit] = await sql.query<{
      changes_json: MetaConfigRepairWriteChange[];
    }>(
      `SELECT changes_json FROM meta_config_repair_audits
       WHERE manifest_hash = $1 AND business_id = $2
         AND start_date = $3::date AND end_date = $4::date`,
      [input.manifestHash, input.businessId, input.startDate, input.endDate],
    );
    if (!audit) return null;
    if (!Array.isArray(audit.changes_json) || audit.changes_json.length === 0) {
      throw new Error("meta_config_repair_audit_invalid");
    }
    const groups = new Map<string, MetaConfigRepairWriteChange[]>();
    for (const change of audit.changes_json) {
      if (change.businessId !== input.businessId ||
          change.date < input.startDate || change.date > input.endDate) {
        throw new Error("meta_config_repair_audit_scope_invalid");
      }
      const key = [change.scope, change.providerAccountId, change.date,
        change.entityId].join("\u0000");
      const group = groups.get(key) ?? [];
      group.push(change);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const sample = group[0]!;
      const campaign = sample.scope === "campaign_daily";
      const table = campaign ? "meta_campaign_daily" : "meta_adset_daily";
      const entityColumn = campaign ? "campaign_id" : "adset_id";
      const columns = campaign ? CAMPAIGN_COLUMNS : ADSET_COLUMNS;
      const values: unknown[] = [sample.businessId, sample.providerAccountId,
        sample.date, sample.entityId, sample.accountTimezone];
      const postimages: string[] = [];
      for (const change of group) {
        if (change.accountTimezone !== sample.accountTimezone) {
          throw new Error("meta_config_repair_audit_timezone_conflict");
        }
        const column = columns[change.field];
        if (!column) throw new Error(`meta_config_repair_field_not_allowlisted:${change.field}`);
        const cast = column === "promoted_object_json" ? "::jsonb" : "";
        values.push(column === "promoted_object_json" && change.newValue != null
          ? JSON.stringify(change.newValue) : change.newValue);
        postimages.push(`${column} IS NOT DISTINCT FROM $${values.length}${cast}`);
      }
      if (postimages.length === 0) throw new Error("meta_config_repair_audit_has_no_stored_change");
      const rows = await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM ${table}
         WHERE business_id = $1 AND provider_account_id = $2
           AND date = $3::date AND ${entityColumn} = $4
           AND account_timezone = $5 AND ${postimages.join(" AND ")}
         LIMIT 2`,
        values,
      );
      if (rows.length !== 1) {
        throw new Error(`meta_config_repair_applied_state_changed:${sample.scope}:${sample.entityId}:${sample.date}`);
      }
    }
    return { rowsUpdated: 0, alreadyApplied: true };
  });
}
