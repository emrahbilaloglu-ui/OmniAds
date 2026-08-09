import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import {
  appendManualMetaAdStatusReconciliationEvent,
  readManualMetaAdStatusReconciliationCandidate,
  type ManualMetaAdStatusReconciliationCandidate,
  type ManualMetaAdStatusReconciliationEvent,
  type ManualMetaAdStatusReconciliationResolution,
} from "@/lib/meta/ads-action-log";
import {
  readMetaAdExecutionState,
  type MetaAdExecutionStateRead,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

type ExactMetaAdExecutionState = Extract<
  MetaAdExecutionStateRead,
  { ok: true }
>;

export type ManualMetaAdStatusReconciliationResult =
  | {
      disposition: "not_needed";
      candidate: ManualMetaAdStatusReconciliationCandidate;
    }
  | {
      disposition: "waiting";
      candidate: ManualMetaAdStatusReconciliationCandidate;
    }
  | {
      disposition: "blocked";
      candidate: ManualMetaAdStatusReconciliationCandidate;
      blocker:
        | "reconciliation_candidate_invalid"
        | "provider_state_inconclusive"
        | "reconciliation_race_unresolved";
    }
  | {
      disposition: "unavailable";
      candidate: ManualMetaAdStatusReconciliationCandidate | null;
      blocker:
        | "reconciliation_state_unavailable"
        | "provider_state_unavailable"
        | "reconciliation_persistence_unavailable";
    }
  | {
      disposition: "reconciled";
      candidate: ManualMetaAdStatusReconciliationCandidate;
      event: ManualMetaAdStatusReconciliationEvent | null;
      state: ExactMetaAdExecutionState;
      resolution: ManualMetaAdStatusReconciliationResolution;
    };

function normalizedProviderAccountId(value: string | null | undefined) {
  const numeric = value?.trim().replace(/^act_/i, "") ?? "";
  return numeric ? `act_${numeric}` : "";
}

function normalizedStatus(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

export function exactManualMetaAdReconciliationObservation(input: {
  candidate: ManualMetaAdStatusReconciliationCandidate;
  state: MetaAdExecutionStateRead;
  expectedCreativeId: string;
}):
  | {
      ok: true;
      state: ExactMetaAdExecutionState;
      resolution: ManualMetaAdStatusReconciliationResolution;
    }
  | { ok: false; blocker: "provider_state_inconclusive" } {
  const { candidate, state } = input;
  if (
    !state.ok ||
    !candidate.sourceActionLogId ||
    !candidate.action ||
    !candidate.creativeId ||
    !candidate.campaignId ||
    !candidate.adsetId ||
    state.adId !== candidate.adId ||
    normalizedProviderAccountId(state.providerAccountId) !==
      normalizedProviderAccountId(candidate.providerAccountId) ||
    state.creativeId !== candidate.creativeId ||
    state.creativeId !== input.expectedCreativeId ||
    state.campaignId !== candidate.campaignId ||
    state.adsetId !== candidate.adsetId ||
    state.policyEligible !== true ||
    state.reviewStatus !== null ||
    !state.providerGetEvidence
  ) {
    return { ok: false, blocker: "provider_state_inconclusive" };
  }

  const configuredStatus = normalizedStatus(state.configuredStatus);
  const effectiveStatus = normalizedStatus(state.effectiveStatus);
  if (
    (configuredStatus !== "ACTIVE" && configuredStatus !== "PAUSED") ||
    effectiveStatus !== configuredStatus ||
    normalizedStatus(state.campaignConfiguredStatus) !== "ACTIVE" ||
    normalizedStatus(state.campaignEffectiveStatus) !== "ACTIVE" ||
    normalizedStatus(state.adsetConfiguredStatus) !== "ACTIVE" ||
    normalizedStatus(state.adsetEffectiveStatus) !== "ACTIVE"
  ) {
    return { ok: false, blocker: "provider_state_inconclusive" };
  }

  const requestedStatus =
    candidate.action === "pause" ? "PAUSED" : "ACTIVE";
  return {
    ok: true,
    state,
    resolution:
      configuredStatus === requestedStatus
        ? "current_state_matches_requested"
        : "current_state_matches_precondition",
  };
}

async function readCandidate(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}) {
  return readManualMetaAdStatusReconciliationCandidate(input);
}

/**
 * Clears only a settled manual pause/resume quarantine. It performs no
 * provider mutation. The provider GET is outside the DB lock; event append
 * revalidates the same source authority under the shared claim lock.
 */
export async function reconcileManualMetaAdStatusBlocker(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  expectedCreativeId: string;
  ctx: MetaAdsWriteContext;
}): Promise<ManualMetaAdStatusReconciliationResult> {
  let candidate: ManualMetaAdStatusReconciliationCandidate;
  try {
    candidate = await readCandidate(input);
  } catch {
    return {
      disposition: "unavailable",
      candidate: null,
      blocker: "reconciliation_state_unavailable",
    };
  }

  if (candidate.blockerReason === "no_unresolved_manual_source") {
    return { disposition: "not_needed", candidate };
  }
  if (
    candidate.blockerReason === "settlement_not_elapsed" ||
    (!candidate.readyForProviderRead && candidate.blockerReason === null)
  ) {
    return { disposition: "waiting", candidate };
  }
  if (candidate.blockerReason !== null || !candidate.readyForProviderRead) {
    return {
      disposition: "blocked",
      candidate,
      blocker: "reconciliation_candidate_invalid",
    };
  }

  const state = await readMetaAdExecutionState(input.ctx, input.adId).catch(
    () => null,
  );
  if (!state || !state.ok) {
    return {
      disposition: "unavailable",
      candidate,
      blocker: "provider_state_unavailable",
    };
  }
  const observation = exactManualMetaAdReconciliationObservation({
    candidate,
    state,
    expectedCreativeId: input.expectedCreativeId,
  });
  if (!observation.ok) {
    return {
      disposition: "blocked",
      candidate,
      blocker: observation.blocker,
    };
  }

  let event: ManualMetaAdStatusReconciliationEvent | null = null;
  try {
    event = await appendManualMetaAdStatusReconciliationEvent({
      sourceActionLogId: candidate.sourceActionLogId!,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      adId: input.adId,
      action: candidate.action!,
      resolution: observation.resolution,
      observedStatus:
        normalizedStatus(observation.state.configuredStatus) === "PAUSED"
          ? "PAUSED"
          : "ACTIVE",
      observedEffectiveStatus:
        observation.state.effectiveStatus ?? "",
      observedAt: observation.state.observedAt,
      resolvedTarget: {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        adId: input.adId,
        creativeId: input.expectedCreativeId,
        campaignId: candidate.campaignId!,
        adsetId: candidate.adsetId!,
      },
      providerGetEvidence: observation.state.providerGetEvidence!,
    });
  } catch {
    let raced: ManualMetaAdStatusReconciliationCandidate | null = null;
    try {
      raced = await readCandidate(input);
    } catch {
      return {
        disposition: "unavailable",
        candidate,
        blocker: "reconciliation_persistence_unavailable",
      };
    }
    if (raced.blockerReason !== "no_unresolved_manual_source") {
      return {
        disposition:
          raced.blockerReason === "settlement_not_elapsed"
            ? "waiting"
            : "blocked",
        candidate: raced,
        ...(raced.blockerReason === "settlement_not_elapsed"
          ? {}
          : { blocker: "reconciliation_race_unresolved" as const }),
      } as ManualMetaAdStatusReconciliationResult;
    }
  }

  let remaining: ManualMetaAdStatusReconciliationCandidate;
  try {
    remaining = await readCandidate(input);
  } catch {
    return {
      disposition: "unavailable",
      candidate,
      blocker: "reconciliation_state_unavailable",
    };
  }
  if (remaining.blockerReason !== "no_unresolved_manual_source") {
    return {
      disposition: "blocked",
      candidate: remaining,
      blocker: "reconciliation_race_unresolved",
    };
  }

  // Section 9, server-owned: an ambiguous outcome has been resolved against a
  // fresh exact read. Only the reconciliation path knows this happened, and it
  // is the event that closes the ambiguity the operator was left holding.
  await recordProductInstrumentationEvent({
    businessId: input.businessId,
    scope: "business",
    eventName: "guarded_action_reconciled",
    surface: "meta_decision_inspector",
    outcome: "ok",
    provider: "meta",
    occurredAt: new Date().toISOString(),
  });

  return {
    disposition: "reconciled",
    candidate,
    event,
    state: observation.state,
    resolution: observation.resolution,
  };
}
