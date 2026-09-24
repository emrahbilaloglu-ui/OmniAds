import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
} from "../../outcome-classifier";
import {
  DECISION_OUTCOME_DAILY_UTC_HOUR,
  DECISION_OUTCOME_WINDOWS_DAYS,
  JOB_NAME,
  runDecisionOutcomesJob,
} from "../../jobs/decision-outcomes-job";
import { ENGINE_VERSION } from "../../types";

const OUTCOME_BUSINESS_ID = "00000000-0000-4000-8000-000000000561";
const DECISION_AS_OF = "2026-05-01";
const EVALUATION_AS_OF = "2026-05-08";

describe("decision outcomes job SQL contracts", () => {
  it("creates T+7/T+14 realized outcomes from persisted decision snapshots", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decision-outcomes-job.ts",
      "utf8",
    );

    expect(JOB_NAME).toBe("engine_v3_decision_outcomes_job");
    expect(DECISION_OUTCOME_WINDOWS_DAYS).toEqual([7, 14]);
    expect(source).toContain("engine_v3_decision_snapshots_daily");
    expect(source).toContain("engine_v3_decision_outcomes_daily");
    expect(source).toContain("meta_creative_daily");
    expect(source).toContain(
      "ON CONFLICT (decision_snapshot_id, outcome_window_days)",
    );
    expect(source).toContain("classifyCreativeDecisionOutcome");
    expect(source).toContain("AND s.engine_version = $7::text");
    expect(source).toContain("AND s.computed_at <= $8::timestamptz");
    expect(source).toContain("AND existing.computed_at <= $8::timestamptz");
    expect(source).toContain("WHERE engine_v3_decision_outcomes_daily.computed_at <= EXCLUDED.computed_at");
    expect(source).toContain("creativeDayOutcomeSourceCoverageSql");
    expect(source).toContain("outcome_source_complete");
    expect(source).toContain('rule: "creative_source_coverage_incomplete"');
    expect(source).toContain("($4::integer - 1)");
    expect(source).toContain("LIMIT $5::integer");
    expect(source).toContain("existing.realized_outcome = 'unknown'");
    expect(source).toContain(
      "existing.classifier_version IS DISTINCT FROM $6::text",
    );
    expect(source).toContain("CREATIVE_OUTCOME_CLASSIFIER_VERSION");
    expect(source).toContain("s.pre_authority_label");
    expect(source).toContain("s.authority_blocker");
    expect(source).toContain("pre_authority_label text");
    expect(source).toContain("authority_blocker text");
    expect(source).toContain(
      "pre_authority_label = EXCLUDED.pre_authority_label",
    );
    expect(source).toContain(
      "authority_blocker = EXCLUDED.authority_blocker",
    );

    const classifierCall = source.match(
      /const classified = classifyCreativeDecisionOutcome\(\{[\s\S]*?\n  \}\);/,
    )?.[0];
    expect(classifierCall).toContain("label,");
    expect(classifierCall).not.toContain("preAuthorityLabel");
    expect(classifierCall).not.toContain("pre_authority_label");
    expect(source).toContain(
      "prior-epoch stored outcomes are not",
    );
  });

  it("keeps the daily scheduler due-gated and schema-gated", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decision-outcomes-job.ts",
      "utf8",
    );

    expect(DECISION_OUTCOME_DAILY_UTC_HOUR).toBe(4);
    expect(source).toContain("isDailyDecisionOutcomeSlot");
    expect(source).toContain(
      "now.getUTCHours() === DECISION_OUTCOME_DAILY_UTC_HOUR",
    );
    expect(source).toContain("findBusinessesPendingDecisionOutcomes");
    expect(source).toContain("engineV3JobsDisabled");
    expect(source).toContain('reason: "jobs_disabled"');
    expect(source).toContain("pendingBusinesses.length === 0");
    expect(source).toContain(
      "pendingBusinesses.map(async (business) => ({",
    );
    expect(source).toContain("getDbSchemaReadiness");
    expect(source).toContain("engine_v3_decision_outcomes_daily");
  });
});

async function cleanupOutcomeFixtures() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM engine_v3_decision_outcomes_daily
    WHERE business_ref_id = $1::uuid
    `,
    [OUTCOME_BUSINESS_ID],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
    `,
    [OUTCOME_BUSINESS_ID],
  );
  await db.query(
    `
    DELETE FROM engine_v3_job_runs
    WHERE business_ref_id = $1::uuid
      AND job_name = $2
    `,
    [OUTCOME_BUSINESS_ID, JOB_NAME],
  );
}

