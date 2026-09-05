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
  type ActivationGrain,
  type ActivationStepResult,
  type ActivationTarget,
  type HierarchyActivationDeps,
  type HierarchyActivationResult,
} from "@/lib/meta/hierarchy-activation";
import {
  validateActivationApproval,
  type ActivationApprovalRefusal,
} from "@/lib/meta/launch-activation-approval";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  findUnresolvedMetaAdStatusActionLog,
} from "@/lib/meta/ads-action-log";
import { recordMetaLaunchIntentActivation } from "@/lib/launchpad/meta-launch-intent-store";

/** The policy this build implements. An approval naming another is refused. */
export const ACTIVATION_POLICY_VERSION = "meta.activation-policy.v1" as const;

/**
 * The origin every activation claim is written under.
 *
 * Not `manual_operator_v1`: that origin means an operator confirmed THIS
 * status change on a decision card, and the ad-status claim path enforces its
 * own exact shape for it. Activation is its own decision with its own
 * authority — an operator on the receipt, or a stored approval and nobody at
 * all — and the action log has to be able to say which afterwards.
 */
export const LAUNCH_ACTIVATION_ORIGIN = "launch_activation_v1" as const;

/** The shape stored on the intent, versioned so a reader can tell what it is. */
export const LAUNCH_ACTIVATION_RECEIPT_CONTRACT =
  "meta.launch-activation-receipt.v1" as const;

export type LaunchActivationRefusal =
  | "intent_not_succeeded"
  | "receipt_absent"
  | "no_activatable_entities"
  | ActivationApprovalRefusal;

export type LaunchActivationResult =
  | { ok: true; activation: HierarchyActivationResult; receipt: LaunchActivationReceipt }
  | { ok: false; refusal: LaunchActivationRefusal };

/** What one step's provider call did, as the action log recorded it. */
export type ActivationClaimOutcome =
  /** The POST was made and the write adapter verified it. */
  | "activated"
  /** The POST was made and its outcome is unknown. Parked, never retried here. */
  | "ambiguous"
  /** The provider refused, definitely and without effect. */
  | "refused"
  /** A previous attempt on this entity is still unresolved. Nothing was sent. */
  | "unresolved_prior_attempt"
  /** The claim could not be written, so no call was made. */
  | "claim_unavailable";

export interface ActivationStepReceipt extends ActivationStepResult {
  /** The `meta_ads_action_log` row this step is recorded in, when there is one. */
  actionLogId: string | null;
  /** What the journal says happened, which is not always what the step says. */
  claimOutcome: ActivationClaimOutcome | null;
}

/**
 * The durable record of one activation attempt, stored on the intent.
 *
 * The response used to be the only place these steps existed. Reload the page
 * and a half-activated hierarchy looked exactly like one that had never been
 * attempted, which is the one thing an operator must never be shown about a
 * campaign that may now be spending.
 */
export interface LaunchActivationReceipt {
  contract: typeof LAUNCH_ACTIVATION_RECEIPT_CONTRACT;
  intentId: string;
  authorization: LaunchActivationAuthorization["kind"];
  operatorUserId: string | null;
  recordedAt: string;
  delivering: boolean;
  blockedAt: ActivationGrain | null;
  blockedReason: string | null;
  steps: ActivationStepReceipt[];
}

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
  /** The durable seam. Defaults to the action log every other Meta write uses. */
  journal?: ActivationJournal;
  /** Where the finished receipt is written. Defaults to the intent row. */
  persistReceipt?: (receipt: LaunchActivationReceipt) => Promise<void>;
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
      return runActivation(input, adOnly);
    }
  }

  return runActivation(input, targets);
}

/**
 * Run the plan, journalling every step and storing the receipt.
 *
 * The claim comes BEFORE the POST and the terminal status after it, which is
 * the whole point: a row that exists and is still `pending` is the durable
 * statement "a call may be in flight and nobody knows how it ended". That row
 * is what stops the next request from sending the same write again.
 */
