/**
 * The provider-execution core of a Launchpad create, with no HTTP in it.
 *
 * The two Launchpad create routes each held ~250 lines that begin at
 * `markMetaLaunchIntentExecuting` and end at `recordMetaLaunchIntentOutcome`:
 * the action-log claim, the provider POST, the read-back and the intent
 * receipt. Only an operator's own request could reach any of it, which is why
 * neither the Automation queue nor a scheduled sweep could execute a launch a
 * person had already approved.
 *
 * That section lives here now, behind two parameters and nothing else:
 *
 * - `actionLogOrigin` and `requestedBy` say WHO is executing, and they are
 *   written to the action log alone. The stored `request_payload_json` is
 *   replayed byte for byte, because `metaLaunchIntentRequestFingerprint`
 *   hashes the whole payload — `executionAuthority` included — so a caller
 *   that recomposed the payload to describe itself would be refused as
 *   `launch_intent_contract_mismatch` by its own honesty.
 * - `beforeProviderMutation` is the pre-POST boundary. A caller holding a
 *   claim on something (an Automation queue row, say) can record write-ahead
 *   dispatch intent there and VETO the create if that record cannot be
 *   written, so "a call may be live" is always durable before it can be.
 *   It is not this module's job to decide WHICH questions that boundary asks,
 *   and both callers compose more than one into it. The shared route handler
 *   puts the current approval-standing read in front of whatever hook its own
 *   caller supplied (`mandatoryProviderMutationBoundary`), so a route that
 *   passes no options still gets that read. The scheduled runtime composes its
 *   own gate, mode and posture re-reads, then the same standing read, then its
 *   dispatch marker, in that order.
 *
 * The return value is deliberately HTTP-shaped — `{ status, body }` — because
 * every caller needs exactly that: the routes answer with it directly, and a
 * queue receipt records an httpStatus and a response envelope. It is a shape,
 * not a dependency; this module imports nothing from `next/server`.
 */
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  duplicateAd,
  type MetaAdDuplicateSourceIdentity,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
  type MetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-write";
import {
  createAd,
  createAdSet,
  createCampaign,
} from "@/lib/meta/launch-write";
import {
  adsManagerUrl,
  toAdInput,
  toAdSetInput,
  toCampaignInput,
  type MetaAddToExistingCopyMode,
  type MetaAddToExistingPayload,
  type MetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentResultReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import {
  markMetaLaunchIntentExecuting,
  recordMetaLaunchIntentOutcome,
  restoreMetaLaunchIntentBeforeProviderMutation,
} from "@/lib/launchpad/meta-launch-intent-store";
import type {
  MetaAddToExistingCreativeStatus,
  MetaAddToExistingTargetValidation,
} from "@/lib/launchpad/meta-validation";
import { isMetaWriteBlockedCode } from "@/lib/meta/write-blocked-codes";
import type { MetaLaunchpadManualAuthority } from "@/lib/launchpad/meta-manual-authority";

/** The origin every Launchpad create carried before any other caller existed. */
export const META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN = "launchpad_manual" as const;

export type LaunchStepKind = "campaign" | "adset" | "ad";

export interface LaunchStepResult {
  kind: LaunchStepKind;
  index: number;
  name: string;
  status: "pending" | "success" | "failure" | "silent_failure";
  id?: string;
  creativeId?: string;
  error?: {
    code: string;
    message: string;
  };
  providerOutcome?: "definite_failure" | "outcome_ambiguous";
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  retryAllowed?: false;
  adsManagerUrl?: string;
}

export type AddToExistingStep = {
  kind: "ad";
  index: number;
  name: string;
  status: "success" | "failure" | "silent_failure";
  id?: string;
  creativeId: string;
  sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
  providerOutcome?: "definite_failure" | "outcome_ambiguous";
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  retryAllowed?: false;
  adsManagerUrl?: string;
  error?: { code: string; message: string };
};

/**
 * What the pre-POST boundary answers.
 *
 * `true` lets the create through. The object form refuses it AND says which
 * gate closed, so the reason survives into the intent's durable error receipt
 * rather than arriving as a bare "the caller said no". A plain `false` is still
 * accepted — it is what the manual queue's dispatch marker returns — and reads
 * as a refusal with no reason to quote.
 */
export type MetaLaunchProviderMutationVerdict =
  | boolean
  | { allowed: false; reason: string };

/**
 * Who is executing, and the boundary at which they may stop it.
 *
 * Nothing in here reaches `request_payload_json`. The intent's payload is the
 * operator's, whoever replays it.
 */
export interface MetaLaunchExecutionOrigin {
  /** Written to `meta_ads_action_log.source`, never to the intent payload. */
  actionLogOrigin: string;
  /** The person behind the attempt, or null when nobody is. */
  requestedBy: string | null;
  /**
   * Fired immediately before EVERY provider mutation in the sequence, not once
   * before the sequence.
   *
   * It used to fire once. A launch is three or more provider POSTs separated by
   * read-backs and durable writes, and an operator can engage the STOP, drop
   * the standing mode out of `auto`, re-activate under a different admin or put
   * the business into rehearsal in the seconds between the campaign create and
   * the ad set create. Asking once meant the campaign's answer was reused for
   * every entity below it, so a launch could keep building itself under
   * authority that had already been withdrawn.
   *
   * A refusal refuses only what has not happened yet: whatever was already
   * created stays created, is reported, and is persisted on the intent with the
   * reason the rest was withheld. Callers must therefore be idempotent — the
   * queue's dispatch marker already is, and returns true once written.
   *
   * Optional in the TYPE, and supplied by every shipped caller. The two
   * functions below have exactly two callers between them:
   * `handleMetaLaunchAction` / `handleMetaAddToExistingAction`, which compose
   * one whether or not their own caller passed anything, and
   * `lib/meta/scheduled-launch-runtime.ts`, whose `ScheduledLaunchCreateRequest`
   * declares it required. It stays optional here because this module cannot
   * enforce what a boundary ASKS, and a required-but-empty hook would be a
   * worse lie than an absent one; the enforcement lives at those two entry
   * points, where the intent's lineage — the thing an approval is read from —
   * is actually in hand.
   */
  beforeProviderMutation?: () => Promise<MetaLaunchProviderMutationVerdict>;
}

/**
 * The code a withheld provider create is recorded under.
 *
 * Deliberately not a failure code: nothing failed and nothing was sent. It is
 * the one answer an operator reading a partially built launch needs — the
 * entities above exist, the entities below were never asked for, and the
 * message names the gate that closed.
 */
export const META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE =
  "provider_mutation_withheld" as const;

type ProviderMutationBoundaryVerdict =
  | { allowed: true }
  | { allowed: false; reason: string | null };

async function askProviderMutationBoundary(
  hook: (() => Promise<MetaLaunchProviderMutationVerdict>) | undefined,
): Promise<ProviderMutationBoundaryVerdict> {
  // Unreachable from either shipped caller — see `beforeProviderMutation` above
  // for why both always supply a hook, and why this module does not try to make
  // the absence impossible in the type. Kept as the honest answer for a hook
  // that genuinely is not there rather than removed, so a future caller fails
  // its own review instead of failing here.
  if (!hook) return { allowed: true };
  const verdict = await hook();
  if (verdict === true) return { allowed: true };
  if (verdict === false) return { allowed: false, reason: null };
  return { allowed: false, reason: verdict.reason };
}

/**
 * The same verdict, asked again from inside the primitive.
 *
 * The check above this one is the cheap refusal: it answers before the adapter
 * does any work and produces the richer receipt, with the partial identities
 * and the gate that closed. This one is the BINDING one. It runs after every
 * adapter-side check and immediately before the single request, which is the
 * only place a lapsed authority can still prevent the create rather than
 * describe it — the same two-read shape the scheduled status runtime uses.
 */
function providerMutationBoundaryHook(
  hook: (() => Promise<MetaLaunchProviderMutationVerdict>) | undefined,
  onAllowed?: () => void,
): (() => Promise<void>) | undefined {
  if (!hook && !onAllowed) return undefined;
  return async () => {
    const verdict = await askProviderMutationBoundary(hook);
    if (!verdict.allowed) {
      throw Object.assign(
        new Error(providerMutationWithheldError(verdict.reason).message),
        { code: META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE },
      );
    }
    onAllowed?.();
  };
}

function providerMutationWithheldError(reason: string | null) {
  return {
    code: META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE,
    message: reason
      ? `Authority for this launch was withdrawn before the next provider create (${reason}), so nothing further was created on Meta.`
      : "The caller withheld the next provider create, so nothing further was created on Meta.",
  };
}

export interface MetaLaunchExecutionOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  /**
   * Whether a provider create was entered at all.
   *
   * A refusal before the first POST is a proven non-attempt, and a caller
   * settling a claim needs to tell that from an outcome it merely could not
   * read.
   */
  providerMutationAttempted: boolean;
}

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function isProviderOutcomeAmbiguous(result: MetaAdsWriteFailure) {
  return (
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
  );
}

