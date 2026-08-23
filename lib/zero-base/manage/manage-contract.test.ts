import { describe, expect, it } from "vitest";

import {
  DELETE_CEREMONY_NOTE,
  NO_UNIVERSAL_HEALTH,
  PLAN_GATES_NOTHING,
  RECOMMENDED_MODE_READ_ONLY,
  adaptProviderHealth,
  economicsDivergence,
  resolveCeremony,
} from "@/lib/zero-base/manage/manage-contract";

const PROVIDERS = ["meta", "google", "shopify"] as const;

describe("provider health is per provider", () => {
  it("adapts the boolean shape the status endpoint returns", () => {
    const rows = adaptProviderHealth({ meta: true, google: false, shopify: true }, PROVIDERS);
    expect(rows.map((r) => r.state.kind)).toEqual(["connected", "not_connected", "connected"]);
  });

  it("marks an unreported provider unknown, not disconnected", () => {
    // We did not read it, which is different from having read that it is absent.
    const rows = adaptProviderHealth({ meta: true }, PROVIDERS);
    expect(rows[1].state.kind).toBe("unknown");
    expect(rows[1].state.kind === "unknown" && rows[1].state.reason).toMatch(/not reported/);
  });

  it("surfaces a reconnect requirement with its reason", () => {
    const rows = adaptProviderHealth(
      { integrations: { meta: { status: "expired", message: "Token expired." } } },
      ["meta"],
    );
    expect(rows[0].state.kind).toBe("needs_reconnect");
    expect(rows[0].state.kind === "needs_reconnect" && rows[0].state.reason).toBe("Token expired.");
  });

  it("offers no universal health claim", () => {
    expect(NO_UNIVERSAL_HEALTH).toMatch(/says nothing about the others/);
  });
});

describe("a write is confirmed only by a separate read", () => {
  it("reports failure without claiming a change", () => {
    const outcome = resolveCeremony({ accepted: false, acceptError: "403 forbidden.", observed: null, observeError: null });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.detail).toMatch(/Nothing was changed/);
  });

  it("reports unknown when the read-back did not happen", () => {
    const outcome = resolveCeremony({ accepted: true, acceptError: null, observed: null, observeError: "HTTP 503" });
    expect(outcome.kind).toBe("unknown");
    expect(outcome.kind === "unknown" && outcome.detail).toMatch(/HTTP 503/);
  });

  it("reports unknown when the read-back disagrees", () => {
    const outcome = resolveCeremony({ accepted: true, acceptError: null, observed: false, observeError: null });
    // A 200 is an acknowledgement, not an observation.
    expect(outcome.kind).toBe("unknown");
  });

  it("confirms only when the read-back agrees", () => {
    expect(resolveCeremony({ accepted: true, acceptError: null, observed: true, observeError: null }).kind).toBe(
      "confirmed",
    );
  });

  it("says deletion is confirmed only by a read that no longer finds it", () => {
    expect(DELETE_CEREMONY_NOTE).toMatch(/never 'deleted'/);
  });
});

describe("economics divergence names sources and consumers", () => {
  const fields = [
    { key: "targetRoas", label: "Target ROAS", source: "Cost model", consumers: ["Decision engine"], value: "2.0" },
    { key: "targetRoas", label: "Target ROAS", source: "Commercial targets", consumers: ["Reports"], value: "2.6" },
  ];

  it("names both sources, both values and both consumers", () => {
    const result = economicsDivergence(fields);
    expect(result.diverged).toBe(true);
    // "These differ" is not actionable; naming which one the engine reads is.
    expect(result.message).toMatch(/Cost model says 2\.0 \(read by Decision engine\)/);
    expect(result.message).toMatch(/Commercial targets says 2\.6 \(read by Reports\)/);
  });

  it("reports no divergence when the values agree", () => {
    expect(economicsDivergence([fields[0], { ...fields[1], value: "2.0" }]).diverged).toBe(false);
  });

  it("treats an unset value as a divergence rather than a match", () => {
    const result = economicsDivergence([fields[0], { ...fields[1], value: null }]);
    expect(result.diverged).toBe(true);
    expect(result.message).toMatch(/says nothing/);
  });

  it("keeps recommendedMode read only", () => {
    expect(RECOMMENDED_MODE_READ_ONLY).toMatch(/cannot be set here/);
  });
});

describe("plan gating is stated, not denied", () => {
  /**
   * The previous expectation asserted the false claim.
   *
   * It said the copy must contain "No route or control in this product is
   * gated by it", which is how a sentence contradicted by five live PlanGates
   * survived: the test was pinning the wording, and the wording was wrong.
   */
  it("names the gated modules", () => {
    expect(PLAN_GATES_NOTHING).toContain("Creative Studio — Copies");
    expect(PLAN_GATES_NOTHING).toContain("Reports");
  });

  it("no longer claims the plan gates nothing", () => {
    expect(PLAN_GATES_NOTHING).not.toMatch(/No route or control/);
  });
});
