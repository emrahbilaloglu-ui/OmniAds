import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two-way pin between docs/meta-serving-history-contract.md and the code it
// contracts. The present-config-over-history behavior in lib/meta/serving.ts
// was reclassified from "anachronism debt" to an explicit deliberate
// contract; these assertions keep the doc and the code from drifting apart
// (same discipline as components/meta/redesign/doc-contract.test.ts).
const DOC_PATH = "docs/meta-serving-history-contract.md";
const SERVING_PATH = "lib/meta/serving.ts";

describe("meta serving history contract stays consistent with code", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const serving = readFileSync(SERVING_PATH, "utf8");

  it("the override sites carry the contract marker and the doc exists", () => {
    expect(serving).toContain("PRESENT-CONFIG-OVER-HISTORY CONTRACT");
    expect(serving).toContain("docs/meta-serving-history-contract.md");
    expect(doc).toContain("present-config-over-history");
  });

  it("symbols the doc cites as code stay alive in the source", () => {
    for (const symbol of [
      "getMetaWarehouseCampaigns",
      "buildAdSetTableRow",
      "repairMetaWarehouseTruthRange",
      "readMetaBidRegimeHistorySummaries",
    ]) {
      expect(doc, `doc must cite ${symbol}`).toContain(symbol);
    }
    expect(serving).toContain("function getMetaWarehouseCampaigns");
    expect(serving).toContain("function buildAdSetTableRow");
    const repair = readFileSync("lib/meta/repair.ts", "utf8");
    expect(repair).toContain("repairMetaWarehouseTruthRange");
  });

  it("the contracted behavior is still asserted by the serving tests", () => {
    // The behavioral pin lives in serving.test.ts; if that test is renamed
    // or deleted, the contract doc's claim about it must be revisited.
    const servingTests = readFileSync("lib/meta/serving.test.ts", "utf8");
    expect(servingTests).toContain(
      "returns campaign current config from typed history instead of warehouse fact config",
    );
  });

  it("the request-path guard for the repair exports is still wired", () => {
    // The doc's claim that repair backfill is script-only rests on this
    // guard naming the exports; renaming them silently drops the guard.
    const guard = readFileSync("scripts/check-request-path-side-effects.ts", "utf8");
    expect(guard).toContain("repairCampaignRowsFromSnapshots");
    expect(guard).toContain("repairAdSetRowsFromSnapshots");
    expect(serving).toContain("repairCampaignRowsFromSnapshots");
    expect(serving).toContain("repairAdSetRowsFromSnapshots");
  });
});
