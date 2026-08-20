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
  const block = ADAPTER.slice(
    ADAPTER.indexOf("counts: {"),
    ADAPTER.indexOf("action: workspace.lanes.counts.actionNow"),
  );

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

  it("leaves the lane counters reading their own lanes", () => {
    // The lane pills are correct as they are; this law is about the SCOPE pills
    // and must not be read as licence to change what a lane reports.
    expect(ADAPTER).toContain("action: workspace.lanes.counts.actionNow");
    expect(ADAPTER).toContain("watching: workspace.lanes.counts.watching");
  });
});
