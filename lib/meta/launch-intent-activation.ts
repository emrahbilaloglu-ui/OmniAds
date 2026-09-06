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
  type HierarchyActivationCoverage,
  type HierarchyActivationDeps,
  type HierarchyActivationResult,
} from "@/lib/meta/hierarchy-activation";
import {
  validateActivationApproval,
  type ActivationApprovalRefusal,
} from "@/lib/meta/launch-activation-approval";
import {
  completeMetaAdsActionLog,
  createMetaLaunchActivationActionClaim,
  findUnresolvedMetaAdStatusActionLog,
} from "@/lib/meta/ads-action-log";
import {
  getMetaLaunchIntent,
  recordMetaLaunchIntentActivation,
} from "@/lib/launchpad/meta-launch-intent-store";

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
  /**
   * The claim was written and the authority was withdrawn before the request.
   *
   * Distinct from `refused`, which means a provider was asked and said no. Here
   * nothing was asked: the pre-POST hook re-read the authority at the provider
   * boundary and stopped the write inside the primitive. The row settles as a
   * definite non-write, so the no-blind-retry gate does not read it as an
   * attempt whose outcome nobody knows.
   */
  | "authority_refused"
  /** A previous attempt on this entity is still unresolved. Nothing was sent. */
  | "unresolved_prior_attempt"
  /** This intent already activated the entity; a stale pre-read cannot replay it. */
  | "activation_already_consumed"
  /**
   * The unresolved-attempt lookup itself could not be read. Nothing was sent.
   *
   * Distinct from `unresolved_prior_attempt`, which is the gate ANSWERING: a
   * row exists and this names it. Here the question could not be asked at all,
   * so nothing is known about earlier attempts on the entity — and an
   * unreadable safety check is refused rather than read as "nothing
   * unresolved". Like `claim_unavailable`, it is a definite non-write with no
   * durable row to terminalise.
   */
  | "unresolved_lookup_unavailable"
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
  /** On, but not all of it. The honest word for a stopped multi-entity run. */
  partial: boolean;
  /** Every identity the plan named, counted. `on === planned` is `delivering`. */
  coverage: HierarchyActivationCoverage;
  blockedAt: ActivationGrain | null;
  blockedReason: string | null;
  steps: ActivationStepReceipt[];
}

/**
 * EVERY entity this intent created, outside in, with its parent named.
 *
 * This used to take `adsetIds[0]` and `adIds[0]`. The launch create runtime
 * loops over `payload.adSets` and then over `payload.creatives` inside each, so
 * a two-ad-set two-creative launch produces two ad sets and four ads — and
 * activation would turn on the first of each, report `delivering: true`, and
 * never mention the entities it had silently dropped. Those ad sets and ads are
 * as real as the ones it did activate: they exist in the account, paused, with
 * an operator being told their launch is live.
 *
 * A partially-succeeded launch has an error receipt rather than a result one,
 * and its partial identities are just as real — the campaign it created is
 * live in the account whether or not the ads followed. Both are read, so a
 * half-finished launch can still be completed rather than stranded.
 */
export function activationPlanForIntent(
  intent: MetaLaunchIntent,
): ActivationTarget[] {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
  if (!receipt) return [];
  const adsetIds = (receipt.adsetIds ?? []).filter((id) => Boolean(id));
  const adIds = (receipt.adIds ?? []).filter((id) => Boolean(id));
  const targets: ActivationTarget[] = [];
  /*
    Only a launch that created its own campaign may activate one.

    An add-to-existing receipt names the campaign it joined, because the ad has
    to live somewhere. Activating that campaign would turn on somebody else's
    structure on the strength of having added one ad to it — and for the same
    reason its ads name no parent here, so nothing above them is ever planned.
  */
  if (intent.operation === "new_campaign") {
    if (receipt.campaignId) {
      targets.push({ grain: "campaign", entityId: receipt.campaignId });
    }
    for (const adsetId of adsetIds) {
      targets.push({
        grain: "adset",
        entityId: adsetId,
        parentEntityId: receipt.campaignId ?? null,
      });
    }
    const parents = adsetParentsForAds(receipt.steps ?? [], adsetIds);
    for (const adId of adIds) {
      targets.push({
        grain: "ad",
        entityId: adId,
        parentEntityId: parents.get(adId) ?? null,
      });
    }
    return targets;
  }
  for (const adId of adIds) targets.push({ grain: "ad", entityId: adId });
  return targets;
}

