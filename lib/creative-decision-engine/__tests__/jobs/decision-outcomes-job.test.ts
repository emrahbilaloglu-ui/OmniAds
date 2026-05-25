import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DECISION_OUTCOME_WINDOWS_DAYS,
  JOB_NAME,
} from "../../jobs/decision-outcomes-job";

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
    expect(source).not.toContain("AND s.engine_version =");
    expect(source).toContain("($4::integer - 1)");
    expect(source).toContain("LIMIT $5::integer");
  });
});
