import { describe, expect, it } from "vitest";
import {
  classifyDecisionDateFallback,
  describeDecisionDateFallback,
  isExpectedCapabilityGate,
} from "@/lib/meta/decision-date-fallback";

function pgError(code: string, message = "") {
  return Object.assign(new Error(message), { code });
}

describe("classifying a failed snapshot-date lookup", () => {
  it("separates a missing table from a missing column", () => {
    expect(classifyDecisionDateFallback(pgError("42P01"))).toBe("relation_missing");
    expect(classifyDecisionDateFallback(pgError("42703"))).toBe("column_missing");
  });

  it("recognises permission and timeout failures", () => {
    expect(classifyDecisionDateFallback(pgError("42501"))).toBe("permission_denied");
    expect(classifyDecisionDateFallback(pgError("57014"))).toBe("timeout");
  });

  it("falls back to the message when no SQLSTATE is present", () => {
    expect(
      classifyDecisionDateFallback(new Error('column "provider_account_id" does not exist')),
    ).toBe("column_missing");
    expect(
      classifyDecisionDateFallback(new Error('relation "engine_v3_x" does not exist')),
    ).toBe("relation_missing");
    expect(classifyDecisionDateFallback(new Error("permission denied for table x"))).toBe(
      "permission_denied",
    );
  });

  it("does not guess when the failure is unrecognised", () => {
    expect(classifyDecisionDateFallback(new Error("connection reset"))).toBe("unknown");
    expect(classifyDecisionDateFallback(null)).toBe("unknown");
    expect(classifyDecisionDateFallback(undefined)).toBe("unknown");
    expect(classifyDecisionDateFallback("not an error")).toBe("unknown");
  });
});

/**
 * The distinction this slice exists for: a table that has not been migrated yet
 * is a rollout state, while a column the schema never had is a defect. Both
 * previously vanished into the same empty catch block.
 */
describe("distinguishing a rollout state from a defect", () => {
  it("treats only a missing relation as an expected capability gate", () => {
    expect(isExpectedCapabilityGate("relation_missing")).toBe(true);
  });

  it("does not excuse a missing column as a capability gate", () => {
    expect(isExpectedCapabilityGate("column_missing")).toBe(false);
  });

  it("does not excuse permission, timeout or unknown failures", () => {
    expect(isExpectedCapabilityGate("permission_denied")).toBe(false);
    expect(isExpectedCapabilityGate("timeout")).toBe(false);
    expect(isExpectedCapabilityGate("unknown")).toBe(false);
  });
});

describe("descriptions", () => {
  it("says something specific for every cause", () => {
    const causes = [
      "relation_missing",
      "column_missing",
      "permission_denied",
      "timeout",
      "unknown",
    ] as const;
    const messages = causes.map((cause) => describeDecisionDateFallback(cause));
    expect(new Set(messages).size).toBe(causes.length);
    expect(messages.every((message) => message.length > 0)).toBe(true);
  });

  it("names the column case in terms an engineer can act on", () => {
    expect(describeDecisionDateFallback("column_missing")).toContain("column");
  });
});

describe("the route reports rather than swallows", () => {
  it("has no bare catch left in the workspace end-date resolver", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/meta/decisions-workspace/route.ts", "utf8");
    const resolver = source.slice(source.indexOf("async function resolveWorkspaceEndDate"));
    const body = resolver.slice(0, resolver.indexOf("\nasync function", 1));
    expect(body).not.toMatch(/\}\s*catch\s*\{/);
    expect(body).toContain("reportDecisionDateFallback");
  });
});