// Narrowed during the native integration: MetaAdsActionStatus gained "pending"
// for D065's in-flight rows, and a completed failure is never pending. The
// annotation now says what the function actually returns.
//
// D067 requires `silent_failure` for an ambiguous provider outcome as well as
// the explicit silent-failure code, so the ambiguity predicate below stays the
// single source of that classification and of D069 retry gating.
function getFailureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending"> {
  return isProviderOutcomeAmbiguous(result) ||
    result.error.code === "silent_failure"
    ? "silent_failure"
    : "failure";
}

function getDuplicateFailureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending" | "success"> {
  return result.error.code === "silent_failure" ||
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
    ? "silent_failure"
    : "failure";
}

function shouldHaltProviderMutationChain(result: MetaAdsWriteFailure) {
  return (
    // Authority for the next POST was withdrawn, so it is withdrawn for the one
    // after it too. Walking the rest of the matrix would re-ask a closed gate
    // once per remaining target and creative, and answer the same each time.
    result.error.code === META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE ||
    isMetaWriteBlockedCode(result.error.code) ||
    result.error.code === "silent_failure" ||
    result.mutationAttempt != null ||
    isProviderOutcomeAmbiguous(result)
  );
}

function providerEvidenceWithSourceIdentity(
  payload: Record<string, unknown> | null | undefined,
  sourceIdentity: MetaAdDuplicateSourceIdentity | null | undefined,
) {
  return {
    provider_payload: ensureRecord(payload),
    source_identity: sourceIdentity ?? null,
  };
}

function stepsAsRecords(
  steps: Array<LaunchStepResult | AddToExistingStep>,
): Array<Record<string, unknown>> {
  return steps.map((step) => ({ ...step }));
}

function targetKey(target: {
  campaignId?: string | null;
  targetCampaignId?: string | null;
  adsetId?: string | null;
  targetAdsetId?: string | null;
}) {
  const campaignId = target.campaignId ?? target.targetCampaignId ?? "";
  const adsetId = target.adsetId ?? target.targetAdsetId ?? "";
  return `${campaignId}:${adsetId}`;
}

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
}) {
  return completeMetaAdsActionLog({
    id: input.logId,
    status: getFailureLogStatus(input.result),
    payloadResponse: ensureRecord(input.result.responsePayload),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verifiedAt: input.result.verificationPayload
      ? new Date().toISOString()
      : null,
    verificationPayload: ensureRecord(input.result.verificationPayload),
  });
}

async function completeDuplicateFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
}) {
  return completeMetaAdsActionLog({
    id: input.logId,
    status: getDuplicateFailureLogStatus(input.result),
    payloadResponse: providerEvidenceWithSourceIdentity(
      input.result.responsePayload,
      input.result.sourceIdentity,
    ),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verifiedAt: input.result.verificationPayload
      ? new Date().toISOString()
      : null,
    verificationPayload: providerEvidenceWithSourceIdentity(
      input.result.verificationPayload,
      input.result.sourceIdentity,
    ),
  });
}

function failureStep(input: {
  kind: LaunchStepKind;
  index: number;
  name: string;
  result: MetaAdsWriteFailure;
}): LaunchStepResult {
  return {
    kind: input.kind,
    index: input.index,
    name: input.name,
    status:
      getFailureLogStatus(input.result),
    id: input.result.resultingAdId ?? undefined,
    error: input.result.error,
    ...(input.result.providerOutcome
      ? { providerOutcome: input.result.providerOutcome }
      : {}),
    ...(input.result.mutationAttempt
      ? { mutationAttempt: input.result.mutationAttempt }
      : {}),
    ...(isProviderOutcomeAmbiguous(input.result)
      ? { retryAllowed: false as const }
      : {}),
  };
}