/**
 * Which ad set each ad was created under, read off the receipt's own steps.
 *
 * The receipt records identities as two flat lists and never says which ad set
 * an ad belongs to. The `steps` array does, by construction: the create runtime
 * pushes an `adset` step and then, inside that ad set's loop, one `ad` step per
 * creative, so the ad set most recently recorded above an ad IS its parent.
 * Nothing is inferred beyond that — an ad whose parent cannot be read this way
 * is left unparented, which makes the sequence require every ad set to be on
 * before it. A guess would be worse than the conservative rule.
 */
function adsetParentsForAds(
  steps: ReadonlyArray<Record<string, unknown>>,
  adsetIds: readonly string[],
): Map<string, string> {
  const known = new Set(adsetIds);
  const parents = new Map<string, string>();
  // One ad set means there is nothing to attribute: every ad is under it.
  if (adsetIds.length === 1) return parents;
  let current: string | null = null;
  for (const step of steps) {
    const kind = typeof step.kind === "string" ? step.kind : null;
    const id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : null;
    if (!id) continue;
    if (kind === "adset") {
      current = known.has(id) ? id : null;
      continue;
    }
    if (kind === "ad" && current) parents.set(id, current);
  }
  return parents;
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
  /**
   * The intent as it stands RIGHT NOW, re-read before each unattended step.
   *
   * An unattended run's entire authority is a document in a column that the
   * operator's own route can rewrite while the run is in flight. Defaults to
   * the store, so a scheduled caller cannot end up with the stale copy by
   * forgetting to pass one; the operator path never calls it, because an
   * operator standing on the receipt is not acting under the approval at all.
   */
  reloadIntent?: () => Promise<MetaLaunchIntent | null>;
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
    const verdict = approvalVerdictFor(intent, input.now);
    if (!verdict.approved) return { ok: false, refusal: verdict.refusal };
    /*
      An `ad`-scoped approval activates the ads and nothing above them. The plan
      is narrowed rather than refused, because activating an ad in a live ad set
      is a perfectly good thing to have approved.
    */
    const planned = verdict.scope === "ad"
      ? targets.filter((target) => target.grain === "ad")
      : targets;
    if (planned.length === 0) {
      return { ok: false, refusal: "no_activatable_entities" };
    }
    return runActivation(input, planned, scheduledApprovalRecheck(input));
  }

  return runActivation(input, targets, null);
}

/**
 * The stored approval, validated against the intent as it stands.
 *
 * Split out of the entry check for one reason: the entry check happens once,
 * and this has to happen again before every single POST. The two must ask
 * exactly the same question or the second one would be a weaker gate wearing
 * the first one's name.
 */
function approvalVerdictFor(intent: MetaLaunchIntent, now: Date | undefined) {
  const receipt = intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
  const creativeIds = readCreativeIds(intent);
  return validateActivationApproval({
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
      /*
        Every ad set and every creative the launch produced, because the
        approval document names sets. It used to pass the first of each, which
        is how a launch could be approved for one creative and activated across
        three: the validator was only ever shown the one that happened to be
        listed first.
      */
      adsetIds: receipt?.adsetIds ?? [],
      adIds: receipt?.adIds ?? [],
      creativeIds,
    },
    policyVersion: ACTIVATION_POLICY_VERSION,
    now,
  });
}

/**
 * The approval, re-proved immediately before every unattended provider call.
 *
 * It used to be read once, from the intent object loaded at the top of the run.
 * The operator route can persist a revocation at any moment, and the scheduled
 * runtime's per-step hook re-read gates, mode and posture but never the
 * approval — so a withdrawn authorization stayed usable for the rest of an
 * in-flight sequence: revoke after the campaign came on and the ad set and the
 * ad were still POSTed under it.
 *
 * A refusal here halts the whole run, which is what `hierarchy-activation`
 * does with any refused authority: the permission was withdrawn from the run,
 * not from one entity. Steps already completed keep their receipts — the
 * campaign really is on, and nothing here rolls a verified write back.
 *
 * It is asked TWICE per step, and the second time is the one that matters.
 * `activateHierarchy` asks it before handing the write over; `activateOnce`
 * then hands the identical function to the write primitive's own pre-POST hook,
 * where nothing remains between the answer and the request. Without that second
 * call a revocation committed during `journal.claim` or during the primitive's
 * authority snapshot was ignored for exactly one POST.
 */
