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
   * The OS is authoritative for Act/Blocked, while Watching counts only
   * recommendation-backed rows. `os.structure.monitorCount` includes ordinary
   * inventory with no decision and therefore cannot be presented as a count
   * of watched decisions.
   */
  it("counts recommendation-backed OS verdicts without calling grouping or Monitor inventory a decision", () => {
    expect(ADAPTER).toContain(
      "const osStructureDecisionCounts = structureDecisionLaneCounts(",
    );
    expect(ADAPTER).toContain("sourceRecommendationId");
    expect(ADAPTER).toContain(
      "const decisions = new Map<string, MetaOsStructureNode>()",
    );
    expect(ADAPTER).not.toContain("workspace.os?.structure?.monitorCount");
    expect(ADAPTER).toMatch(
      /const structureWatchingCount\s*=\s*servedProjection\.watching\.length\s*\+\s*unseenWatchingCount/,
    );
  });

  it("projects counters over the served arrays, never filtered overrides", () => {
    // `overrides.actionNow` is the page's search/level-filtered array. If the
    // counters were projected over it, every keystroke would shrink the
    // account.
    const start = ADAPTER.indexOf(
      "const servedProjection = projectStructureRecommendations({",
    );
    const end = ADAPTER.indexOf("\n  });", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const servedProjection = ADAPTER.slice(start, end);
    expect(servedProjection).toContain("action: workspace.lanes.actionNow");
    expect(servedProjection).toContain("watching: workspace.lanes.watching");
    expect(servedProjection).toContain("nonSales: workspace.lanes.nonSales");
    expect(servedProjection).not.toContain("overrides.");
  });
});