async function persistExecutionFailure(input: {
  businessId: string;
  launchIntentId: string;
  providerAccountId: string;
  result: MetaAdsWriteFailure;
  failedAt: string;
  campaignId?: string | null;
  adsetIds: string[];
  adIds: string[];
  steps: LaunchStepResult[];
  executionAuthority: MetaLaunchpadManualAuthority;
  requestFingerprint: string;
  checks: Array<Record<string, unknown>>;
}) {
  const partial = Boolean(
    input.campaignId || input.adsetIds.length || input.adIds.length,
  );
  const status =
    getFailureLogStatus(input.result) === "silent_failure"
      ? "silent_failure"
      : partial
        ? "partially_succeeded"
        : "failed";
  return recordMetaLaunchIntentOutcome({
    businessId: input.businessId,
    id: input.launchIntentId,
    status,
    resultReceipt: partial
      ? buildMetaLaunchIntentResultReceipt({
          executionAuthority: input.executionAuthority,
          requestFingerprint: input.requestFingerprint,
          providerAccountId: input.providerAccountId,
          campaignId: input.campaignId,
          adsetIds: input.adsetIds,
          adIds: input.adIds,
          steps: stepsAsRecords(input.steps),
          checks: input.checks,
        })
      : null,
    errorReceipt: buildMetaLaunchIntentErrorReceipt({
      executionAuthority: input.executionAuthority,
      requestFingerprint: input.requestFingerprint,
      providerAccountId: input.providerAccountId,
      code: input.result.error.code,
      message: input.result.error.message,
      failedAt: input.failedAt,
      campaignId: input.campaignId,
      adsetIds: input.adsetIds,
      adIds: input.adIds,
      steps: stepsAsRecords(input.steps),
      checks: input.checks,
    }),
  });
}

/**
 * The refusal the FIRST pre-POST boundary answer produces.
 *
 * `409`, not `500`: nothing failed. The boundary said the write must not be
 * entered, and it was not — the intent is left exactly where it was, still
 * executable once whatever closed reopens.
 *
 * The MESSAGE follows the answer rather than assuming one shape of caller. An
 * UNNAMED refusal is a bare `false` from the caller's hook, which today is the
 * queue's dispatch marker failing to write — "the caller could not record
 * dispatch intent" is exactly what that is. A NAMED one is not: it is whatever
 * `withheldReason` says, and on the direct routes it is now reachable for an
 * operator who holds no claim and stamps no marker at all, because the handler
 * composes the approval-standing read into this boundary for every caller. The
 * dispatch sentence would have been a plain falsehood on the one path a person
 * actually reads, so a named refusal says that the boundary refused and quotes
 * the reason instead of inventing a cause for it.
 *
 * The `code` is deliberately unchanged. `scheduled-launch-runtime.ts` branches
 * on it (`boundaryVetoed`) and replaces this envelope with its own receipt, and
 * `withheldReason` is where the gate has always been named.
 */
function dispatchMarkerUnavailable(
  launchIntentId: string,
  reason: string | null,
): MetaLaunchExecutionOutcome {
  return {
    ok: false,
    status: 409,
    body: {
      ok: false,
      error: {
        code: "dispatch_marker_unavailable",
        message: reason
          ? `The pre-create boundary refused this launch (${reason}), so nothing was created on Meta.`
          : "The caller could not record dispatch intent for this launch, so nothing was created on Meta.",
      },
      // Which gate closed, when the boundary named one. It is asked the same
      // question before every create, and only the first of them can still
      // answer before the intent is marked executing.
      withheldReason: reason,
      launchIntentId,
      launchIntentStatus: null,
    },
    providerMutationAttempted: false,
  };
}

function isZeroWriteAuthorityRefusal(result: MetaAdsWriteFailure): boolean {
  return result.error.code === META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE
    && result.providerMutationAttempted !== true
    && result.mutationAttempt == null
    && !isProviderOutcomeAmbiguous(result)
    && !result.resultingAdId
    && result.responsePayload == null
    && result.verificationPayload == null;
}

/** Release only after a durable no-dispatch log and an exact owned-claim CAS. */
async function restoreUnattemptedLaunch(input: {
  businessId: string;
  launchIntentId: string;
  requestFingerprint: string;
  claimStartedAt: string | null;
  logId: string;
  startedAt: number;
  error: { code: string; message: string };
  reason?: string | null;
}): Promise<MetaLaunchExecutionOutcome> {
  try {
    await completeMetaAdsActionLog({
      id: input.logId,
      status: "failure",
      payloadResponse: { provider_mutation_attempted: false },
      errorCode: input.error.code,
      errorMessage: input.error.message,
      resultingAdId: null,
      durationMs: Date.now() - input.startedAt,
      verifiedAt: null,
      verificationPayload: null,
    });
    const restored = await restoreMetaLaunchIntentBeforeProviderMutation({
      businessId: input.businessId,
      id: input.launchIntentId,
      requestFingerprint: input.requestFingerprint,
      startedAt: input.claimStartedAt!,
      refusedActionLogId: input.logId,
    });
    return {
      ok: false,
      status: 409,
      providerMutationAttempted: false,
      body: {
        ok: false,
        error: input.error,
        withheldReason: input.reason ?? null,
        launchIntentId: input.launchIntentId,
        launchIntentStatus: restored.status,
      },
    };
  } catch {
    // Never settle or release a claim after an unknown log write or a lost
    // ownership comparison. Another executor's state must remain untouched.
    return {
      ok: false,
      status: 500,
      providerMutationAttempted: false,
      body: {
        ok: false,
        error: {
          code: "launch_intent_precreate_restore_failed",
          message: "No provider write was made, but the execution claim could not be safely restored.",
        },
        launchIntentId: input.launchIntentId,
        launchIntentStatus: "receipt_write_failed",
        retryAllowed: false,
      },
    };
  }
}

