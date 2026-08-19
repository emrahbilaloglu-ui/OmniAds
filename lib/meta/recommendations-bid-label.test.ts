import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Bidding" read an em dash on accounts whose bid strategy was stored.
 *
 * The evidence rows read `row.bidStrategyLabel`, an optional convenience the
 * caller may leave null, while `bidStrategyType` comes straight from the
 * warehouse (`bid_cap`, `cost_cap`). Formatting the served type is presentation
 * — the same helper the config snapshot uses — not a re-derived verdict, and no
 * threshold or decision rule is involved.
 */
const source = readFileSync("lib/meta/recommendations.ts", "utf8");

describe("the bidding evidence rows fall back to the served strategy type", () => {
  it("never reads the optional label alone", () => {
    expect(source).not.toContain('value: row.bidStrategyLabel ?? "—"');
    expect(source).not.toContain(
      'row.isBidStrategyMixed ? "Mixed" : row.bidStrategyLabel ?? "—"',
    );
  });

  it("formats the warehouse column through the shared helper", () => {
    const helper = source.slice(
      source.indexOf("function bidStrategyDisplayLabel"),
      source.indexOf("export const META_HISTORY_RECENCY_HALF_LIFE_DAYS"),
    );
    expect(helper).toContain("formatBidStrategyLabel(row.bidStrategyType)");
    // An explicit label still wins, so a caller that did the work is respected.
    expect(helper).toContain("row.bidStrategyLabel?.trim()");
  });
});
