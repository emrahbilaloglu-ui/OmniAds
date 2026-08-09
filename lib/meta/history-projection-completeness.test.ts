import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { META_HISTORY_SOURCES } from "@/lib/meta/history-contract";

/**
 * History must project every source it declares.
 *
 * A source listed in the contract but never queried is worse than an omission:
 * the filter offers it, the operator selects it, and an empty result reads as
 * "nothing happened" rather than "this was never wired". This test is what
 * stops a declared-but-unqueried source.
 */
const readModel = readFileSync("lib/meta/history-read-model.ts", "utf8");

describe("every declared History source is actually projected", () => {
  it("queries each source in the read model", () => {
    const missing = META_HISTORY_SOURCES.filter(
      (source) => !readModel.includes(`FROM ${source}`),
    );
    expect(
      missing,
      `declared but never queried: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("covers the incident-review families, not just engine verdicts", () => {
    // What an incident review needs: what was decided, who took it on, what was
    // attempted against the provider, and what changed outside the product.
    for (const source of [
      "engine_v3_decision_snapshots_daily",
      "decision_workflow_events",
      "meta_ads_action_mutation_attempt_events",
      "meta_ads_action_log",
      "meta_campaign_config_history",
    ]) {
      expect(META_HISTORY_SOURCES).toContain(source);
      expect(readModel, `${source} is not projected`).toContain(
        `FROM ${source}`,
      );
    }
  });

  it("marks an unfinished provider attempt as pending rather than recorded", () => {
    // An attempt with no completion is in flight. Reporting it as recorded
    // would claim an outcome nobody has.
    expect(readModel).toContain("WHEN attempt.event_kind = 'attempt_started' THEN 'pending'");
  });

  it("keeps workflow state attributed to the operator, not the engine", () => {
    expect(readModel).toContain("'operator_workflow'");
    expect(readModel).toContain(
      "Workflow state is owned by the operator, not by the engine.",
    );
  });
});