export interface MetaLaunchIntentCreateInput extends MetaLaunchExecutionOrigin {
  businessId: string;
  launchIntentId: string;
  providerAccountId: string;
  idempotencyKey: string;
  ctx: MetaAdsWriteContext;
  /** The VALIDATED payload, never the raw body. */
  payload: MetaLaunchPayload;
  executionAuthority: MetaLaunchpadManualAuthority;
  requestFingerprint: string;
  actionLogAuthority: Record<string, unknown>;
  actionLogPreflightProof: Record<string, unknown>;
  preflightChecks: Array<Record<string, unknown>>;
  /** Disclosed on a success envelope; see the route that composes it. */
  preflightDisclosure: Record<string, unknown>;
  sanitizeError: (error: unknown) => string;
}

export async function runMetaLaunchIntentCreate(
  input: MetaLaunchIntentCreateInput,
): Promise<MetaLaunchExecutionOutcome> {
  const {
    businessId,
    launchIntentId,
    providerAccountId,
    idempotencyKey,
    ctx,
    payload,
    actionLogAuthority,
    actionLogPreflightProof,
    preflightChecks,
  } = input;
  const receiptBinding = {
    executionAuthority: input.executionAuthority,
    requestFingerprint: input.requestFingerprint,
  } as const;
  const steps: LaunchStepResult[] = [];
  const adsetIds: string[] = [];
  const adIds: string[] = [];
  let campaignId: string | undefined;
  let providerExecutionCompleted = false;
  let providerMutationAttempted = false;

  const mayStart = await askProviderMutationBoundary(input.beforeProviderMutation);
  if (!mayStart.allowed) {
    return dispatchMarkerUnavailable(launchIntentId, mayStart.reason);
  }

  const executionClaim = await markMetaLaunchIntentExecuting({
    businessId,
    id: launchIntentId,
  });

  /*
    A create that the boundary refused part of the way down.

    The entities above it exist and stay reported; the log row for the entity
    that was never asked for is completed rather than left pending, so a later
    attempt's in-flight guard does not read a POST that never happened; and the
    intent settles `partially_succeeded` carrying both the identities and the
    reason. Everything below this step is simply not attempted.
  */
  const withholdRemaining = async (withhold: {
    kind: LaunchStepKind;
    index: number;
    name: string;
    logId: string;
    startedAt: number;
    failedAt: string;
    reason: string | null;
    creativeId?: string;
  }): Promise<MetaLaunchExecutionOutcome> => {
    const error = providerMutationWithheldError(withhold.reason);
    if (!providerMutationAttempted && !campaignId && adsetIds.length === 0 && adIds.length === 0) {
      return restoreUnattemptedLaunch({
        businessId, launchIntentId, requestFingerprint: input.requestFingerprint,
        claimStartedAt: executionClaim.startedAt,
        logId: withhold.logId, startedAt: withhold.startedAt, error, reason: withhold.reason,
      });
    }
    const result: MetaAdsWriteFailure = {
      ok: false,
      httpStatus: 409,
      providerMutationAttempted: false,
      providerOutcome: "definite_failure",
      error,
    };
    await completeMetaAdsActionLog({
      id: withhold.logId,
      status: "failure",
      payloadResponse: null,
      errorCode: error.code,
      errorMessage: error.message,
      resultingAdId: null,
      durationMs: Date.now() - withhold.startedAt,
      verifiedAt: null,
      verificationPayload: null,
    }).catch(() => null);
    const step = failureStep({
      kind: withhold.kind,
      index: withhold.index,
      name: withhold.name,
      result,
    });
    if (withhold.creativeId) step.creativeId = withhold.creativeId;
    steps.push(step);
    const failedIntent = await persistExecutionFailure({
      businessId,
      launchIntentId,
      providerAccountId,
      result,
      executionAuthority: input.executionAuthority,
      requestFingerprint: input.requestFingerprint,
      checks: preflightChecks,
      failedAt: withhold.failedAt,
      campaignId: campaignId ?? null,
      adsetIds,
      adIds,
      steps,
    }).catch(() => null);
    return {
      ok: false,
      status: 409,
      providerMutationAttempted,
      body: {
        ok: false,
        campaignId: campaignId ?? null,
        adsetIds,
        adIds,
        steps,
        failedAt: withhold.failedAt,
        error,
        withheldReason: withhold.reason,
        providerOutcome: null,
        mutationAttempt: null,
        retryAllowed: null,
        launchIntentId,
        launchIntentStatus: failedIntent?.status ?? "receipt_write_failed",
      },
    };
  };

  try {
    const campaignInput = toCampaignInput(payload);
    const campaignLog = await createMetaAdsActionLog({
      businessId,
      adId: `launch:${idempotencyKey}:campaign`,
      action: "launch_campaign",
      source: input.actionLogOrigin,
      requestedBy: input.requestedBy,
      launchIntentId,
      payloadRequest: {
        ...actionLogAuthority,
        ...actionLogPreflightProof,
        launch_intent_id: launchIntentId,
        idempotency_key: idempotencyKey,
        method: "POST",
        endpoint: `/act_${ctx.providerAccountId.replace(/^act_/, "")}/campaigns`,
        body: {
          ...campaignInput,
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        },
      },
    });
    const campaignStartedAt = Date.now();
    /*
      Asked again, with the log row written and nothing else left to do.

      The answer above was given before `markMetaLaunchIntentExecuting` and the
      action-log insert, which is where it has to be — a refusal there leaves the
      intent `prepared` and executable. This one is the last word before the
      first POST.
    */
    const mayCreateCampaign = await askProviderMutationBoundary(
      input.beforeProviderMutation,
    );
    if (!mayCreateCampaign.allowed) {
      return withholdRemaining({
        kind: "campaign",
        index: 0,
        name: campaignInput.name,
        logId: campaignLog.id,
        startedAt: campaignStartedAt,
        failedAt: "campaign",
        reason: mayCreateCampaign.reason,
      });
    }
    const campaignResult = await createCampaign(ctx, campaignInput, {
      beforeMutationAttempt: providerMutationBoundaryHook(input.beforeProviderMutation, () => {
        providerMutationAttempted = true;
      }),
    });
    providerMutationAttempted ||= campaignResult.ok
      || campaignResult.providerMutationAttempted === true
      || campaignResult.mutationAttempt != null
      || isProviderOutcomeAmbiguous(campaignResult);
    if (!campaignResult.ok) {
      if (!providerMutationAttempted && isZeroWriteAuthorityRefusal(campaignResult)) {
        return restoreUnattemptedLaunch({
          businessId, launchIntentId, requestFingerprint: input.requestFingerprint,
          claimStartedAt: executionClaim.startedAt,
          logId: campaignLog.id, startedAt: campaignStartedAt, error: campaignResult.error,
        });
      }
      await completeFailure({
        logId: campaignLog.id,
        startedAt: campaignStartedAt,
        result: campaignResult,
      });
      const step = failureStep({
        kind: "campaign",
        index: 0,
        name: campaignInput.name,
        result: campaignResult,
      });
      steps.push(step);
      const failedIntent = await persistExecutionFailure({
        businessId,
        launchIntentId,
        providerAccountId,
        result: campaignResult,
        executionAuthority: input.executionAuthority,
        requestFingerprint: input.requestFingerprint,
        checks: preflightChecks,
        failedAt: "campaign",
        campaignId: null,
        adsetIds,
        adIds,
        steps,
      });
      return {
        ok: false,
        status: 502,
        providerMutationAttempted,
        body: {
          ok: false,
          campaignId: null,
          adsetIds,
          adIds,
          steps,
          failedAt: "campaign",
          error: step.error,
          providerOutcome: campaignResult.providerOutcome ?? null,
          mutationAttempt: campaignResult.mutationAttempt ?? null,
          retryAllowed: isProviderOutcomeAmbiguous(campaignResult)
            ? false
            : null,
          launchIntentId,
          launchIntentStatus: failedIntent.status,
        },
      };
    }
    campaignId = campaignResult.campaignId;
    await completeMetaAdsActionLog({
      id: campaignLog.id,
      status: "success",
      payloadResponse: ensureRecord(campaignResult.responsePayload),
      resultingAdId: campaignResult.campaignId,
      durationMs: Date.now() - campaignStartedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(campaignResult.verificationPayload),
    });
    steps.push({
      kind: "campaign",
      index: 0,
      name: campaignInput.name,
      status: "success",
      id: campaignId,
      adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "campaign", campaignId),
    });

    for (let adsetIndex = 0; adsetIndex < payload.adSets.length; adsetIndex += 1) {
      const adSetPayload = payload.adSets[adsetIndex];
      if (!adSetPayload) continue;
      const adSetInput = toAdSetInput(campaignId, adSetPayload, payload.budget);
      const adSetLog = await createMetaAdsActionLog({
        businessId,
        adId: `launch:${idempotencyKey}:adset:${adsetIndex + 1}`,
        action: "launch_adset",
        source: input.actionLogOrigin,
        requestedBy: input.requestedBy,
        launchIntentId,
        payloadRequest: {
          ...actionLogAuthority,
          ...actionLogPreflightProof,
          launch_intent_id: launchIntentId,
          idempotency_key: idempotencyKey,
          method: "POST",
          endpoint: `/${campaignId}/adsets`,
          body: {
            ...adSetInput,
            status: "PAUSED",
          },
        },
      });
      const adSetStartedAt = Date.now();
      const mayCreateAdSet = await askProviderMutationBoundary(
        input.beforeProviderMutation,
      );
      if (!mayCreateAdSet.allowed) {
        return withholdRemaining({
          kind: "adset",
          index: adsetIndex,
          name: adSetInput.name,
          logId: adSetLog.id,
          startedAt: adSetStartedAt,
          failedAt: `adset:${adsetIndex + 1}`,
          reason: mayCreateAdSet.reason,
        });
      }
      const adSetResult = await createAdSet(ctx, adSetInput, {
        beforeMutationAttempt: providerMutationBoundaryHook(input.beforeProviderMutation),
      });
      if (!adSetResult.ok) {
        await completeFailure({
          logId: adSetLog.id,
          startedAt: adSetStartedAt,
          result: adSetResult,
        });
        const step = failureStep({
          kind: "adset",
          index: adsetIndex,
          name: adSetInput.name,
          result: adSetResult,
        });
        steps.push(step);
        const failedIntent = await persistExecutionFailure({
          businessId,
          launchIntentId,
          providerAccountId,
          result: adSetResult,
          executionAuthority: input.executionAuthority,
          requestFingerprint: input.requestFingerprint,
          checks: preflightChecks,
          failedAt: `adset:${adsetIndex + 1}`,
          campaignId,
          adsetIds,
          adIds,
          steps,
        });
        return {
          ok: false,
          status: 502,
          providerMutationAttempted,
          body: {
            ok: false,
            campaignId,
            adsetIds,
            adIds,
            steps,
            failedAt: `adset:${adsetIndex + 1}`,
            error: step.error,
            providerOutcome: adSetResult.providerOutcome ?? null,
            mutationAttempt: adSetResult.mutationAttempt ?? null,
            retryAllowed: isProviderOutcomeAmbiguous(adSetResult)
              ? false
              : null,
            launchIntentId,
            launchIntentStatus: failedIntent.status,
          },
        };
      }
      adsetIds.push(adSetResult.adsetId);
      await completeMetaAdsActionLog({
        id: adSetLog.id,
        status: "success",
        payloadResponse: ensureRecord(adSetResult.responsePayload),
        resultingAdId: adSetResult.adsetId,
        durationMs: Date.now() - adSetStartedAt,
        verifiedAt: new Date().toISOString(),
        verificationPayload: ensureRecord(adSetResult.verificationPayload),
      });
      steps.push({
        kind: "adset",
        index: adsetIndex,
        name: adSetInput.name,
        status: "success",
        id: adSetResult.adsetId,
        adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "adset", adSetResult.adsetId),
      });

      for (let creativeIndex = 0; creativeIndex < payload.creatives.length; creativeIndex += 1) {
        const creative = payload.creatives[creativeIndex];
        if (!creative) continue;
        const adInput = toAdInput(adSetResult.adsetId, creative);
        const adLog = await createMetaAdsActionLog({
          businessId,
          adId: `launch:${idempotencyKey}:ad:${adsetIndex + 1}:${creativeIndex + 1}`,
          creativeId: creative.creativeId,
          action: "launch_ad",
          source: input.actionLogOrigin,
          requestedBy: input.requestedBy,
          launchIntentId,
          payloadRequest: {
            ...actionLogAuthority,
            ...actionLogPreflightProof,
            launch_intent_id: launchIntentId,
            idempotency_key: idempotencyKey,
            method: "POST",
            endpoint: `/${adSetResult.adsetId}/ads`,
            body: {
              ...adInput,
              status: "PAUSED",
            },
          },
        });
        const adStartedAt = Date.now();
        const mayCreateAd = await askProviderMutationBoundary(
          input.beforeProviderMutation,
        );
        if (!mayCreateAd.allowed) {
          return withholdRemaining({
            kind: "ad",
            index: adIds.length,
            name: adInput.name,
            logId: adLog.id,
            startedAt: adStartedAt,
            failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
            reason: mayCreateAd.reason,
            creativeId: creative.creativeId,
          });
        }
        const adResult = await createAd(ctx, adInput, {
          beforeMutationAttempt: providerMutationBoundaryHook(input.beforeProviderMutation),
        });
        if (!adResult.ok) {
          await completeFailure({
            logId: adLog.id,
            startedAt: adStartedAt,
            result: adResult,
          });
          const step = failureStep({
            kind: "ad",
            index: adIds.length,
            name: adInput.name,
            result: adResult,
          });
          step.creativeId = creative.creativeId;
          steps.push(step);
          const failedIntent = await persistExecutionFailure({
            businessId,
            launchIntentId,
            providerAccountId,
            result: adResult,
            executionAuthority: input.executionAuthority,
            requestFingerprint: input.requestFingerprint,
            checks: preflightChecks,
            failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
            campaignId,
            adsetIds,
            adIds,
            steps,
          });
          return {
            ok: false,
            status: 502,
            providerMutationAttempted,
            body: {
              ok: false,
              campaignId,
              adsetIds,
              adIds,
              steps,
              failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
              error: step.error,
              providerOutcome: adResult.providerOutcome ?? null,
              mutationAttempt: adResult.mutationAttempt ?? null,
              retryAllowed: isProviderOutcomeAmbiguous(adResult)
                ? false
                : null,
              launchIntentId,
              launchIntentStatus: failedIntent.status,
            },
          };
        }
        adIds.push(adResult.adId);
        await completeMetaAdsActionLog({
          id: adLog.id,
          status: "success",
          payloadResponse: ensureRecord(adResult.responsePayload),
          resultingAdId: adResult.adId,
          durationMs: Date.now() - adStartedAt,
          verifiedAt: new Date().toISOString(),
          verificationPayload: ensureRecord(adResult.verificationPayload),
        });
        steps.push({
          kind: "ad",
          index: adIds.length - 1,
          name: adInput.name,
          status: "success",
          id: adResult.adId,
          creativeId: creative.creativeId,
          adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.adId),
        });
      }
    }

    providerExecutionCompleted = true;
    const completedIntent = await recordMetaLaunchIntentOutcome({
      businessId,
      id: launchIntentId,
      status: "succeeded",
      resultReceipt: buildMetaLaunchIntentResultReceipt({
        ...receiptBinding,
        providerAccountId,
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
        checks: preflightChecks,
      }),
    });
    return {
      ok: true,
      status: 200,
      providerMutationAttempted,
      body: {
        ok: true,
        campaignId,
        adsetIds,
        adIds,
        steps,
        launchIntentId,
        launchIntentStatus: completedIntent.status,
        // The fresh creative-identity proof this create rested on, and how old it
        // was when the first POST went out (§10 step 10).
        preflight: input.preflightDisclosure,
      },
    };
  } catch (error) {
    const rawMessage = input.sanitizeError(error);
    const errorCode = providerExecutionCompleted
      ? "launch_receipt_persist_failed"
      : "launch_failed";
    const message = providerExecutionCompleted
      ? `Meta launch completed, but its LaunchIntent receipt could not be persisted: ${rawMessage}`
      : rawMessage;
    const partial = Boolean(campaignId || adsetIds.length || adIds.length);
    const intent = await recordMetaLaunchIntentOutcome({
      businessId,
      id: launchIntentId,
      status: providerExecutionCompleted
        ? "succeeded"
        : partial
          ? "partially_succeeded"
          : "failed",
      resultReceipt: providerExecutionCompleted || partial
        ? buildMetaLaunchIntentResultReceipt({
            ...receiptBinding,
            providerAccountId,
            campaignId,
            adsetIds,
            adIds,
            steps: stepsAsRecords(steps),
            checks: preflightChecks,
          })
        : null,
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: errorCode,
        message,
        failedAt: "orchestration",
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
        checks: preflightChecks,
      }),
    }).catch(() => null);
    return {
      ok: false,
      status: 500,
      providerMutationAttempted,
      body: {
        ok: false,
        error: { code: errorCode, message },
        campaignId: campaignId ?? null,
        adsetIds,
        adIds,
        steps,
        launchIntentId,
        launchIntentStatus: intent?.status ?? "receipt_write_failed",
      },
    };
  }
}

