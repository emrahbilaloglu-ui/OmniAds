import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getDb: () => dbMocks,
  runDbTransaction: (callback: () => Promise<unknown>) => callback(),
}));
vi.mock("../../feature-flags", () => ({
  resolveEngineV3Flags: async () => ({ enabled: true }),
}));

import { runOperatorResponseJob } from "../../jobs/operator-response-job";

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const AS_OF = "2026-09-21";
const CREATIVE_ID = "cutoff-status-creative";
const JOB_ID = "12345678-1234-4234-8234-123456789012";
const SNAPSHOT_ID = "87654321-4321-4321-8321-210987654321";

function sqlCall(fragment: string): [string, unknown[]] {
  const call = dbMocks.query.mock.calls.find(([sql]) =>
    typeof sql === "string" && sql.includes(fragment));
  if (!call) throw new Error(`No query contains ${fragment}`);
  return call as [string, unknown[]];
}

function installRows(latestStatus: string | null, withDatedPauseReceipt = false) {
  dbMocks.query.mockImplementation(async (sql: string) => {
    if (typeof sql !== "string") throw new Error(`Unexpected query: ${String(sql)} ${new Error().stack}`);
    if (sql.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
    if (sql.includes("SELECT id") && sql.includes("FROM engine_v3_job_runs")) {
      return [{ id: JOB_ID }];
    }
    if (sql.includes("INSERT INTO engine_v3_job_runs")) return [{ id: JOB_ID }];
    if (sql.includes("SELECT DISTINCT creative_id") && sql.includes("FROM guarded")) {
      return [{ creative_id: CREATIVE_ID }];
    }
    if (sql.includes("AS complete") && sql.includes("meta_creative_daily")) {
      return [{ complete: true }];
    }
    if (sql.includes("SELECT id, as_of_date, label, confidence")) {
      return [{ id: SNAPSHOT_ID, as_of_date: "2026-09-12", label: "scale", confidence: 85 }];
    }
    if (sql.includes("SELECT\n  adset_id,") && sql.includes("engine_v3_creative_lifecycle_daily")) {
      return [{
        adset_id: "adset-1", campaign_id: "campaign-1", ad_id: "ad-1",
        lifecycle_position: "past_peak_unclear", roas_7d: 2.1,
        roas_28d: 2.1, frequency_28d: 1.2,
      }];
    }
    if (sql.includes("SUM(d.spend)::double precision AS spend")) {
      return Array.from({ length: 10 }, (_, index) => ({
        date: `2026-09-${String(index + 12).padStart(2, "0")}`,
        spend: 100, purchases: 1,
        effective_status: index === 9 ? latestStatus : null,
      }));
    }
    if (sql.includes("SELECT DISTINCT ON (d.creative_id)")) {
      return [{ adset_id: "adset-1", campaign_id: "campaign-1", ad_id: "ad-1" }];
    }
    if (sql.includes("AS recent7d_frequency")) return [{ recent7d_frequency: null }];
    if (sql.includes("FROM command_center_action_journal journal")) {
      return withDatedPauseReceipt ? [{
        created_at: "2026-09-20T09:00:00.000Z",
        event_type: "status_changed",
        action_title: "Pause creative",
        metadata_json: {},
        match_level: "creative",
      }] : [];
    }
    if (sql.includes("UPDATE engine_v3_creative_lifecycle_daily")) {
      return [{ lifecycle_position: "past_peak_unclear" }];
    }
    if (sql.includes("INSERT INTO engine_v3_decision_events")) return [{ id: JOB_ID }];
    return [];
  });
}

describe("operator response cutoff and provider status", () => {
  beforeEach(() => { dbMocks.query.mockReset(); });

  it("bounds every replay input and detects a source-backed provider pause", async () => {
    installRows("PAUSED");
    const cutoff = new Date().toISOString();
    const result = await runOperatorResponseJob({
      businessId: BUSINESS_ID, asOf: AS_OF, evaluationCutoffAt: cutoff,
    });
    expect(result).toMatchObject({ status: "success", operatorEventsWritten: 1 });

    const [recommended, recommendedParams] = sqlCall("SELECT DISTINCT creative_id\nFROM guarded");
    expect(recommended).toContain("snapshots.computed_at <= $6::timestamptz".replace("snapshots.", ""));
    expect(recommended).toContain("lifecycle.updated_at <= $6::timestamptz");
    expect(recommended).toContain("context.updated_at <= $6::timestamptz");
    expect(recommended).toContain("WHEN lifecycle.campaign_id IS NULL");
    expect(recommendedParams[5]).toBe(cutoff);

    const [recommendations, recommendationParams] = sqlCall("SELECT id, as_of_date, label, confidence");
    expect(recommendations).toContain("computed_at <= $7::timestamptz");
    expect(recommendations).toContain("context.created_at <= $7::timestamptz");
    expect(recommendations).toContain("AND (lifecycle.campaign_id IS NULL");
    expect(recommendationParams[6]).toBe(cutoff);

    const [lifecycle, lifecycleParams] = sqlCall("SELECT\n  adset_id,");
    expect(lifecycle).toContain("updated_at <= $5::timestamptz");
    expect(lifecycleParams[4]).toBe(cutoff);

    const [spend, spendParams] = sqlCall("SUM(d.spend)::double precision AS spend");
    expect(spend).toContain("meta_entity_state_history");
    expect(spend).toContain("meta_entity_tombstones");
    expect(spend).toContain("CASE WHEN d.date = $3::date");
    expect(spend).not.toContain("ARRAY_AGG(d.effective_status");
    expect(spendParams[4]).toBe(cutoff);

    for (const table of ["meta_adset_config_history", "meta_campaign_config_history"]) {
      const [budget, params] = sqlCall(`FROM ${table}`);
      expect(budget).toContain("captured_at <= $5::timestamptz");
      expect(budget).toContain("created_at <= $5::timestamptz");
      expect(params[4]).toBe(cutoff);
    }
    const [journal, journalParams] = sqlCall("FROM command_center_action_journal journal");
    expect(journal).toContain("journal.created_at <= $8::timestamptz");
    expect(journalParams[7]).toBe(cutoff);

    const [, eventParams] = sqlCall("INSERT INTO engine_v3_decision_events");
    const event = JSON.parse(String(eventParams[0]))[0];
    expect(event.operator_action_type).toBe("paused");
    expect(event.event_date).toBe(cutoff.slice(0, 10));
    expect(event.operator_evidence.operator_response_detected_at).toBe(cutoff);
    expect(event.operator_evidence.evidence).toContain("latest creative status is PAUSED");
    expect(event.operator_evidence.evidence).toContain(
      "provider status transition time unobserved; detected by evaluation cutoff",
    );
  });

  it("preserves a dated pause journal receipt ahead of the status knowledge cutoff", async () => {
    installRows("PAUSED", true);
    const cutoff = new Date().toISOString();
    const result = await runOperatorResponseJob({
      businessId: BUSINESS_ID, asOf: AS_OF, evaluationCutoffAt: cutoff,
    });
    expect(result).toMatchObject({ status: "success", operatorEventsWritten: 1 });
    const [, eventParams] = sqlCall("INSERT INTO engine_v3_decision_events");
    const event = JSON.parse(String(eventParams[0]))[0];
    expect(event.event_date).toBe("2026-09-20");
    expect(event.operator_evidence.operator_response_detected_at).toBe(
      "2026-09-20T09:00:00.000Z",
    );
  });

  it("leaves a missing provider status unknown rather than inferring active or paused", async () => {
    installRows(null);
    const result = await runOperatorResponseJob({
      businessId: BUSINESS_ID, asOf: AS_OF,
      evaluationCutoffAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({ status: "success", operatorEventsWritten: 0 });
    expect(dbMocks.query.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO engine_v3_decision_events"),
    )).toBe(false);
  });
});
