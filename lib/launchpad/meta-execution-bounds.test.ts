import { describe, expect, it } from "vitest";
import {
  META_LAUNCHPAD_EXECUTION_LIMITS,
  evaluateMetaLaunchpadExecutionBounds,
} from "@/lib/launchpad/meta-execution-bounds";

describe("evaluateMetaLaunchpadExecutionBounds", () => {
  it("accepts the exact total-create boundary for a new campaign", () => {
    expect(
      evaluateMetaLaunchpadExecutionBounds({
        operation: "new_campaign",
        creativeCount: 18,
        adSetOrTargetCount: 1,
      }),
    ).toEqual({
      ok: true,
      counts: {
        creatives: 18,
        adSetsOrTargets: 1,
        plannedProviderCreates:
          META_LAUNCHPAD_EXECUTION_LIMITS.maxPlannedProviderCreates,
      },
      blockers: [],
    });
  });

  it("rejects each new-campaign cardinality when it exceeds its bound", () => {
    const result = evaluateMetaLaunchpadExecutionBounds({
      operation: "new_campaign",
      creativeCount: META_LAUNCHPAD_EXECUTION_LIMITS.maxCreatives + 1,
      adSetOrTargetCount: META_LAUNCHPAD_EXECUTION_LIMITS.maxAdSets + 1,
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "launchpad_creative_limit_exceeded",
      "launchpad_adset_limit_exceeded",
      "launchpad_provider_create_limit_exceeded",
    ]);
  });

  it("accepts the exact add-to-existing create boundary", () => {
    expect(
      evaluateMetaLaunchpadExecutionBounds({
        operation: "add_to_existing",
        creativeCount: 20,
        adSetOrTargetCount: 1,
        copyMode: "reuse_creative",
      }),
    ).toMatchObject({
      ok: true,
      counts: {
        plannedProviderCreates:
          META_LAUNCHPAD_EXECUTION_LIMITS.maxPlannedProviderCreates,
      },
    });
  });

  it("counts recreated creatives and rejects target/create overages", () => {
    const result = evaluateMetaLaunchpadExecutionBounds({
      operation: "add_to_existing",
      creativeCount: 6,
      adSetOrTargetCount: META_LAUNCHPAD_EXECUTION_LIMITS.maxTargets + 1,
      copyMode: "rebuild_creative",
    });

    expect(result.ok).toBe(false);
    expect(result.counts.plannedProviderCreates).toBe(132);
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "launchpad_target_limit_exceeded",
      "launchpad_provider_create_limit_exceeded",
    ]);
  });
});
