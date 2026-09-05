/**
 * Activating what a launch intent created.
 *
 * The intent may only create PAUSED entities, so somebody has to turn them on
 * afterwards. This is that step, and it is deliberately a different call with a
 * different authorization: an operator activating from the receipt is one
 * authority, an unattended activation is another, and the second needs a stored
 * approval naming the exact payload it approved.
 *
 * The plan comes from the RECEIPT, never from the request. The receipt is the
 * record of which entities actually exist, so an activation cannot be pointed
 * at something this launch did not produce, and a retry cannot create anything
 * — every step here only ever changes a status.
 *
 * An add-to-existing launch joins a live ad set, so its plan is the ad alone;
 * turning on the ad set it joined would change a campaign the operator did not
 * launch. A new-campaign launch created all three, so all three are its own.
 */
import {
  readMetaAdExecutionState,
  readMetaEntityExecutionState,
  resumeAd,
  resumeAdset,
  resumeCampaign,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import {
  activateHierarchy,
  type ActivationTarget,
  type HierarchyActivationDeps,
  type HierarchyActivationResult,
} from "@/lib/meta/hierarchy-activation";
import {
  validateActivationApproval,
  type ActivationApprovalRefusal,
} from "@/lib/meta/launch-activation-approval";

/** The policy this build implements. An approval naming another is refused. */
export const ACTIVATION_POLICY_VERSION = "meta.activation-policy.v1" as const;

export type LaunchActivationRefusal =
  | "intent_not_succeeded"
  | "receipt_absent"
  | "no_activatable_entities"
  | ActivationApprovalRefusal;

export type LaunchActivationResult =
  | { ok: true; activation: HierarchyActivationResult }
  | { ok: false; refusal: LaunchActivationRefusal };

/**
 * The entities this intent created, outside in.
 *
 * A partially-succeeded launch has an error receipt rather than a result one,
 * and its partial identities are just as real — the campaign it created is
 * live in the account whether or not the ad followed. Both are read, so a
 * half-finished launch can still be completed rather than stranded.
 */
export function activationPlanForIntent(
  intent: MetaLaunchIntent,
): ActivationTarget[] {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
  if (!receipt) return [];
  const targets: ActivationTarget[] = [];
  /*
    Only a launch that created its own campaign may activate one.

    An add-to-existing receipt names the campaign it joined, because the ad has
    to live somewhere. Activating that campaign would turn on somebody else's
    structure on the strength of having added one ad to it.
  */
  if (intent.operation === "new_campaign") {
    if (receipt.campaignId) {
      targets.push({ grain: "campaign", entityId: receipt.campaignId });
    }
    const adsetId = receipt.adsetIds?.[0] ?? null;
    if (adsetId) targets.push({ grain: "adset", entityId: adsetId });
  }
  const adId = receipt.adIds?.[0] ?? null;
  if (adId) targets.push({ grain: "ad", entityId: adId });
  return targets;
}

export type LaunchActivationAuthorization =
  /** An operator pressed Activate on the receipt. Their confirmation is real. */
  | { kind: "operator"; operatorUserId: string }
  /** Nobody is here. The stored approval is the entire authority. */
  | { kind: "scheduled" };

export async function activateLaunchIntent(input: {
  intent: MetaLaunchIntent;
  ctx: MetaAdsWriteContext;
  authorization: LaunchActivationAuthorization;
  /** Re-read before every step's own write, so a STOP mid-sequence is honoured. */
  authorize?: (target: ActivationTarget) => Promise<string | null>;
  now?: Date;
}): Promise<LaunchActivationResult> {
  const { intent } = input;
  if (intent.status !== "succeeded" && intent.status !== "partially_succeeded") {
    // Nothing was created, or the outcome is unknown. Neither is activatable.
    return { ok: false, refusal: "intent_not_succeeded" };
  }
  const targets = activationPlanForIntent(intent);
  if (targets.length === 0) {
    return {
      ok: false,
      refusal: intent.resultReceipt || intent.errorReceipt
        ? "no_activatable_entities"
        : "receipt_absent",
    };
  }

  if (input.authorization.kind === "scheduled") {
    const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
    const verdict = validateActivationApproval({
      stored: intent.activationApproval,
      intent: {
        id: intent.id,
        businessId: intent.businessId,
        providerAccountId: intent.providerAccountId,
        operation: intent.operation,
        requestFingerprint: intent.requestFingerprint,
      },
      identities: {
        campaignId: receipt?.campaignId ?? null,
        adsetId: receipt?.adsetIds?.[0] ?? null,
        adIds: receipt?.adIds ?? [],
        creativeId: readCreativeId(intent),
      },
      policyVersion: ACTIVATION_POLICY_VERSION,
      now: input.now,
    });
    if (!verdict.approved) return { ok: false, refusal: verdict.refusal };
    /*
      An `ad`-scoped approval activates the ad and nothing above it. The plan is
      narrowed rather than refused, because activating one ad in a live ad set
      is a perfectly good thing to have approved.
    */
    if (verdict.scope === "ad") {
      const adOnly = targets.filter((target) => target.grain === "ad");
      if (adOnly.length === 0) {
        return { ok: false, refusal: "no_activatable_entities" };
      }
      return {
        ok: true,
        activation: await activateHierarchy({
          targets: adOnly,
          deps: providerDeps(input.ctx, input.authorize),
        }),
      };
    }
  }

  return {
    ok: true,
    activation: await activateHierarchy({
      targets,
      deps: providerDeps(input.ctx, input.authorize),
    }),
  };
}

/** The creative the launch used, from its own request payload. */
function readCreativeId(intent: MetaLaunchIntent): string | null {
  const payload = intent.requestPayload as Record<string, unknown>;
  const direct = payload?.creativeId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const reuse = payload?.reuseCreative as { creativeId?: unknown } | undefined;
  if (typeof reuse?.creativeId === "string" && reuse.creativeId.trim()) {
    return reuse.creativeId.trim();
  }
  return null;
}

function providerDeps(
  ctx: MetaAdsWriteContext,
  authorize?: (target: ActivationTarget) => Promise<string | null>,
): HierarchyActivationDeps {
  return {
    authorize,
    activate: async (target) => {
      const written = target.grain === "campaign"
        ? await resumeCampaign(ctx, target.entityId)
        : target.grain === "adset"
          ? await resumeAdset(ctx, target.entityId)
          : await resumeAd(ctx, target.entityId);
      if (written.ok) return { ok: true };
      const ambiguous =
        written.error?.code === "provider_outcome_ambiguous"
        || written.providerOutcome === "outcome_ambiguous";
      return {
        ok: false,
        ambiguous,
        reason: written.error?.code ?? "activation_refused",
      };
    },
    /*
      Read back BY ID, and take both statuses.

      These readers already refuse an answer whose `id` is not the one asked
      for, and refuse an entity in a different ad account. A refusal returns
      `null` here, which the sequence treats as a stop — never as a paused
      entity, because "I could not read it" and "it is off" are different
      answers and only one of them is safe to build a next step on.
    */
    readState: async (target) => {
      if (target.grain === "ad") {
        const state = await readMetaAdExecutionState(ctx, target.entityId);
        if (!state.ok) return null;
        return {
          id: state.adId,
          status: state.configuredStatus,
          effectiveStatus: state.effectiveStatus,
        };
      }
      const state = await readMetaEntityExecutionState(
        ctx,
        target.grain,
        target.entityId,
      );
      if (!state.ok) return null;
      return {
        id: state.entityId,
        status: state.configuredStatus,
        effectiveStatus: state.effectiveStatus,
      };
    },
  };
}