function scheduledApprovalRecheck(
  input: Parameters<typeof activateLaunchIntent>[0],
): (target: ActivationTarget) => Promise<string | null> {
  const { intent } = input;
  const reload = input.reloadIntent
    ?? (() => getMetaLaunchIntent({ businessId: intent.businessId, id: intent.id }));
  return async (target) => {
    const current = await reload().catch(() => null);
    // Unreadable is not "unchanged". A run whose authority cannot be read has
    // no authority to send the next write under.
    if (!current) return "activation_intent_unreadable";
    if (
      current.id !== intent.id
      || current.businessId !== intent.businessId
      || current.providerAccountId !== intent.providerAccountId
    ) {
      return "activation_intent_changed";
    }
    if (current.status !== "succeeded" && current.status !== "partially_succeeded") {
      return "intent_not_succeeded";
    }
    const verdict = approvalVerdictFor(current, input.now);
    if (!verdict.approved) return verdict.refusal;
    // A scope narrowed to `ad` after the campaign step no longer covers a
    // parent, so nothing above an ad may be sent under it.
    if (verdict.scope === "ad" && target.grain !== "ad") {
      return "activation_approval_scope_mismatch";
    }
    /*
      And the entity has to still be one the CURRENT receipt names.

      The plan was built from the receipt this run loaded. If the intent's
      identities have moved since, this step would be a status write against
      an entity the live record no longer says this launch created.
    */
    const stillPlanned = activationPlanForIntent(current).some(
      (planned) =>
        planned.grain === target.grain && planned.entityId === target.entityId,
    );
    if (!stillPlanned) return "activation_target_no_longer_approved";
    return null;
  };
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
  /** The unattended run's own re-proof of its approval, or null when present. */
  recheckApproval: ((target: ActivationTarget) => Promise<string | null>) | null,
): Promise<LaunchActivationResult> {
  const { intent } = input;
  const journal = input.journal ?? defaultActivationJournal;
  const claims = new Map<string, { actionLogId: string | null; outcome: ActivationClaimOutcome }>();

  const activation = await activateHierarchy({
    targets,
    deps: providerDeps({
      ctx: input.ctx,
      /*
        The approval is re-proved BEFORE the caller's own gates.

        The scheduled runtime fires its dispatch marker from inside `authorize`,
        and a marker on a row whose approval has just been withdrawn would stamp
        a dispatch for a call that will never be made. Asking the cheaper, more
        specific question first also means the blocked step records the reason
        an operator can act on — `activation_approval_revoked`, not a posture.
      */
      authorize: composeAuthorize(recheckApproval, input.authorize),
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
    /*
      Both words, stored.

      `delivering` alone cannot tell a reload the difference between a launch
      nothing turned on and one where three of five entities are live and
      spending. The counts are what let the surface say which, without
      recomputing them from steps it may not fully understand.
    */
    partial: activation.partial,
    coverage: activation.coverage,
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
  const contended = [...claims.values()].some((claim) =>
    claim.outcome === "unresolved_prior_attempt" || claim.outcome === "activation_already_consumed");
  const ownsClaim = [...claims.values()].some((claim) => claim.actionLogId !== null
    && ["activated", "ambiguous", "refused", "authority_refused"].includes(claim.outcome));
  // A contender that owned no step must not replace the winner's durable
  // summary with its blocked response. Runs with their own partial results
  // still persist them, and the contender always receives its honest response.
  if (!contended || ownsClaim) await persist(receipt).catch(() => undefined);

  return { ok: true, activation, receipt };
}

/**
 * Two gates in sequence, either of which may refuse.
 *
 * They are kept separate because they answer different questions: the first is
 * "does the stored approval still authorize this", the second is the caller's
 * own "may anything be written at all right now". Composing them here means the
 * hierarchy still sees one `authorize`, and neither can be skipped by a caller
 * that forgot to chain the other.
 *
 * The composed gate is also what goes into the write primitive's pre-POST hook,
 * so both questions are re-asked at the provider boundary rather than only one
 * of them. A caller that supplies neither gets no hook, and the primitives
 * behave exactly as they always did.
 */
function composeAuthorize(
  first: ((target: ActivationTarget) => Promise<string | null>) | null,
  second: ((target: ActivationTarget) => Promise<string | null>) | undefined,
): ((target: ActivationTarget) => Promise<string | null>) | undefined {
  if (!first) return second;
  if (!second) return first;
  return async (target) => (await first(target)) ?? (await second(target));
}

/**
 * EVERY creative the launch used, from its own request payload.
 *
 * The first two keys are the shapes this reader was written against and the
 * shipped payload carries NEITHER: a launch stores its creatives under
 * `creatives` (a list of refs, or of bare ids), and `creativeIds` on the
 * older shape. So this returned null for every real intent, and the scheduled
 * activation — whose approval names the creative it approved — refused every
 * one of them as `activation_approval_asset_mismatch`, a sentence about an
 * asset when the truth was that nobody had read it.
 *
 * It returns the whole list rather than the first entry because the approval
 * document names a SET, and containment is asked against every creative the
 * launch produced. Handing over only the first would put the other creatives
 * outside the question, which is the exact shape of the hole this closes.
 */
export function readCreativeIds(intent: MetaLaunchIntent): string[] {
  const payload = intent.requestPayload as Record<string, unknown>;
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const unique = (values: Array<string | null>) => {
    const found: string[] = [];
    for (const value of values) {
      if (value && !found.includes(value)) found.push(value);
    }
    return found;
  };
  /*
    The sources are tried in the order the single-creative reader tried them,
    and the FIRST one that answers is the whole answer. The shipped payload
    carries `creatives` and a `creativeIds` mirror of it, so unioning the
    sources would count the same creative twice under two keys and read a
    one-creative launch as a many-creative one.
  */
  const direct = read(payload?.creativeId);
  if (direct) return [direct];
  const reuse = payload?.reuseCreative as { creativeId?: unknown } | undefined;
  const reused = read(reuse?.creativeId);
  if (reused) return [reused];
  const refs = Array.isArray(payload?.creatives) ? payload.creatives : [];
  const fromRefs = unique(refs.map((item) => {
    if (typeof item === "string") return read(item);
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    return read(record.creativeId) ?? read(record.id);
  }));
  if (fromRefs.length > 0) return fromRefs;
  const ids = payload?.creativeIds;
  return Array.isArray(ids) ? unique(ids.map(read)) : [];
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
   *
   * `null` is an ANSWER — the table was read and holds no such row. A rejection
   * is not that answer, and the caller refuses on it rather than proceeding.
   */
  findUnresolved(input: {
    businessId: string;
    providerAccountId: string;
    entityId: string;
  }): Promise<{ id: string } | null>;
  /** Atomically recheck prior attempts and insert; null means claim unavailable. */
  claim(input: {
    businessId: string;
    providerAccountId: string;
    entityId: string;
    grain: ActivationGrain;
    launchIntentId: string;
    operatorUserId: string | null;
    /** What the entity was, read immediately before. The rollback record. */
    observed: { status: string | null; effectiveStatus: string | null };
  }): Promise<{ id: string; blocked?: "unresolved_prior_attempt" | "activation_already_consumed" } | null>;
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
    createMetaLaunchActivationActionClaim({
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
    }).then((result) => result.claimed
      ? { id: result.log.id }
      : { id: result.log.id, blocked: result.reason }),
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
          // Everything else — including a gate that refused inside the write
          // primitive — is a DEFINITE non-write, so it settles as `failure`.
          // The claim is terminalised either way: a row left `pending` for a
          // request that was never built would say a call may be in flight and
          // would block the next honest attempt on an untouched entity.
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

        And a lookup that THREW is not a lookup that found nothing.

        `findUnresolvedMetaAdStatusActionLog` is one query against
        `meta_ads_action_log` and catches nothing of its own, so a statement
        timeout or an exhausted pool arrives here as a rejection. Folding that
        into `null` — as this did — handed the failed safety check the same
        value the successful "nothing outstanding" read returns, and the POST
        went out: the gate below was never actually asked, and a `pending` or
        `silent_failure` row for this very entity would have been invisible to
        it. That is the blind retry this path exists to prevent.

        So the failure is kept as a THIRD answer, the shape this repository
        already uses for an unreadable control plane (`control_state_unavailable`
        in `getMetaWriteBlockState`): a named unavailability that blocks, not a
        clearance. Nothing was sent and no claim was written, so the step
        settles as a definite non-write with no durable row to terminalise, and
        the next attempt asks the real question once the table can be read.
      */
      const lookup: { readable: boolean; row: { id: string } | null } =
        await input.journal.findUnresolved({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          entityId: target.entityId,
        }).then((row) => ({ readable: true, row }))
          .catch(() => ({ readable: false, row: null }));
      if (!lookup.readable) {
        claimsInFlight.set(key, {
          actionLogId: null,
          outcome: "unresolved_lookup_unavailable",
          startedAt: 0,
          settled: true,
        });
        input.onClaim(key, {
          actionLogId: null,
          outcome: "unresolved_lookup_unavailable",
        });
        return { ok: false, reason: "activation_unresolved_lookup_unavailable" };
      }

      const unresolved = lookup.row;
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
      if (claim.blocked) {
        claimsInFlight.set(key, { actionLogId: claim.id, outcome: claim.blocked, startedAt: 0, settled: true });
        input.onClaim(key, { actionLogId: claim.id, outcome: claim.blocked });
        return { ok: false, ambiguous: claim.blocked === "unresolved_prior_attempt", reason: claim.blocked };
      }

      const startedAt = Date.now();
      /*
        THE LAST INSTANT.

        `authorize` answered before the two awaits above — a read of the action
        log and a durable write to it — and the write primitive underneath takes
        its own atomic authority snapshot before the request. The same gate is
        handed down into that primitive's pre-POST hook so it is asked once more
        with nothing left between the answer and the POST.
      */
      const written = await activateOnce(input.ctx, target, input.authorize);
      claimsInFlight.set(key, {
        actionLogId: claim.id,
        outcome: written.ok
          ? "activated"
          : written.authorityRefused
            ? "authority_refused"
            : written.ambiguous
              ? "ambiguous"
              : "refused",
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

/**
 * A refusal raised at the provider boundary, in the shape the primitives read.
 *
 * `metaFetchWriteOnce` turns a thrown object carrying a string `code` into the
 * write failure's own error code and returns a null `mutationAttempt` — so the
 * named reason survives all the way back here, and the record says plainly that
 * no request was ever constructed.
 */
class ActivationAuthorityRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Activation refused at the provider boundary: ${code}.`);
    this.name = "ActivationAuthorityRefusal";
    this.code = code;
  }
}

/**
 * The provider write, with the authority re-proved inside its own pre-POST hook.
 *
 * It used to call the three primitives with no options at all. That left the
 * only authority question being asked one read and one durable write before the
 * request — `journal.findUnresolved`, `journal.claim`, and then the primitive's
 * own atomic authority snapshot — and an operator revoking inside any of those
 * awaits had their withdrawal ignored for exactly one POST. One POST is a live
 * campaign beginning to spend under a permission that no longer exists.
 *
 * All three primitives already carried the hook (`MetaEntityStatusWriteOptions`
 * for the campaign and ad set, `MetaAdStatusWriteOptions` for the ad, which also
 * hands over the baseline it bound). It runs after every adapter-side read,
 * precondition and write-block check and immediately before the single POST, so
 * a refusal here means the request was never built.
 */
async function activateOnce(
  ctx: MetaAdsWriteContext,
  target: ActivationTarget,
  /** The same gate `activateHierarchy` asked, asked again with nothing left after it. */
  guard?: (target: ActivationTarget) => Promise<string | null>,
): Promise<{
  ok: boolean;
  ambiguous?: boolean;
  authorityRefused?: boolean;
  reason?: string | null;
}> {
  /*
    Held in a box rather than a bare local so the closure's write is visible
    afterwards — and so the reason is read from what actually refused, not
    guessed from the failure code the primitive happens to return.
  */
  const refusal: { code: string | null } = { code: null };
  const beforeMutationAttempt = guard
    ? async () => {
      const reason = await guard(target).catch((error: unknown) =>
        error instanceof Error ? error.message : "authorization_unreadable");
      if (!reason) return;
      refusal.code = reason;
      throw new ActivationAuthorityRefusal(reason);
    }
    : undefined;
  const written = target.grain === "campaign"
    ? await resumeCampaign(ctx, target.entityId, { beforeMutationAttempt })
    : target.grain === "adset"
      ? await resumeAdset(ctx, target.entityId, { beforeMutationAttempt })
      // The ad hook is handed the lineage the primitive bound for this write.
      // Nothing here needs it: the gate's question is about the intent and the
      // approval, both of which it re-reads itself.
      : await resumeAd(ctx, target.entityId, {
        beforeMutationAttempt: beforeMutationAttempt
          ? () => beforeMutationAttempt()
          : undefined,
      });
  if (written.ok) return { ok: true };
  /*
    Our own refusal, reported as the authority fact it is.

    It is read from the box rather than from `written.error.code` because only
    the box can prove the failure is THIS gate's: a provider error that happened
    to share a name would otherwise halt the run under a sentence about an
    approval nobody withdrew.
  */
  if (refusal.code !== null) {
    return {
      ok: false,
      ambiguous: false,
      authorityRefused: true,
      reason: refusal.code,
    };
  }
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
  /*
    A gate that refused inside the primitive means no request was constructed.

    The step's own verdict cannot know that — it sees a blocked step like any
    other — so this fact comes from the call and overrides it. Recording it as
    `refused` would say a provider was asked and declined, which is a different
    sentence about the same entity, and one that reads as evidence the entity
    was reachable.
  */
  if (provider === "authority_refused") return "authority_refused";
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