async function runActivation(
  input: Parameters<typeof activateLaunchIntent>[0],
  targets: readonly ActivationTarget[],
): Promise<LaunchActivationResult> {
  const { intent } = input;
  const journal = input.journal ?? defaultActivationJournal;
  const claims = new Map<string, { actionLogId: string | null; outcome: ActivationClaimOutcome }>();

  const activation = await activateHierarchy({
    targets,
    deps: providerDeps({
      ctx: input.ctx,
      authorize: input.authorize,
      journal,
      businessId: intent.businessId,
      providerAccountId: intent.providerAccountId,
      launchIntentId: intent.id,
      operatorUserId: input.authorization.kind === "operator"
        ? input.authorization.operatorUserId
        : null,
      onClaim: (key, value) => claims.set(key, value),
    }),
  });

  const receipt: LaunchActivationReceipt = {
    contract: LAUNCH_ACTIVATION_RECEIPT_CONTRACT,
    intentId: intent.id,
    authorization: input.authorization.kind,
    operatorUserId: input.authorization.kind === "operator"
      ? input.authorization.operatorUserId
      : null,
    recordedAt: (input.now ?? new Date()).toISOString(),
    delivering: activation.delivering,
    blockedAt: activation.blockedAt,
    blockedReason: activation.blockedReason,
    steps: activation.steps.map((step) => {
      const claim = claims.get(`${step.grain}:${step.entityId}`) ?? null;
      return {
        ...step,
        actionLogId: claim?.actionLogId ?? null,
        claimOutcome: claim?.outcome ?? null,
      };
    }),
  };

  /*
    A receipt that cannot be stored does not invalidate what was written.

    The provider calls already happened; refusing to report them because the
    intent row would not take the receipt would hide a live campaign. The
    action-log rows are the durable record either way, so this failure is
    swallowed here and the response still tells the truth about the steps.
  */
  const persist = input.persistReceipt
    ?? ((value: LaunchActivationReceipt) =>
      recordMetaLaunchIntentActivation({
        businessId: intent.businessId,
        id: intent.id,
        receipt: value,
      }).then(() => undefined));
  await persist(receipt).catch(() => undefined);

  return { ok: true, activation, receipt };
}

/**
 * The creative the launch used, from its own request payload.
 *
 * The first two keys are the shapes this reader was written against and the
 * shipped payload carries NEITHER: a launch stores its creatives under
 * `creatives` (a list of refs, or of bare ids), and `creativeIds` on the
 * older shape. So this returned null for every real intent, and the scheduled
 * activation — whose approval names the creative it approved — refused every
 * one of them as `activation_approval_asset_mismatch`, a sentence about an
 * asset when the truth was that nobody had read it.
 */
function readCreativeId(intent: MetaLaunchIntent): string | null {
  const payload = intent.requestPayload as Record<string, unknown>;
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const direct = read(payload?.creativeId);
  if (direct) return direct;
  const reuse = payload?.reuseCreative as { creativeId?: unknown } | undefined;
  const reused = read(reuse?.creativeId);
  if (reused) return reused;
  const refs = Array.isArray(payload?.creatives) ? payload.creatives : [];
  for (const item of refs) {
    if (typeof item === "string") {
      const bare = read(item);
      if (bare) return bare;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const fromRef = read(record.creativeId) ?? read(record.id);
    if (fromRef) return fromRef;
  }
  const ids = payload?.creativeIds;
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const value = read(id);
      if (value) return value;
    }
  }
  return null;
}

/**
 * The durable machinery, behind one seam.
 *
 * Three functions, all of them already in `ads-action-log` and already used by
 * the manual ad-status path. Naming them here as an interface is what lets a
 * test drive the exact sequences that matter — an ambiguous prior attempt, a
 * claim that cannot be written — without a database, while production gets the
 * real table by default.
 */
export interface ActivationJournal {
  /**
   * Is there a prior attempt on this entity whose outcome nobody knows?
   *
   * `pending` (claimed, never terminalised) or a non-rehearsal
   * `silent_failure` with no reconciliation event: in both, the write may have
   * landed.
   */
  findUnresolved(input: {
    businessId: string;
    providerAccountId: string;
    entityId: string;
  }): Promise<{ id: string } | null>;
  /** Write the claim. Returns null if it could not be written. */
  claim(input: {
    businessId: string;
    providerAccountId: string;
    entityId: string;
    grain: ActivationGrain;
    launchIntentId: string;
    operatorUserId: string | null;
    /** What the entity was, read immediately before. The rollback record. */
    observed: { status: string | null; effectiveStatus: string | null };
  }): Promise<{ id: string } | null>;
  /** Terminalise the claim with what the provider actually did. */
  settle(input: {
    id: string;
    outcome: ActivationClaimOutcome;
    reason: string | null;
    durationMs: number;
  }): Promise<void>;
}

