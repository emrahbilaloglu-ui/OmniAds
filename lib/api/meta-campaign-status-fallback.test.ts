import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A campaign the config response missed must not be written with a null status.
 *
 * The system records every entity's status in `meta_entity_state_history` from
 * the same fetch, so "we did not see it this run" and "it has no status" are
 * different facts — and collapsing them cost a real account its numbers: the
 * five Grandmix campaigns carrying $34,612 of a $36,451 window were exactly the
 * ones the config response omitted, so their daily rows carried a null status,
 * the active filter dropped them, and the Decision Center reported ROAS 0.00
 * and $0 spend for an account spending over $1k a day.
 *
 * Pinned on the call because the defect is invisible to a correctness test:
 * every value written was true, one was simply missing.
 */
const source = readFileSync("lib/api/meta.ts", "utf8");

describe("the daily campaign writer falls back to the recorded status", () => {
  it("looks up the entity state for campaigns the response did not carry", () => {
    expect(source).toContain("const missingStatusCampaignIds");
    expect(source).toContain("readMetaEntityStatesAsOf({");
    expect(source).toContain('entityType: "campaign"');
  });

  it("only claims a status for an entity last seen present", () => {
    const block = source.slice(
      source.indexOf("const missingStatusCampaignIds"),
      source.indexOf("campaignRows = Array.from(aggregates.campaigns.entries())"),
    );
    // A provider that stopped returning an entity is not evidence of its status.
    expect(block).toContain('if (state.presence !== "present") continue;');
    expect(block).toContain("state.effectiveStatus ?? state.configuredStatus");
  });

  it("gives ad sets the same recovery, not just campaigns", () => {
    expect(source).toContain("const recoveredAdsetStatuses");
    expect(source).toContain('entityType: "adset"');
    // The ad set row must consult the recovery before yielding null.
    expect(source).toContain("recoveredAdsetStatuses.get(adsetId) ??");
  });
});
