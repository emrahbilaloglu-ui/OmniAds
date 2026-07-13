import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "scripts/creative-decision-center/native-structure-grain-paired-replay.ts",
  ),
  "utf8",
);

describe("native structure replay operational guardrails", () => {
  it("opens a read-only transaction and never contains database/provider writes", () => {
    expect(source).toContain(
      '"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"',
    );
    expect(source).toContain('"SHOW transaction_read_only"');
    expect(source).toContain('client.query("ROLLBACK")');
    expect(source).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i,
    );
    expect(source).not.toContain("/api/sync/cron");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("uses the declared fixed-period protocol instead of a generic split", () => {
    expect(source).toContain('const DEFAULT_START_DATE = "2025-12-01"');
    expect(source).toContain('const DEFAULT_DECISION_END_DATE = "2026-07-05"');
    expect(source).toContain("buildStructureReplayProtocol({");
    expect(source).toContain("anchorDate: STRUCTURE_REPLAY_CADENCE_ANCHOR");
    expect(source).toContain(
      "protocol.phases.development.eligibleDatesByWindow",
    );
    expect(source).toContain(
      "protocol.phases.calibration.eligibleDatesByWindow",
    );
    expect(source).toContain(
      "protocol.phases.locked_test.eligibleDatesByWindow",
    );
    expect(source).toContain("eligibleDates.has(opportunity.asOfDate)");
    expect(source).not.toContain("splitOpportunityDates");
    expect(source).not.toMatch(/Math\.ceil\([^\n]*0\.7/);
  });

  it("builds independent 3d, 7d, and 14d outcomes from dated completeness receipts", () => {
    expect(source).toContain(
      "for (const windowDays of STRUCTURE_OUTCOME_WINDOWS)",
    );
    expect(source).toContain("offset <= input.windowDays");
    expect(source).toContain("completeAccountDays.has(");
    expect(source).toContain(
      "opportunity.outcomes[windowDays] = windowOutcome",
    );
    expect(source).toContain("projectStructureOpportunityWindow(");
    expect(source).toContain("completeAccountDays: hashSortedJsonRows(");
    expect(source).toContain("opportunityEvidence: hashSortedJsonRows(");
  });

  it("cutoff-gates config, target, and future budget observations", () => {
    expect(
      source.match(/captured_at <= o\.(?:cutoff|outcome_cutoff)/g)?.length,
    ).toBe(6);
    expect(source).toContain("meta_campaign_config_history");
    expect(source).toContain("meta_adset_config_history");
    expect(source).toContain("business_target_pack_history");
    expect(source).toContain("business_target_packs p");
    expect(source).toContain("t.effective_at <= o.cutoff");
    expect(source).toContain("t.recorded_at <= o.cutoff");
    expect(source).toContain("p.updated_at <= o.cutoff");
    expect(source).toContain("business_target_packs_cutoff_safe_scd0");
    expect(source).toContain("LEAST(d.date + 15, $3::date + 1)");
    expect(source).toContain("resolveBusinessTargetPackFreshness(");
  });

  it("hydrates bid strategy/value and explicit budget owner/origin without fallback authority", () => {
    expect(source).toContain(
      "campaign_cfg.bid_strategy_type AS campaign_bid_strategy",
    );
    expect(source).toContain(
      "adset_cfg.bid_strategy_type AS adset_bid_strategy",
    );
    expect(source).toContain("campaign_cfg.bid_value AS campaign_bid_value");
    expect(source).toContain("adset_cfg.bid_value AS adset_bid_value");
    expect(source).toContain("normalizeStructureBidRegime({");
    expect(source).toContain("budgetOrigin: owner.origin");
    expect(source).toContain(
      "bidContextReconstructable: bidContext.reconstructable",
    );
  });

  it("keeps purchase economics and non-purchase efficiency on separate math paths", () => {
    expect(source).toContain("calculateStructureWeightedMetrics({");
    expect(source).toContain("futureCostPerResult");
    expect(source).toContain("cohort: opportunity.cohort");
    expect(source).toContain("targetRoas:");
    expect(source).toContain("breakEvenRoas:");
    expect(source).toContain("peerCostPerResultP25");
  });

  it("uses only grain-correct structure actions", () => {
    expect(source).toContain('"increase_campaign_budget"');
    expect(source).toContain('"increase_adset_budget"');
    expect(source).not.toContain('"cut_ad"');
    expect(source).not.toContain('"promote_to_main"');
  });

  it("materializes the finite weekday-seasonality grid and currency-isolated gates", () => {
    expect(source).toMatch(
      /for \(const seasonality of H9_STRUCTURE_HISTORY_GRID\.seasonalityModes\)/,
    );
    expect(source).toContain("const historyKey = structureHistorySignalKey({");
    expect(source).toContain("opportunity.history[historyKey] = {");
    expect(source).not.toContain("opportunity.history[halfLifeDays]");
    expect(source).toContain("for (const currency of currencies)");
    expect(source).toContain("opportunity.currency === input.currency");
    expect(source).toContain("variantCount: input.variants.length");
    expect(source).toContain("H9_ANNUAL_SEASONALITY_ELIMINATION");
  });
});
