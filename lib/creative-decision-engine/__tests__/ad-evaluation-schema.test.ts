import { describe, expect, it } from "vitest";

import {
  CREATE_NATIVE_AD_DECISION_INDEXES_SQL,
  CREATE_NATIVE_AD_EVALUATION_CONTEXTS_SQL,
  CREATE_NATIVE_AD_EVALUATIONS_SQL,
  CREATE_NATIVE_AD_EVENTS_SQL,
  CREATE_NATIVE_AD_SNAPSHOTS_SQL,
  ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL,
  ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL,
  ALTER_NATIVE_AD_DECISION_SCHEMA_SQL,
  NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION,
  NATIVE_AD_DECISION_SCHEMA_SQL,
} from "../ad-evaluation-schema";
import {
  AD_DECISION_SCHEMA_REQUIRED_COLUMNS,
  AD_EVALUATION_CONTEXTS_TABLE,
  AD_EVALUATIONS_TABLE,
  AD_EVENTS_TABLE,
  AD_SNAPSHOTS_TABLE,
} from "../evaluation-store";

describe("D047 native ad parallel schema SQL", () => {
  it("contains every capability column in its owning CREATE TABLE", () => {
    const sqlByTable = new Map([
      [AD_EVALUATION_CONTEXTS_TABLE, CREATE_NATIVE_AD_EVALUATION_CONTEXTS_SQL],
      [AD_EVALUATIONS_TABLE, CREATE_NATIVE_AD_EVALUATIONS_SQL],
      [AD_SNAPSHOTS_TABLE, CREATE_NATIVE_AD_SNAPSHOTS_SQL],
      [AD_EVENTS_TABLE, CREATE_NATIVE_AD_EVENTS_SQL],
    ]);
    for (const [table, columns] of Object.entries(
      AD_DECISION_SCHEMA_REQUIRED_COLUMNS,
    )) {
      const sql = sqlByTable.get(table);
      expect(sql, `missing CREATE SQL for ${table}`).toBeDefined();
      for (const column of columns) {
        expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  });

  it("exports the exact named lineage constraints expected by the runtime gate", () => {
    const sql = NATIVE_AD_DECISION_SCHEMA_SQL.join("\n");
    const normalized = sql.replace(/\s+/g, " ");
    expect(sql).toContain("engine_v3_ad_eval_contexts_run_scope_hash_unique");
    expect(sql).toContain("engine_v3_ad_evaluations_context_lineage_fk");
    expect(sql).toContain("engine_v3_ad_snapshots_evaluation_lineage_fk");
    expect(sql).toContain(
      "engine_v3_ad_snapshots_calibration_lineage_fk",
    );
    expect(sql).toContain(
      "engine_v3_ad_calibration_snapshot_lineage_unique",
    );
    expect(sql).toContain("engine_v3_ad_events_snapshot_fk");
    expect(CREATE_NATIVE_AD_DECISION_INDEXES_SQL.join("\n")).toContain(
      "engine_v3_ad_events_change_unique",
    );
    expect(ALTER_NATIVE_AD_DECISION_SCHEMA_SQL.join("\n")).toContain(
      "ALTER COLUMN calibration_row_id DROP NOT NULL",
    );
    expect(normalized).toContain(
      "UNIQUE ( job_run_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, context_hash )",
    );
    expect(normalized).toContain(
      "UNIQUE ( context_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, input_hash, decision_hash )",
    );
    expect(normalized).toContain(
      "UNIQUE ( business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, as_of_date, engine_version, scope_type, scope_id )",
    );
    expect(normalized).toContain(
      "(business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, event_date, engine_version, scope_type, scope_id, event_type)",
    );
  });

  it("keeps nullable grouping and soft-only calibration lineage off legacy tables", () => {
    const sql = NATIVE_AD_DECISION_SCHEMA_SQL.join("\n");
    expect(CREATE_NATIVE_AD_SNAPSHOTS_SQL).toContain(
      "calibration_row_id UUID",
    );
    expect(CREATE_NATIVE_AD_SNAPSHOTS_SQL).not.toMatch(
      /calibration_row_id UUID NOT NULL/,
    );
    expect(sql).toContain(
      "FOREIGN KEY (calibration_row_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version)",
    );
    expect(CREATE_NATIVE_AD_SNAPSHOTS_SQL).toContain(
      "creative_evidence_lifecycle_row_id UUID",
    );
    expect(sql).not.toContain("engine_v3_account_calibration_daily");
    expect(sql).not.toContain("engine_v3_creative_lifecycle_daily");
    expect(sql).not.toMatch(/engine_v3_decision_(evaluations|snapshots|events)/);
  });

  it("adds nullable authority provenance with closed constraints", () => {
    const sql = `${CREATE_NATIVE_AD_SNAPSHOTS_SQL}\n${ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL}`;
    expect(sql).toContain("pre_authority_label TEXT");
    expect(sql).toContain("authority_blocker TEXT");
    expect(sql).toContain("engine_v3_ad_snapshots_pre_authority_label_check");
    expect(sql).toContain("engine_v3_ad_snapshots_authority_blocker_check");
    for (const blocker of [
      "profile_hard_action_ineligible", "source_freshness", "campaign_context",
      "native_metrics_unavailable", "native_profile_unavailable",
    ]) expect(sql).toContain(`'${blocker}'`);
  });

  it("normalizes legacy non-published authorization before tightening the authority check", () => {
    const normalized = ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL.replace(
      /\s+/g,
      " ",
    );
    expect(normalized.indexOf("DROP CONSTRAINT")).toBeLessThan(
      normalized.indexOf("SET authorized_action = NULL"),
    );
    expect(normalized.indexOf("SET authorized_action = NULL")).toBeLessThan(
      normalized.indexOf("ADD CONSTRAINT"),
    );
    expect(normalized).toContain("raw_label = label");
    expect(normalized).toContain("blocked_action_type IS NULL");
    expect(
      NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION.replace(/\s+/g, " "),
    ).toContain(
      "authorized_action IS NULL OR blocked_action_type IS NULL",
    );
    expect(
      NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION.replace(/\s+/g, " "),
    ).toContain(") IS TRUE)");
    expect(normalized).toContain(
      "authorized_action is null or blocked_action_type is null",
    );
    expect(normalized).toContain("LIKE '%is true%'");
  });
});