export interface MetaAddToExistingCreateInput extends MetaLaunchExecutionOrigin {
  businessId: string;
  launchIntentId: string;
  providerAccountId: string;
  idempotencyKey: string;
  ctx: MetaAdsWriteContext;
  /** The VALIDATED payload, never the raw body. */
  payload: MetaAddToExistingPayload;
  validationTargets: MetaAddToExistingTargetValidation[];
  validationCreatives: MetaAddToExistingCreativeStatus[];
  /** The operator's per-creative name overrides, as the body carried them. */
  nameOverrides: Record<string, string>;
  copyMode: MetaAddToExistingCopyMode;
  livePreflightChecks: Array<Record<string, unknown>>;
  /** Echoed on every envelope so the caller reads its own first target back. */
  targetCampaignId: string;
  targetAdsetId: string;
  executionAuthority: MetaLaunchpadManualAuthority;
  requestFingerprint: string;
  actionLogAuthority: Record<string, unknown>;
  sanitizeError: (error: unknown) => string;
}

export async function runMetaAddToExistingCreate(
  input: MetaAddToExistingCreateInput,
): Promise<MetaLaunchExecutionOutcome> {
  const {
    businessId,
    launchIntentId,
    providerAccountId,
    idempotencyKey,
    ctx,
    copyMode,
    actionLogAuthority,
  } = input;
  const validation = {
    payload: input.payload,
    targets: input.validationTargets,
    creatives: input.validationCreatives,
  };
  const livePreflight = { checks: input.livePreflightChecks };
  const receiptBinding = {
    executionAuthority: input.executionAuthority,
    requestFingerprint: input.requestFingerprint,
  } as const;
  const targetMeta = new Map(
    validation.targets.map((target) => [targetKey(target), target]),
  );
  const creativeMeta = new Map(
    validation.creatives.map((creative) => [creative.creativeId, creative]),
  );
  const submittedCreativeMeta = new Map(
    validation.payload.creatives.map((creative) => [creative.creativeId, creative]),
  );
  const results: Array<{
    creativeId: string;
    targetCampaignId: string;
    targetAdsetId: string;
    ok: boolean;
    adId?: string;
    sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
    providerOutcome?: "definite_failure" | "outcome_ambiguous";
    mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
    retryAllowed?: false;
    error?: { code: string; message: string };
  }> = [];
  const steps: AddToExistingStep[] = [];
  const adIds: string[] = [];
  let haltedReason: { code: string; message: string } | null = null;
  let providerMutationAttempted = false;
  let providerOutcomeStatus:
    | "succeeded"
    | "partially_succeeded"
    | "failed"
    | "silent_failure"
    | null = null;

  const mayStart = await askProviderMutationBoundary(input.beforeProviderMutation);
  if (!mayStart.allowed) {
    return dispatchMarkerUnavailable(launchIntentId, mayStart.reason);
  }

  const executionClaim = await markMetaLaunchIntentExecuting({
    businessId,
    id: launchIntentId,
  });

  try {
    targetLoop: for (let targetIndex = 0; targetIndex < validation.payload.targets.length; targetIndex += 1) {
      const target = validation.payload.targets[targetIndex];
      if (!target) continue;
      const resolvedTarget = targetMeta.get(targetKey(target));
      const accountNumericId = ctx.providerAccountId.replace(/^act_/, "");
      const targetAdsetName =
        target.targetAdsetName || resolvedTarget?.adsetName || target.targetAdsetId;

      for (let creativeIndex = 0; creativeIndex < validation.payload.creativeIds.length; creativeIndex += 1) {
        const creativeId = validation.payload.creativeIds[creativeIndex];
        if (!creativeId) continue;
        const stepIndex = steps.length;
        const override = input.nameOverrides[creativeId]?.trim();
        const creative = creativeMeta.get(creativeId);
        const submittedCreative = submittedCreativeMeta.get(creativeId);
        const creativeName =
          creative?.creativeName ??
          submittedCreative?.name?.trim() ??
          null;
        const adName = override || creativeName || `Creative ${creativeId}`;
        const sourceAdId =
          submittedCreative?.sourceAdId?.trim() ||
          creative?.sourceAdId?.trim() ||
          "";
        if (!sourceAdId) {
          const error = {
            code: "source_ad_required",
            message: `Creative ${creativeId} is missing a source Meta ad id.`,
          };
          results.push({
            creativeId,
            targetCampaignId: target.targetCampaignId,
            targetAdsetId: target.targetAdsetId,
            ok: false,
            error,
          });
          steps.push({
            kind: "ad",
            index: stepIndex,
            name: `${adName} -> ${targetAdsetName}`,
            status: "failure",
            creativeId,
            error,
          });
          continue;
        }
        const adLog = await createMetaAdsActionLog({
          businessId,
          adId: sourceAdId,
          creativeId,
          action: "launch_ad",
          source: input.actionLogOrigin,
          requestedBy: input.requestedBy,
          launchIntentId,
          payloadRequest: {
            ...actionLogAuthority,
            launch_intent_id: launchIntentId,
            idempotency_key: idempotencyKey,
            provider_preflight: livePreflight.checks,
            target_campaign_id: target.targetCampaignId,
            target_adset_id: target.targetAdsetId,
            target_campaign_name: target.targetCampaignName ?? resolvedTarget?.campaignName ?? null,
            target_adset_name: targetAdsetName,
            source_name: creativeName,
            method: "POST",
            endpoint: `/act_${accountNumericId}/ads`,
            body: {
              adset_id: target.targetAdsetId,
              target_adset_id: target.targetAdsetId,
              source_ad_id: sourceAdId,
              source_creative_id: creativeId,
              source_name: creativeName,
              copy_mode: copyMode,
              status_option: "PAUSED",
              name: adName,
            },
          },
        });
        const startedAt = Date.now();
        /*
          The boundary, inside the primitive rather than around it.

          `duplicateAd` runs its own account, kill-switch and source-identity
          checks first and fires this hook as the last thing before the POST,
          so a gate that closes while the previous ad was being read back still
          prevents this one. Throwing is how the primitive is refused; the
          thrown `code` becomes the write failure's code, which halts the rest
          of the target/creative matrix below.
        */
        const adResult = await duplicateAd(ctx, {
          adId: sourceAdId,
          targetAdsetId: target.targetAdsetId,
          expectedSourceCreativeId: creativeId,
          name: adName,
          copyMode,
          beforeMutationAttempt: async () => {
            const mayDuplicate = await askProviderMutationBoundary(
              input.beforeProviderMutation,
            );
            if (!mayDuplicate.allowed) {
              throw providerMutationWithheldError(mayDuplicate.reason);
            }
            /*
              Reaching here is the exact moment a POST becomes possible, so it
              is where the attempt is recorded. Setting it before the call would
              have claimed an attempt for an ad the primitive's own account and
              kill-switch checks — or this boundary — refused outright.
            */
            providerMutationAttempted = true;
          },
        });
        if (!adResult.ok) {
          if (!providerMutationAttempted && steps.length === 0 && adIds.length === 0 && isZeroWriteAuthorityRefusal(adResult)) {
            return restoreUnattemptedLaunch({
              businessId, launchIntentId, requestFingerprint: input.requestFingerprint,
              claimStartedAt: executionClaim.startedAt,
              logId: adLog.id, startedAt, error: adResult.error,
            });
          }
          await completeDuplicateFailure({ logId: adLog.id, startedAt, result: adResult });
          const status = getDuplicateFailureLogStatus(adResult);
          results.push({
            creativeId,
            targetCampaignId: target.targetCampaignId,
            targetAdsetId: target.targetAdsetId,
            ok: false,
            ...(adResult.sourceIdentity
              ? { sourceIdentity: adResult.sourceIdentity }
              : {}),
            ...(adResult.providerOutcome
              ? { providerOutcome: adResult.providerOutcome }
              : {}),
            ...(adResult.mutationAttempt
              ? { mutationAttempt: adResult.mutationAttempt }
              : {}),
            ...(isProviderOutcomeAmbiguous(adResult)
              ? { retryAllowed: false as const }
              : {}),
            error: adResult.error,
          });
          steps.push({
            kind: "ad",
            index: stepIndex,
            name: `${adName} -> ${targetAdsetName}`,
            status,
            id: adResult.resultingAdId ?? undefined,
            creativeId,
            ...(adResult.sourceIdentity
              ? { sourceIdentity: adResult.sourceIdentity }
              : {}),
            ...(adResult.providerOutcome
              ? { providerOutcome: adResult.providerOutcome }
              : {}),
            ...(adResult.mutationAttempt
              ? { mutationAttempt: adResult.mutationAttempt }
              : {}),
            ...(isProviderOutcomeAmbiguous(adResult)
              ? { retryAllowed: false as const }
              : {}),
            adsManagerUrl: adResult.resultingAdId
              ? adsManagerUrl(ctx.providerAccountId, "ad", adResult.resultingAdId)
              : undefined,
            error: adResult.error,
          });
          // D065: once a provider mutation has been attempted, any failure is
          // terminal for this request chain. Read-only identity drift may still
          // leave independent later targets safe to inspect.
          if (shouldHaltProviderMutationChain(adResult)) {
            haltedReason = adResult.error;
            break targetLoop;
          }
          continue;
        }
        adIds.push(adResult.newAdId);
        await completeMetaAdsActionLog({
          id: adLog.id,
          status: "success",
          payloadResponse: providerEvidenceWithSourceIdentity(
            adResult.responsePayload,
            adResult.sourceIdentity,
          ),
          resultingAdId: adResult.newAdId,
          durationMs: Date.now() - startedAt,
          verifiedAt: new Date().toISOString(),
          verificationPayload: providerEvidenceWithSourceIdentity(
            adResult.verificationPayload,
            adResult.sourceIdentity,
          ),
        });
        results.push({
          creativeId,
          targetCampaignId: target.targetCampaignId,
          targetAdsetId: target.targetAdsetId,
          ok: true,
          adId: adResult.newAdId,
          sourceIdentity: adResult.sourceIdentity,
        });
        steps.push({
          kind: "ad",
          index: stepIndex,
          name: `${adName} -> ${targetAdsetName}`,
          status: "success",
          id: adResult.newAdId,
          creativeId,
          sourceIdentity: adResult.sourceIdentity,
          adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.newAdId),
        });
      }
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    const firstFailure = results.find((result) => !result.ok)?.error ?? null;
    const hasSilentFailure = steps.some(
      (step) => step.status === "silent_failure",
    );
    const hasAmbiguousOutcome = steps.some(
      (step) => step.providerOutcome === "outcome_ambiguous",
    );
    providerOutcomeStatus =
      failedCount === 0
        ? "succeeded"
        : hasSilentFailure
          ? "silent_failure"
          : successCount > 0
            ? "partially_succeeded"
            : "failed";
    const completedIntent = await recordMetaLaunchIntentOutcome({
      businessId,
      id: launchIntentId,
      status: providerOutcomeStatus,
      resultReceipt: buildMetaLaunchIntentResultReceipt({
        ...receiptBinding,
        providerAccountId,
        adIds,
        steps: stepsAsRecords(steps),
      }),
      errorReceipt:
        failedCount > 0
          ? buildMetaLaunchIntentErrorReceipt({
              ...receiptBinding,
              providerAccountId,
              code:
                haltedReason?.code ??
                firstFailure?.code ??
                "add_to_existing_partial_failure",
              message:
                haltedReason?.message ??
                firstFailure?.message ??
                `${failedCount} add-to-existing operation(s) failed.`,
              failedAt: "ad",
              adIds,
              steps: stepsAsRecords(steps),
            })
          : null,
    });
    return {
      ok: failedCount === 0 && !haltedReason,
      status:
        isMetaWriteBlockedCode(haltedReason?.code)
          ? 503
          // Nothing failed and nothing was sent, so this is not a bad gateway:
          // the boundary refused the rest of the matrix. Same 409 the
          // new-campaign path answers a withheld create with.
          : haltedReason?.code === META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE
            ? 409
            : haltedReason || hasAmbiguousOutcome
              ? 502
              : 200,
      providerMutationAttempted,
      body: {
        ok: failedCount === 0 && !haltedReason,
        targetCampaignId: input.targetCampaignId,
        targetAdsetId: input.targetAdsetId,
        targets: validation.payload.targets,
        results,
        failedCount,
        successCount,
        adIds,
        steps,
        halted: Boolean(haltedReason),
        haltedReason,
        omittedCount:
          validation.payload.targets.length *
            validation.payload.creativeIds.length -
          results.length,
        launchIntentId,
        launchIntentStatus: completedIntent.status,
      },
    };
  } catch (error) {
    const rawMessage = input.sanitizeError(error);
    const errorCode = providerOutcomeStatus
      ? "add_to_existing_receipt_persist_failed"
      : "add_to_existing_failed";
    const message = providerOutcomeStatus
      ? `Meta add-to-existing completed, but its LaunchIntent receipt could not be persisted: ${rawMessage}`
      : rawMessage;
    const intent = await recordMetaLaunchIntentOutcome({
      businessId,
      id: launchIntentId,
      status:
        providerOutcomeStatus ??
        (adIds.length > 0 ? "partially_succeeded" : "failed"),
      resultReceipt: providerOutcomeStatus || adIds.length > 0
        ? buildMetaLaunchIntentResultReceipt({
            ...receiptBinding,
            providerAccountId,
            adIds,
            steps: stepsAsRecords(steps),
          })
        : null,
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: errorCode,
        message,
        failedAt: "orchestration",
        adIds,
        steps: stepsAsRecords(steps),
      }),
    }).catch(() => null);
    return {
      ok: false,
      status: 500,
      providerMutationAttempted,
      body: {
        ok: false,
        error: { code: errorCode, message },
        targetCampaignId: input.targetCampaignId,
        targetAdsetId: input.targetAdsetId,
        targets: validation.payload.targets,
        results,
        failedCount: results.filter((result) => !result.ok).length,
        successCount: results.filter((result) => result.ok).length,
        adIds,
        steps,
        launchIntentId,
        launchIntentStatus: intent?.status ?? "receipt_write_failed",
      },
    };
  }
}
