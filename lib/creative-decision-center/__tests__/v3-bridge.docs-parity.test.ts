import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
} from "../v3-bridge";

const MAPPING_DOC = "docs/creative-decision-center/V3_TO_V21_MAPPING.md";
const DECISION_LOG = "docs/creative-decision-center/DECISION_LOG.md";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("V3 bridge docs parity", () => {
  it("keeps D022 and the mapping doc in lockstep with the bridge contract", () => {
    const mappingDoc = read(MAPPING_DOC);
    const decisionLog = read(DECISION_LOG);

    expect(mappingDoc).toContain("V3BridgeMappedResult");
    expect(mappingDoc).toContain("V3BridgeOmittedResult");
    expect(mappingDoc).toContain("sourceDecision");
    expect(mappingDoc).toContain("labelTransform");
    expect(mappingDoc).toContain("campaign_context");
    expect(mappingDoc).toContain("Known PR7B-beta Coverage Gaps");
    expect(mappingDoc).toContain("import type");
    expect(mappingDoc).toContain(CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION);

    expect(decisionLog).toContain("D022");
    expect(decisionLog).toContain("labelTransform");
    expect(decisionLog).toContain("campaign context");
    expect(decisionLog).toContain("type-only");
    expect(decisionLog).toContain(CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION);
  });

  it("documents the current no-apply and no-live-write bridge boundary", () => {
    const mappingDoc = read(MAPPING_DOC);

    expect(mappingDoc).toContain("queueEligible: false");
    expect(mappingDoc).toContain("applyEligible: false");
    expect(mappingDoc).toContain("no live apply eligibility");
    expect(mappingDoc).toContain("does not call `decideCreative`");
    expect(mappingDoc).toContain("does not gain a new top-level");
  });
});
