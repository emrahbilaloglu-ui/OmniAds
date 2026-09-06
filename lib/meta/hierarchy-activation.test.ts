import { describe, expect, it, vi } from "vitest";

import {
  activateHierarchy,
  type ActivationTarget,
  type HierarchyActivationDeps,
} from "@/lib/meta/hierarchy-activation";

const PLAN: ActivationTarget[] = [
  { grain: "ad", entityId: "ad_1" },
  { grain: "campaign", entityId: "camp_1" },
  { grain: "adset", entityId: "set_1" },
];

/**
 * A provider whose state is a map, so a step's write is visible to the next
 * step's read — which is what makes the ordering assertions mean anything.
 */
function fakeProvider(initial: Record<string, "ACTIVE" | "PAUSED">, options: {
  refuse?: Record<string, string>;
  ambiguous?: string[];
  unreadable?: string[];
  effectiveOverride?: Record<string, string>;
} = {}) {
  const state = { ...initial };
  const order: string[] = [];
  const deps: HierarchyActivationDeps = {
    activate: vi.fn(async (target) => {
      order.push(`write:${target.entityId}`);
      if (options.ambiguous?.includes(target.entityId)) {
        return { ok: false, ambiguous: true, reason: "provider_outcome_ambiguous" };
      }
      const refusal = options.refuse?.[target.entityId];
      if (refusal) return { ok: false, reason: refusal };
      state[target.entityId] = "ACTIVE";
      return { ok: true };
    }),
    readState: vi.fn(async (target) => {
      order.push(`read:${target.entityId}`);
      if (options.unreadable?.includes(target.entityId)) return null;
      return {
        id: target.entityId,
        status: state[target.entityId] ?? "PAUSED",
        effectiveStatus:
          options.effectiveOverride?.[target.entityId]
          ?? state[target.entityId]
          ?? "PAUSED",
      };
    }),
  };
  return { deps, order, state };
}

describe("activation runs outside in and proves each step by id", () => {
  it("activates campaign, then ad set, then ad, and only then says delivering", async () => {
    const { deps, order } = fakeProvider({
      camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED",
    });

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.delivering).toBe(true);
    expect(result.blockedAt).toBeNull();
    // The plan was given ad-first; the order is the delivery order regardless.
    expect(order.filter((entry) => entry.startsWith("write:"))).toEqual([
      "write:camp_1", "write:set_1", "write:ad_1",
    ]);
    expect(result.steps.map((step) => step.grain))
      .toEqual(["campaign", "adset", "ad"]);
  });

  it("stops at the blocked step and never calls the ad a live one", async () => {
    const { deps } = fakeProvider(
      { camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED" },
      { refuse: { set_1: "adset_in_review" } },
    );

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.blockedAt).toBe("adset");
    expect(result.blockedReason).toBe("adset_in_review");
    expect(result.delivering).toBe(false);
    // The campaign really is on. Nothing rolls it back to make the row tidy.
    expect(result.steps[0]!.outcome).toBe("activated");
    // And the ad was never touched.
    expect(result.steps[2]!.outcome).toBe("not_attempted");
    expect(vi.mocked(deps.activate)).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "ad_1" }),
    );
  });

  it("refuses to call an ad live under a paused parent, even when its own status is ACTIVE", async () => {
    /*
      The exact lie this module exists to prevent: Meta reports the ad's
      configured status as ACTIVE while its effective status says the parent is
      off. Reading only `status` would report a delivering ad that shows to
      nobody.
    */
    const { deps } = fakeProvider(
      { camp_1: "ACTIVE", set_1: "ACTIVE", ad_1: "PAUSED" },
      { effectiveOverride: { ad_1: "CAMPAIGN_PAUSED" } },
    );

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.delivering).toBe(false);
    expect(result.blockedAt).toBe("ad");
    expect(result.blockedReason).toBe("verified_not_active");
    expect(result.steps[2]!.verified).toEqual({
      status: "ACTIVE", effectiveStatus: "CAMPAIGN_PAUSED",
    });
  });
});

describe("a retry resumes and duplicates nothing", () => {
  it("sends no write for a step that is already active", async () => {
    const { deps, order } = fakeProvider({
      camp_1: "ACTIVE", set_1: "ACTIVE", ad_1: "PAUSED",
    });

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.delivering).toBe(true);
    expect(result.steps[0]!.outcome).toBe("already_active");
    expect(result.steps[1]!.outcome).toBe("already_active");
    expect(result.steps[2]!.outcome).toBe("activated");
    // One write, for the one step that needed it.
    expect(order.filter((entry) => entry.startsWith("write:")))
      .toEqual(["write:ad_1"]);
  });

  it("completes the blocked step on the second run without re-sending the first", async () => {
    const state: Record<string, "ACTIVE" | "PAUSED"> = {
      camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED",
    };
    const first = fakeProvider(state, { refuse: { set_1: "adset_in_review" } });
    const blocked = await activateHierarchy({ targets: PLAN, deps: first.deps });
    expect(blocked.blockedAt).toBe("adset");

    // The campaign stayed on between runs, which is the point.
    const second = fakeProvider({ ...first.state });
    const retried = await activateHierarchy({ targets: PLAN, deps: second.deps });

    expect(retried.delivering).toBe(true);
    expect(second.order.filter((entry) => entry.startsWith("write:")))
      .toEqual(["write:set_1", "write:ad_1"]);
  });
});

describe("an unknown answer is neither a success nor a failure", () => {
  it("parks at the ambiguous step and attempts nothing after it", async () => {
    const { deps } = fakeProvider(
      { camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED" },
      { ambiguous: ["camp_1"] },
    );

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.steps[0]!.outcome).toBe("ambiguous");
    expect(result.blockedAt).toBe("campaign");
    expect(result.delivering).toBe(false);
    expect(result.steps.slice(1).every((step) => step.outcome === "not_attempted"))
      .toBe(true);
  });

  it("treats an unreadable state as a stop, never as a paused entity", async () => {
    const { deps } = fakeProvider(
      { camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED" },
      { unreadable: ["camp_1"] },
    );

    const result = await activateHierarchy({ targets: PLAN, deps });

    expect(result.blockedAt).toBe("campaign");
    expect(result.blockedReason).toBe("state_unreadable");
    expect(vi.mocked(deps.activate)).not.toHaveBeenCalled();
  });
});

describe("the authority is re-read before every step", () => {
  it("asks once per step and stops where it refuses", async () => {
    const { deps } = fakeProvider({
      camp_1: "PAUSED", set_1: "PAUSED", ad_1: "PAUSED",
    });
    const asked: string[] = [];
    const result = await activateHierarchy({
      targets: PLAN,
      deps: {
        ...deps,
        authorize: async (target) => {
          asked.push(target.grain);
          // The operator engages the STOP between the campaign and the ad set.
          return target.grain === "adset" ? "kill_switch_engaged" : null;
        },
      },
    });

    expect(asked).toEqual(["campaign", "adset"]);
    expect(result.blockedAt).toBe("adset");
    expect(result.blockedReason).toBe("kill_switch_engaged");
    // The already-activated campaign is not undone.
    expect(result.steps[0]!.outcome).toBe("activated");
  });
});

describe("the plan only contains grains the launch actually created", () => {
  it("activates one ad without touching a live parent", async () => {
    const { deps, order } = fakeProvider({ ad_1: "PAUSED" });

    const result = await activateHierarchy({
      targets: [{ grain: "ad", entityId: "ad_1" }],
      deps,
    });

    expect(result.delivering).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(order.filter((entry) => entry.startsWith("write:")))
      .toEqual(["write:ad_1"]);
  });
});
