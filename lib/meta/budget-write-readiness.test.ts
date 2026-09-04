import { describe, expect, it } from "vitest";

import { buildBudgetWriteReadiness } from "@/lib/meta/budget-write-readiness";

describe("budget write readiness without a queued proposal", () => {
  it("states the empty queue without presenting a request-parser failure", () => {
    const model = buildBudgetWriteReadiness({
      businessId: "business_1",
      providerAccountId: "act_1",
      candidate: null,
      preflight: null,
      lastAttempt: null,
      runtime: {
        executionEnabled: false,
        proposalState: null,
        claimState: null,
        reconcileState: null,
        activationReadyBlockers: ["global_gate_closed"],
        activatedProviderAccountId: null,
      },
    });

    expect(model.proposal).toBeNull();
    expect(model.unavailableReason).toBe(
      "No budget proposal is currently awaiting execution.",
    );
    expect(model.execution.preflightBlockers).toEqual([]);
    expect(JSON.stringify(model)).not.toContain("request_not_an_object");
  });
});
