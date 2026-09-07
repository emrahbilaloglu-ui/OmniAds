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

function projectedBranch(source: string): string {
  const start = readModel.indexOf(`'${source}',`);
  expect(start, `${source} branch exists`).toBeGreaterThan(0);
  const nextUnion = readModel.indexOf("UNION ALL", start);
  const cteEnd = readModel.indexOf("),\nfiltered_entries", start);
  const endings = [nextUnion, cteEnd].filter((index) => index > start);
  return readModel.slice(start, endings.length > 0 ? Math.min(...endings) : undefined);
}

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
    expect(readModel).toContain("'workflow_object'");
    expect(readModel).toContain(
      "Workflow state is owned by the operator, not by the engine.",
    );
  });

  it("emits workflow events in the public History vocabulary and selected account", () => {
    const branch = projectedBranch("decision_workflow_events");
    expect(branch).toContain("'decisions'");
    expect(branch).toContain("'recommendation'");
    expect(branch).toContain("'direct_provider_account_id'");
    expect(branch).toContain("'workflow_object'");
    expect(branch).toContain("INNER JOIN decision_workflow_state workflow_state");
    expect(branch).toContain("workflow_state.provider_account_id = $2");
    expect(branch).not.toContain("'decision_key'");
    expect(branch).not.toContain("'operator_workflow'");
  });

  it("emits provider attempts as write rows the History contract accepts", () => {
    const branch = projectedBranch("meta_ads_action_mutation_attempt_events");
    expect(branch).toContain("'writes'");
    expect(branch).toContain("'ad'");
    expect(branch).toContain("'direct_provider_account_id'");
    expect(branch).toContain("'provider_write_log'");
    expect(branch).not.toContain("'actions'");
    expect(branch).not.toContain("'exact_ad_key'");
    expect(branch).not.toContain("'provider_attempt'");
  });
});
