import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { META_HISTORY_KINDS, META_HISTORY_SOURCES } from "@/lib/meta/history-contract";

const readModel = readFileSync("lib/meta/history-read-model.ts", "utf8");
const historyView = readFileSync(
  "app/(dashboard)/platforms/meta/history/history-view.tsx",
  "utf8",
);

/**
 * "Did ROAS drop because something changed?" could only be answered for changes
 * this product made. History now carries observed provider changes too.
 */
describe("History carries externally-made changes", () => {
  it("declares the kind and the source", () => {
    expect(META_HISTORY_KINDS).toContain("external_changes");
    expect(META_HISTORY_SOURCES).toContain("meta_campaign_config_history");
  });

  it("projects config history through its own union arm", () => {
    expect(readModel).toContain("FROM meta_campaign_config_history config");
    expect(readModel).toContain("'external_changes',");
  });

  it("carries the previous value so the movement is visible, not just the new state", () => {
    expect(readModel).toContain("'previousDailyBudget', config.prev_daily_budget");
    // The predecessor now comes from LAG over the same ordering rather than a
    // per-row LATERAL: identical value, one sorted pass instead of 1.8M lookups.
    expect(readModel).toContain("LAG(config.daily_budget) OVER w");
    expect(readModel).toContain("ORDER BY config.captured_at");
  });

  it("only reports rows where something actually changed", () => {
    expect(readModel).toContain(
      "config.prev_daily_budget IS DISTINCT FROM config.daily_budget",
    );
  });

  it("is filterable in the History UI rather than being an unlabelled kind", () => {
    expect(historyView).toContain('external_changes: "External changes"');
  });
});

describe("attribution is done once, in the tested place", () => {
  it("calls the shared correlation instead of reimplementing it in SQL", () => {
    expect(readModel).toContain("attributeObservedChange(");
    expect(readModel).toContain("describeChangeOrigin(");
  });

  it("does not decide origin inside the query", () => {
    const arm = readModel.slice(
      readModel.indexOf("    'meta_campaign_config_history',"),
      readModel.indexOf("filtered_entries AS ("),
    );
    expect(arm).not.toContain("meta_ads_action_log");
    expect(arm).toContain("attributed from the action log when this row is presented");
  });

  it("weighs verification, not merely success, when claiming an action as ours", () => {
    expect(readModel).toContain('row.status === "success" && row.verified_at');
    expect(readModel).toContain('? "verified"');
  });

  it("passes the recorded actions into the row mapper", () => {
    expect(readModel).toContain("mapHistoryRow(row, input.account.currency, recordedActions)");
  });

  it("returns no actions rather than failing when the log table is absent", () => {
    const helper = readModel.slice(readModel.indexOf("readRecordedActionsForAttribution"));
    expect(helper.slice(0, 900)).toContain("if (!readiness?.ready) return [];");
  });
});
