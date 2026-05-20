import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
} from "../contracts";

const CONTRACTS_DOC = "docs/creative-decision-center/CONTRACTS.md";

function parseStringUnion(typeName: string): string[] {
  const source = readFileSync(CONTRACTS_DOC, "utf8");
  const pattern = new RegExp(`type ${typeName} =([\\s\\S]*?);`);
  const match = source.match(pattern);
  if (!match) throw new Error(`Missing ${typeName} in ${CONTRACTS_DOC}`);

  return Array.from(match[1].matchAll(/"([^"]+)"/g), ([, value]) => value);
}

describe("Creative Decision Center contracts doc parity", () => {
  it("keeps primary decision literals in lockstep with CONTRACTS.md", () => {
    expect(parseStringUnion("CreativeDecisionOsV21PrimaryDecision")).toEqual([
      ...CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
    ]);
  });

  it("keeps row buyer action literals in lockstep with CONTRACTS.md", () => {
    expect(parseStringUnion("CreativeDecisionCenterBuyerAction")).toEqual([
      ...CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
    ]);
  });

  it("keeps aggregate action literals in lockstep with CONTRACTS.md", () => {
    expect(parseStringUnion("CreativeDecisionCenterAggregateAction")).toEqual([
      ...CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
    ]);
  });
});