async function insertOutcomeSourceSnapshot(input: {
  creativeId: string;
  preAuthorityLabel: "cut" | null;
  authorityBlocker: "campaign_context" | null;
  computedAt?: string;
}) {
  const [snapshot] = await getDb().query<{ id: string }>(
    `
    INSERT INTO engine_v3_decision_snapshots_daily (
      business_ref_id,
      business_id,
      creative_id,
      as_of_date,
      engine_version,
      scope_type,
      scope_id,
      label,
      raw_label,
      pre_authority_label,
      authority_blocker,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      blocked_action_type,
      computed_at
    )
    VALUES (
      $1::uuid,
      $1::text,
      $2,
      $3::date,
      $4,
      'account',
      '*',
      'diagnose',
      'diagnose',
      $5::text,
      $6::text,
      50,
      'commercial_truth',
      2,
      0,
      '[]'::jsonb,
      'review-only cut candidate',
      300,
      0,
      0,
      0,
      CASE WHEN $5::text IS NULL THEN NULL ELSE 'cut' END,
      $7::timestamptz
    )
    RETURNING id
    `,
    [
      OUTCOME_BUSINESS_ID,
      input.creativeId,
      DECISION_AS_OF,
      ENGINE_VERSION,
      input.preAuthorityLabel,
      input.authorityBlocker,
      input.computedAt ?? new Date().toISOString(),
    ],
  );
  return snapshot!.id;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "decision outcomes job provenance round-trip",
  () => {
    beforeEach(cleanupOutcomeFixtures);
    afterEach(cleanupOutcomeFixtures);
    afterAll(resetDbClientCache);

    it("copies nullable authority evidence without treating pre-authority cut as published pause authority", async () => {
      await insertOutcomeSourceSnapshot({
        creativeId: "blocked-cut",
        preAuthorityLabel: "cut",
        authorityBlocker: "campaign_context",
      });
      await insertOutcomeSourceSnapshot({
        creativeId: "historical-null-provenance",
        preAuthorityLabel: null,
        authorityBlocker: null,
      });

      const result = await runDecisionOutcomesJob({
        businessId: OUTCOME_BUSINESS_ID,
        asOf: EVALUATION_AS_OF,
        windowsDays: [7],
        lookbackDays: 30,
        batchLimit: 10,
        evaluationCutoffAt: new Date().toISOString(),
      });

      expect(result.status).toBe("success");
      expect(result.outcomesWritten).toBe(2);

      const rows = await getDb().query<{
        creative_id: unknown;
        label: unknown;
        pre_authority_label: unknown;
        authority_blocker: unknown;
      }>(
        `
        SELECT creative_id, label, pre_authority_label, authority_blocker
        FROM engine_v3_decision_outcomes_daily
        WHERE business_ref_id = $1::uuid
        ORDER BY creative_id ASC
        `,
        [OUTCOME_BUSINESS_ID],
      );

      expect(rows).toEqual([
        expect.objectContaining({
          creative_id: "blocked-cut",
          label: "diagnose",
          pre_authority_label: "cut",
          authority_blocker: "campaign_context",
        }),
        expect.objectContaining({
          creative_id: "historical-null-provenance",
          label: "diagnose",
          pre_authority_label: null,
          authority_blocker: null,
        }),
      ]);
      expect(rows[0]?.label).not.toBe("cut");
    });

    it("does not borrow a future snapshot or overwrite a future outcome during historical replay", async () => {
      const cutoff = "2026-08-21T00:00:00.000Z";
      const eligibleId = await insertOutcomeSourceSnapshot({
        creativeId: "past-snapshot-future-outcome",
        preAuthorityLabel: null,
        authorityBlocker: null,
        computedAt: "2026-08-20T12:00:00.000Z",
      });
      await insertOutcomeSourceSnapshot({
        creativeId: "future-snapshot",
        preAuthorityLabel: null,
        authorityBlocker: null,
        computedAt: "2026-08-22T12:00:00.000Z",
      });
      await getDb().query(
        `INSERT INTO engine_v3_decision_outcomes_daily (
           decision_snapshot_id, business_ref_id, creative_id, decision_as_of_date,
           evaluation_date, outcome_window_days, engine_version, label, confidence,
           effective_target_roas, outcome_spend, outcome_purchases, outcome_revenue,
           realized_outcome, severity, classifier_version, computed_at
         ) VALUES (
           $1::uuid, $2::uuid, 'past-snapshot-future-outcome', $3::date,
           $4::date, 7, $5, 'diagnose', 50, 2, 0, 0, 0,
           'positive', 'low', $6, '2026-08-22T12:00:00.000Z'::timestamptz
         )`,
        [eligibleId, OUTCOME_BUSINESS_ID, DECISION_AS_OF, EVALUATION_AS_OF,
          ENGINE_VERSION, CREATIVE_OUTCOME_CLASSIFIER_VERSION],
      );

      const result = await runDecisionOutcomesJob({
        businessId: OUTCOME_BUSINESS_ID,
        asOf: EVALUATION_AS_OF,
        windowsDays: [7],
        lookbackDays: 30,
        batchLimit: 10,
        evaluationCutoffAt: cutoff,
      });
      expect(result.status, result.errorMessage).toBe("success");
      expect(result.outcomesWritten).toBe(0);
      const rows = await getDb().query<{ creative_id: string; realized_outcome: string }>(
        `SELECT creative_id, realized_outcome FROM engine_v3_decision_outcomes_daily
         WHERE business_ref_id = $1::uuid`,
        [OUTCOME_BUSINESS_ID],
      );
      expect(rows).toEqual([{ creative_id: "past-snapshot-future-outcome", realized_outcome: "positive" }]);
    });
  },
);
