import { describe, expect, it } from "vitest";
import { NATIVE_AD_ENGINE_VERSION } from "../types";

import {
  READ_EXACT_AD_DECISION_BACKTEST_ROWS_SQL,
  buildAdDecisionBacktestReport,
  readAdDecisionBacktest,
  type AdBacktestQuery,
} from "../ad-backtest-store";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function backtestRow(overrides: Record<string, unknown> = {}) {
  const adId = String(overrides.ad_id ?? "ad-1");
  return {
    outcome_id: `outcome-${adId}`,
    outcome_run_id: "outcome-run-1",
    decision_snapshot_id: `snapshot-${adId}`,
    evaluation_id: `evaluation-${adId}`,
    source_decision_job_run_id: "source-decision-job-1",
    business_ref_id: "business-1",
    business_id: "business-1",
    provider_account_ref_id: "account-ref-1",
    provider_account_id: "account-1",
    decision_entity_type: "ad",
    decision_entity_id: adId,
    ad_id: adId,
    creative_id: "shared-creative",
    decision_as_of_date: "2026-07-01",
    evaluation_date: "2026-07-16",
    source_cutoff_at: "2026-07-16T05:00:00.000Z",
    outcome_window_days: 14,
    outcome_window_start: "2026-07-02",
    outcome_window_end: "2026-07-15",
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "account-1",
    label: "cut",
    raw_label: "cut",
    confidence: 80,
    account_currency: "USD",
    currency_status: "known",
    effective_cohort: "purchase",
    objective: "OUTCOME_SALES",
    optimization_goal: "OFFSITE_CONVERSIONS",
    custom_event_type: "PURCHASE",
    measurement_status: "known",
    realized_outcome: "positive",
    severity: "high",
    treatment_status: "observational_untreated",
    action_contaminated: false,
    controlled_evidence_validated: false,
    treatment_receipt_validated: false,
    causal_assignment_validated: false,
    causal_estimate_validated: false,
    window_complete: true,
    outcome_spend: 30,
    source_input_hash: HASH_A,
    source_decision_hash: HASH_B,
    source_manifest_hash: HASH_C,
    source_set_hash: HASH_C,
    outcome_computed_at: "2026-07-16T04:00:00.000Z",
    snapshot_computed_at: "2026-07-01T04:00:00.000Z",
    evaluated_at: "2026-07-01T04:00:00.000Z",
    ...overrides,
  };
}