export const defaultActivationJournal: ActivationJournal = {
  findUnresolved: (input) =>
    findUnresolvedMetaAdStatusActionLog({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      // The column is `ad_id`, but it holds whichever entity the row is about;
      // the manual campaign and ad-set writes journal the same way.
      adId: input.entityId,
    }).then((row) => (row ? { id: row.id } : null)),
  claim: (input) =>
    createMetaAdsActionLog({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      adId: input.entityId,
      creativeId: null,
      action: "resume",
      source: LAUNCH_ACTIVATION_ORIGIN,
      requestedBy: input.operatorUserId,
      launchIntentId: input.launchIntentId,
      payloadRequest: {
        method: "POST",
        endpoint: `/${input.entityId}`,
        scope_type: input.grain,
        body: { status: "ACTIVE" },
        dry_run: false,
        action_origin: LAUNCH_ACTIVATION_ORIGIN,
        launch_intent_id: input.launchIntentId,
        /*
          The state this write is about to change, on the claim itself.

          It is written BEFORE the POST, so it survives an outcome nobody can
          read afterwards. A compensating action — putting the entity back —
          needs to know what "back" was, and after an ambiguous activation the
          provider can no longer be asked.
        */
        prior_state: {
          status: input.observed.status,
          effective_status: input.observed.effectiveStatus,
        },
        rollback: { operation: "set_status", status: input.observed.status },
      },
    }).then((row) => ({ id: row.id })),
  settle: (input) =>
    completeMetaAdsActionLog({
      id: input.id,
      /*
        `silent_failure` is this table's word for "the outcome is unknown", and
        it is exactly what `findUnresolvedMetaAdStatusActionLog` looks for. An
        ambiguous activation therefore blocks its own retry, which is the
        behaviour this whole path exists to get.
      */
      status: input.outcome === "activated"
        ? "success"
        : input.outcome === "ambiguous"
          ? "silent_failure"
          : "failure",
      errorCode: input.outcome === "activated" ? null : input.reason ?? "activation_refused",
      errorMessage: input.outcome === "activated"
        ? null
        : `Activation step ${input.outcome}.`,
      durationMs: input.durationMs,
      verifiedAt: input.outcome === "activated" ? new Date().toISOString() : null,
    }).then(() => undefined),
};

/**
 * One provider call, with a claim on either side of it.
 *
 * Before this, activation drove the resume primitives directly. A campaign
 * that came ACTIVE and an ad set that failed left no durable record anywhere:
 * the steps existed only in the response, History showed nothing, and an
 * ambiguous outcome was indistinguishable from a clean failure — so the next
 * request would blind-POST the same status change to somebody's live campaign.
 */
