import { describe, expect, it } from "vitest";
import { resolveCreativeDecisionEvidenceSource } from "@/lib/creative-decision-os-source";

describe("resolveCreativeDecisionEvidenceSource", () => {
  it("keeps live decision authority when only supporting sources are unreadable", () => {
    expect(
      resolveCreativeDecisionEvidenceSource({
        primary: "live",
        supporting: ["unknown", "live", "snapshot"],
        campaigns: "unknown",
        adSets: "unknown",
      }),
    ).toBe("live");
  });

  it("keeps snapshot primary rows contextual even if supporting sources are live", () => {
    expect(
      resolveCreativeDecisionEvidenceSource({
        primary: "snapshot",
        supporting: ["live", "live"],
        campaigns: "live",
        adSets: "live",
      }),
    ).toBe("snapshot");
  });

  it("keeps unknown primary rows contextual", () => {
    expect(
      resolveCreativeDecisionEvidenceSource({
        primary: "unknown",
        supporting: ["live", "live"],
        campaigns: "live",
        adSets: "live",
      }),
    ).toBe("unknown");
  });
});
