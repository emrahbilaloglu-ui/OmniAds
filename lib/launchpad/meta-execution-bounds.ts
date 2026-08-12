export const META_LAUNCHPAD_EXECUTION_LIMITS = Object.freeze({
  maxCreatives: 20,
  maxAdSets: 10,
  maxTargets: 10,
  maxPlannedProviderCreates: 20,
});

export type MetaLaunchpadExecutionOperation =
  | "new_campaign"
  | "add_to_existing";

export interface MetaLaunchpadExecutionBoundsInput {
  operation: MetaLaunchpadExecutionOperation;
  creativeCount: number;
  adSetOrTargetCount: number;
  copyMode?: "reuse_creative" | "rebuild_creative";
}

export interface MetaLaunchpadExecutionBoundsIssue {
  code:
    | "launchpad_creative_limit_exceeded"
    | "launchpad_adset_limit_exceeded"
    | "launchpad_target_limit_exceeded"
    | "launchpad_provider_create_limit_exceeded";
  message: string;
}

export interface MetaLaunchpadExecutionBoundsResult {
  ok: boolean;
  counts: {
    creatives: number;
    adSetsOrTargets: number;
    plannedProviderCreates: number;
  };
  blockers: MetaLaunchpadExecutionBoundsIssue[];
}

function boundedCount(value: number) {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.trunc(value));
}

/**
 * Bounds the synchronous provider-write fan-out that one Launchpad request can
 * produce. This is an execution/recovery contract, not a UI recommendation.
 */
export function evaluateMetaLaunchpadExecutionBounds(
  input: MetaLaunchpadExecutionBoundsInput,
): MetaLaunchpadExecutionBoundsResult {
  const creatives = boundedCount(input.creativeCount);
  const adSetsOrTargets = boundedCount(input.adSetOrTargetCount);
  const plannedProviderCreates =
    input.operation === "new_campaign"
      ? 1 + adSetsOrTargets + creatives * adSetsOrTargets
      : creatives *
        adSetsOrTargets *
        (input.copyMode === "rebuild_creative" ? 2 : 1);
  const blockers: MetaLaunchpadExecutionBoundsIssue[] = [];

  if (creatives > META_LAUNCHPAD_EXECUTION_LIMITS.maxCreatives) {
    blockers.push({
      code: "launchpad_creative_limit_exceeded",
      message: `A Launchpad execution supports at most ${META_LAUNCHPAD_EXECUTION_LIMITS.maxCreatives} creatives.`,
    });
  }
  if (
    input.operation === "new_campaign" &&
    adSetsOrTargets > META_LAUNCHPAD_EXECUTION_LIMITS.maxAdSets
  ) {
    blockers.push({
      code: "launchpad_adset_limit_exceeded",
      message: `A new-campaign execution supports at most ${META_LAUNCHPAD_EXECUTION_LIMITS.maxAdSets} ad sets.`,
    });
  }
  if (
    input.operation === "add_to_existing" &&
    adSetsOrTargets > META_LAUNCHPAD_EXECUTION_LIMITS.maxTargets
  ) {
    blockers.push({
      code: "launchpad_target_limit_exceeded",
      message: `An add-to-existing execution supports at most ${META_LAUNCHPAD_EXECUTION_LIMITS.maxTargets} targets.`,
    });
  }
  if (
    plannedProviderCreates >
    META_LAUNCHPAD_EXECUTION_LIMITS.maxPlannedProviderCreates
  ) {
    blockers.push({
      code: "launchpad_provider_create_limit_exceeded",
      message: `A Launchpad execution supports at most ${META_LAUNCHPAD_EXECUTION_LIMITS.maxPlannedProviderCreates} planned provider creates.`,
    });
  }

  return {
    ok: blockers.length === 0,
    counts: {
      creatives,
      adSetsOrTargets,
      plannedProviderCreates,
    },
    blockers,
  };
}