describe("native ad backtest store", () => {
  it("reads only exact native outcome, snapshot, and evaluation IDs", () => {
    const sql = READ_EXACT_AD_DECISION_BACKTEST_ROWS_SQL.toLowerCase();
    expect(sql).toContain("from engine_v3_ad_decision_outcomes_daily outcome");
    expect(sql).toContain("engine_v3_ad_decision_outcome_runs outcome_run");
    expect(sql).toContain(
      "engine_v3_ad_decision_outcome_publications publication",
    );
    expect(sql).toContain(
      "publication.active_outcome_run_id = outcome.outcome_run_id",
    );
    expect(sql).toContain("publication.active_job_run_id = outcome.job_run_id");
    expect(sql).toContain("outcome_run.status = 'complete'");
    expect(sql).toContain(
      "outcome_run.persisted_row_count = outcome_run.candidate_row_count",
    );
    expect(sql).toContain("engine_v3_ad_decision_snapshots_daily snapshot");
    expect(sql).toContain("engine_v3_ad_decision_evaluations evaluation");
    expect(sql).toContain("snapshot.id = outcome.decision_snapshot_id");
    expect(sql).toContain("snapshot.evaluation_id = outcome.evaluation_id");
    expect(sql).toContain(
      "snapshot.job_run_id = outcome.source_decision_job_run_id",
    );
    expect(sql).toContain("evaluation.id = outcome.evaluation_id");
    expect(sql).toContain(
      "account_binding.provider_account_ref_id = outcome.provider_account_ref_id",
    );
    expect(sql).toContain("outcome.id = any($2::uuid[])");
    expect(sql).toContain("outcome.engine_version = $3");
    expect(sql).not.toContain("meta_creative_daily");
    expect(sql).not.toContain("engine_v3_decision_outcomes_daily");
    expect(sql).not.toContain("engine_v3_decision_snapshots_daily");
  });

  it("does not dedupe two ads that share a creative", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({ ad_id: "ad-1", decision_entity_id: "ad-1" }),
      backtestRow({
        ad_id: "ad-2",
        decision_entity_id: "ad-2",
        realized_outcome: "negative",
      }),
    ]);

    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((row) => row.adId)).toEqual(["ad-1", "ad-2"]);
    expect(
      report.rows.every((row) => row.creativeId === "shared-creative"),
    ).toBe(true);
    expect(report.strata).toHaveLength(1);
    expect(report.strata[0]?.episodeCount).toBe(2);
    expect(report.strata[0]?.adIds).toEqual(["ad-1", "ad-2"]);
    expect(report.strata[0]?.metrics.sampleSize).toBe(2);
    expect(report.strata[0]?.metrics.hardActionPrecision).toBe(0.5);
  });

  it("isolates currencies even within one account and epoch", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({ ad_id: "ad-usd", decision_entity_id: "ad-usd" }),
      backtestRow({
        ad_id: "ad-eur",
        decision_entity_id: "ad-eur",
        account_currency: "EUR",
      }),
    ]);

    expect(report.strata).toHaveLength(2);
    expect(
      report.strata.map((stratum) => stratum.key.accountCurrency).sort(),
    ).toEqual(["EUR", "USD"]);
    expect(
      report.strata.every(
        (stratum) =>
          stratum.key.providerAccountId === "account-1" &&
          stratum.key.providerAccountRefId === "account-ref-1" &&
          stratum.key.engineEpoch === NATIVE_AD_ENGINE_VERSION &&
          stratum.episodeCount === 1,
      ),
    ).toBe(true);
  });

  it("separates action-exposed evidence from uncontaminated observations", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({ ad_id: "ad-clean", decision_entity_id: "ad-clean" }),
      backtestRow({
        ad_id: "ad-acted",
        decision_entity_id: "ad-acted",
        treatment_status: "observational_action_exposed",
        action_contaminated: true,
      }),
    ]);

    expect(report.strata).toHaveLength(2);
    expect(
      report.strata.map((stratum) => stratum.key.evidenceClass).sort(),
    ).toEqual(["observational_action_exposed", "observational_uncontaminated"]);
    expect(report.strata.every((row) => !row.causalInterpretationAllowed)).toBe(
      true,
    );
  });

  it("allows causal wording only for fully validated randomized treatment", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({
        treatment_status: "controlled_treatment",
        action_contaminated: true,
        controlled_evidence_validated: true,
        treatment_receipt_validated: true,
        causal_assignment_validated: true,
        causal_estimate_validated: true,
      }),
    ]);

    expect(report.strata[0]).toMatchObject({
      interpretation: "randomized_controlled_causal",
      causalInterpretationAllowed: true,
    });
  });

  it("rejects incomplete causal flags and non-current epochs", () => {
    expect(() =>
      buildAdDecisionBacktestReport([
        backtestRow({
          treatment_status: "controlled_treatment",
          action_contaminated: true,
          controlled_evidence_validated: true,
        }),
      ]),
    ).toThrow("treatment lineage is inconsistent");
    expect(() =>
      buildAdDecisionBacktestReport([
        backtestRow({ engine_version: "stale-native-epoch" }),
      ]),
    ).toThrow("non-current engine epoch");
    expect(() =>
      buildAdDecisionBacktestReport([
        backtestRow({ source_cutoff_at: "2026-07-16T23:59:00.000Z" }),
      ]),
    ).toThrow("source cutoff policy drifted");
  });

  it("preserves exact account, ad, epoch, snapshot, evaluation, and outcome IDs", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({
        outcome_id: "outcome-exact",
        decision_snapshot_id: "snapshot-exact",
        evaluation_id: "evaluation-exact",
        ad_id: "ad-exact",
        decision_entity_id: "ad-exact",
        provider_account_id: "account-exact",
        provider_account_ref_id: "account-ref-exact",
        scope_id: "account-exact",
        engine_version: NATIVE_AD_ENGINE_VERSION,
      }),
    ]);
    const row = report.rows[0];

    expect(row).toMatchObject({
      outcomeId: "outcome-exact",
      decisionSnapshotId: "snapshot-exact",
      evaluationId: "evaluation-exact",
      sourceDecisionJobRunId: "source-decision-job-1",
      providerAccountId: "account-exact",
      providerAccountRefId: "account-ref-exact",
      decisionEntityId: "ad-exact",
      adId: "ad-exact",
      engineEpoch: NATIVE_AD_ENGINE_VERSION,
    });
    expect(report.strata[0]).toMatchObject({
      outcomeIds: ["outcome-exact"],
      decisionSnapshotIds: ["snapshot-exact"],
      evaluationIds: ["evaluation-exact"],
      adIds: ["ad-exact"],
    });
  });

  it("does not pool reused external account IDs across physical account bindings", () => {
    const report = buildAdDecisionBacktestReport([
      backtestRow({
        ad_id: "ad-old-binding",
        decision_entity_id: "ad-old-binding",
        provider_account_ref_id: "account-ref-old",
      }),
      backtestRow({
        ad_id: "ad-new-binding",
        decision_entity_id: "ad-new-binding",
        provider_account_ref_id: "account-ref-new",
      }),
    ]);

    expect(report.strata).toHaveLength(2);
    expect(
      report.strata.map((stratum) => stratum.key.providerAccountRefId).sort(),
    ).toEqual(["account-ref-new", "account-ref-old"]);
  });

  it("rejects a partial exact-ID read rather than silently changing the cohort", async () => {
    const query: AdBacktestQuery = async <
      Row extends Record<string, unknown>,
    >(): Promise<Row[]> => [backtestRow()] as unknown as Row[];

    await expect(
      readAdDecisionBacktest(
        {
          businessId: "business-1",
          outcomeIds: ["outcome-ad-1", "outcome-missing"],
        },
        query,
      ),
    ).rejects.toThrow("missing outcome-missing");
  });
});
