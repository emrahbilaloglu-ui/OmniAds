import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A scope pill counts its SCOPE, not the first lane inside it.
 *
 * Both pills read a lane count. "Campaigns & Ad sets" printed 3 on Grandmix
 * against a served census of 1,230 entities, and "Creatives" printed 0 while 60
 * served rows rendered directly beneath it — every one of them lane `blocked`.
 * A counter that reports one lane tells the operator the scope is empty when it
 * is not, which is the same class of defect as a missing metric rendering as 0.
 *
 * Counting changes nothing about the rows: no row gains an action, a lane or a
 * classification by being counted, and an absent census stays an em dash rather
 * than falling back to a lane total that would misname itself as the scope.
 */
const ADAPTER = readFileSync(
  "components/meta/decision-center/meta-decision-center-exact-adapter.ts",
  "utf8",
);

describe("the scope counters count their scope", () => {
  const countsStart = ADAPTER.indexOf("\n    counts: {\n      /*");
  const countsEnd = ADAPTER.indexOf(
    "\n      action: structureActionCount,",
    countsStart,
  );

  if (countsStart === -1 || countsEnd <= countsStart) {
    throw new Error("Unable to locate the top-level scope counts block");
  }

  const block = ADAPTER.slice(countsStart, countsEnd);

  it("counts creatives from the served population, not the act lane", () => {
    expect(block).toContain("workspace.os?.ads?.items?.length");
    expect(block).not.toContain("os?.ads?.actCount");
  });

  it("counts structure from the served census, not the action lane", () => {
    expect(block).toContain("workspace.lanes.structureInventory?.length");
  });

  it("withholds rather than substituting a lane total when nothing is served", () => {
    // Two em dashes, one per scope: an unserved census is unknown, not zero.
    expect(block.match(/\?\? EM_DASH/g) ?? []).toHaveLength(2);
  });

  /**
   * The lane counters still start from the server's own totals.
   *
   * This law is about the SCOPE pills and is not licence to recount a lane from
   * whatever the table happens to be drawing. What the Needs Resolution lane
   * changed is only WHERE a row is counted: each counter is still
   * `workspace.lanes.counts.*`, with the blocked rows the queue actually moved
   * subtracted from it and added to the new lane. The sum is unchanged, and —
   * the property that matters — the split is taken over the payload's served
   * arrays rather than the filtered overrides, so a search term still cannot
   * make a lane counter fall.
   */
  it("leaves the lane counters starting from the server's own totals", () => {
    expect(ADAPTER).toMatch(
      /workspace\.lanes\.counts\.actionNow\s*-\s*servedActionSplit\.blocked\.length/,
    );
    expect(ADAPTER).toMatch(
      /workspace\.lanes\.counts\.watching\s*-\s*servedWatchingSplit\.blocked\.length/,
    );
  });

  it("splits the counters over the served arrays, never the filtered overrides", () => {
    // `overrides.actionNow` is the page's search/level-filtered array. If the
    // counters were split over it, every keystroke would shrink the account.
    expect(ADAPTER).toMatch(
      /const servedActionSplit\s*=\s*splitByServerLane\(\s*workspace\.lanes\.actionNow,\s*nodes,?\s*\);/,
    );
    expect(ADAPTER).toMatch(
      /const servedWatchingSplit\s*=\s*splitByServerLane\(\s*workspace\.lanes\.watching,\s*nodes,?\s*\);/,
    );
  });
});