function providerDeps(input: {
  ctx: MetaAdsWriteContext;
  authorize?: (target: ActivationTarget) => Promise<string | null>;
  journal: ActivationJournal;
  businessId: string;
  providerAccountId: string;
  launchIntentId: string;
  operatorUserId: string | null;
  onClaim: (
    key: string,
    value: { actionLogId: string | null; outcome: ActivationClaimOutcome },
  ) => void;
}): HierarchyActivationDeps {
  /*
    One entry per step that reached the provider, keyed by grain and id.

    It exists because the claim is written before the POST and terminalised
    after the step's verdict, and those are two different callbacks. A step
    that never reached the provider simply has no entry.
  */
  const claimsInFlight = new Map<string, {
    actionLogId: string | null;
    outcome: ActivationClaimOutcome;
    startedAt: number;
    settled: boolean;
  }>();
  return {
    authorize: input.authorize,
    activate: async (target, observed) => {
      const key = `${target.grain}:${target.entityId}`;

      /*
        THE NO-BLIND-RETRY GATE.

        An unresolved prior attempt means the provider's answer is unknown: the
        write may have landed. Sending it again would be the second of two
        writes on a live entity. So it refuses, reports itself as ambiguous —
        which stops the sequence rather than failing it — and a person resolves
        the old row before anything else is sent.
      */
      const unresolved = await input.journal.findUnresolved({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        entityId: target.entityId,
      }).catch(() => null);
      if (unresolved) {
        const entry = {
          actionLogId: unresolved.id,
          outcome: "unresolved_prior_attempt" as const,
          startedAt: 0,
          settled: true,
        };
        claimsInFlight.set(key, entry);
        input.onClaim(key, {
          actionLogId: entry.actionLogId,
          outcome: entry.outcome,
        });
        return { ok: false, ambiguous: true, reason: "unresolved_prior_attempt" };
      }

      const claim = await input.journal.claim({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        entityId: target.entityId,
        grain: target.grain,
        launchIntentId: input.launchIntentId,
        operatorUserId: input.operatorUserId,
        observed,
      }).catch(() => null);
      // No claim, no call. Without the row there would be nothing to say a
      // request may be in flight, which is the one state that must never be
      // silently entered.
      if (!claim) {
        claimsInFlight.set(key, {
          actionLogId: null,
          outcome: "claim_unavailable",
          startedAt: 0,
          settled: true,
        });
        input.onClaim(key, { actionLogId: null, outcome: "claim_unavailable" });
        return { ok: false, reason: "activation_claim_unavailable" };
      }

      const startedAt = Date.now();
      const written = await activateOnce(input.ctx, target);
      claimsInFlight.set(key, {
        actionLogId: claim.id,
        outcome: written.ok ? "activated" : written.ambiguous ? "ambiguous" : "refused",
        startedAt,
        settled: false,
      });
      return written;
    },
    /*
      Terminalise from the VERDICT, not from the provider's answer.

      A write the adapter accepted whose independent read-back still says
      PAUSED is a successful call and a failed step. Settling from `activate`
      would have written `success` on a row about an ad set that is provably
      not on — and History would then show an activation that never happened.
    */
    onStepResult: async (step) => {
      const key = `${step.grain}:${step.entityId}`;
      const pending = claimsInFlight.get(key);
      // No claim means no call was made — already active, refused before the
      // POST, or never attempted. There is nothing to terminalise.
      if (!pending || pending.settled || pending.actionLogId === null) return;
      pending.settled = true;
      const outcome = claimOutcomeForStep(step, pending.outcome);
      input.onClaim(key, { actionLogId: pending.actionLogId, outcome });
      await input.journal.settle({
        id: pending.actionLogId,
        outcome,
        reason: step.reason ?? null,
        durationMs: Math.max(0, Date.now() - pending.startedAt),
      }).catch(() => undefined);
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
        const state = await readMetaAdExecutionState(input.ctx, target.entityId);
        if (!state.ok) return null;
        return {
          id: state.adId,
          status: state.configuredStatus,
          effectiveStatus: state.effectiveStatus,
        };
      }
      const state = await readMetaEntityExecutionState(
        input.ctx,
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

/** The provider write itself, unchanged: one call, one grain, no read-back. */
async function activateOnce(
  ctx: MetaAdsWriteContext,
  target: ActivationTarget,
): Promise<{ ok: boolean; ambiguous?: boolean; reason?: string | null }> {
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
}

/**
 * What the durable row should say, given the step's verdict and the call.
 *
 * The provider's answer decides the ambiguous cases — nothing else can — and
 * the verdict decides the rest. A write that was accepted and then read back
 * PAUSED is `refused`: definitely not active, and safe to attempt again,
 * unlike an outcome nobody could read.
 */
function claimOutcomeForStep(
  step: ActivationStepResult,
  provider: ActivationClaimOutcome,
): ActivationClaimOutcome {
  if (provider === "ambiguous") return "ambiguous";
  if (step.outcome === "activated") return "activated";
  if (step.outcome === "ambiguous") return "ambiguous";
  /*
    An unreadable verification is not a definite failure.

    The write was accepted and then nobody could confirm what it did. Recording
    that as a clean failure would let the next attempt POST again on the
    strength of a state nobody has seen, so it lands in the same bucket as an
    ambiguous provider outcome and blocks its own retry.
  */
  if (step.reason === "verification_unreadable") return "ambiguous";
  return "refused";
}
