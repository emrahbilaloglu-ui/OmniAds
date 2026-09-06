import {
  metaLaunchIntentRequestFingerprint,
  type MetaLaunchIntent,
  type MetaLaunchIntentOperation,
} from "@/lib/launchpad/meta-launch-intent";
import {
  createMetaLaunchIntent,
  getMetaLaunchIntent,
} from "@/lib/launchpad/meta-launch-intent-store";
import { readMetaLaunchIntentApprovalStanding } from "@/lib/launchpad/meta-launch-intent-lineage";

export type PrepareMetaLaunchIntentResult =
  | { ok: true; intent: MetaLaunchIntent; created: boolean }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: { code: string; message: string };
      intent?: MetaLaunchIntent;
    };

function hasAmbiguousProviderOutcome(intent: MetaLaunchIntent) {
  if (intent.errorReceipt?.code === "provider_outcome_ambiguous") return true;
  const steps = [
    ...(intent.errorReceipt?.partialResult.steps ?? []),
    ...(intent.resultReceipt?.steps ?? []),
  ];
  return steps.some(
    (step) =>
      step.providerOutcome === "outcome_ambiguous" ||
      step.provider_outcome === "outcome_ambiguous" ||
      (step.error &&
        typeof step.error === "object" &&
        !Array.isArray(step.error) &&
        (step.error as Record<string, unknown>).code ===
          "provider_outcome_ambiguous"),
  );
}

function ambiguousProviderOutcomeError() {
  return {
    code: "launch_intent_provider_outcome_ambiguous",
    message:
      "This LaunchIntent has an unresolved provider-write outcome. Reconcile the exact Meta state and Audit Trail first; do not create a new intent, replay this intent, or issue another provider mutation.",
  };
}

export async function prepareMetaLaunchIntentForExecution(input: {
  businessId: string;
  providerAccountId: string;
  operation: MetaLaunchIntentOperation;
  idempotencyKey: string;
  requestPayload: object;
  launchIntentId?: string | null;
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
  sourceDraftId?: string | null;
  createdBy?: string | null;
}): Promise<PrepareMetaLaunchIntentResult> {
  const launchIntentId = input.launchIntentId?.trim() ?? "";
  const expectedFingerprint = metaLaunchIntentRequestFingerprint(input);

  if (launchIntentId) {
    const intent = await getMetaLaunchIntent({
      businessId: input.businessId,
      id: launchIntentId,
    });
    if (!intent) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "launch_intent_not_found",
          message: "The LaunchIntent was not found for this business.",
        },
      };
    }
    if (
      intent.providerAccountId !== input.providerAccountId ||
      intent.operation !== input.operation ||
      intent.idempotencyKey !== input.idempotencyKey ||
      intent.requestFingerprint !== expectedFingerprint ||
      (input.sourceDecisionId != null &&
        input.sourceDecisionId.trim() !== intent.lineage.sourceDecisionId) ||
      (input.sourceDecisionSnapshotId != null &&
        input.sourceDecisionSnapshotId.trim() !==
          intent.lineage.sourceDecisionSnapshotId) ||
      (input.creativeBriefId != null &&
        input.creativeBriefId.trim() !== intent.lineage.creativeBriefId) ||
      (input.sourceDraftId != null &&
        input.sourceDraftId.trim() !== intent.lineage.sourceDraftId)
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "launch_intent_contract_mismatch",
          message:
            "The immutable LaunchIntent does not match this account, operation, idempotency key, payload, or supplied lineage.",
        },
        intent,
      };
    }
    /*
      A create may also start from a VALIDATED intent that never started one.

      Validation moves an intent `prepared` -> `ready` before the first provider
      POST. A create refused at the pre-POST boundary — a withdrawn approval, a
      gate that closed, a transient unreadable approval source — therefore
      leaves a `ready` intent that reached no provider, and admitting only
      `prepared` here made that launch permanently dead: re-reviewing the brief
      could not revive it, and the producer will not stage a replacement for a
      snapshot it has already staged. Nothing was created on Meta, so refusing
      to let the operator try again is withholding, not safety.

      `ready` AND `started_at IS NULL` is a proven non-attempt, and the proof is
      structural rather than a convention: `markMetaLaunchIntentExecuting` is
      the only writer of `started_at`, it demands `status = 'ready'`, and it
      runs before the first POST in both `runMetaLaunchIntentCreate` and
      `runMetaAddToExistingCreate`. An intent that ever reached a provider has a
      `started_at`, and is still refused below.
    */
    const mayStart =
      intent.status === "prepared"
      || (intent.status === "ready" && intent.startedAt === null);
    if (!mayStart) {
      if (hasAmbiguousProviderOutcome(intent)) {
        return {
          ok: false,
          status: 409,
          error: ambiguousProviderOutcomeError(),
          intent,
        };
      }
      return {
        ok: false,
        status: 409,
        error: {
          code: "launch_intent_already_consumed",
          message:
            "This LaunchIntent has already been evaluated. Create a new intent for any later attempt; automatic retry is not supported.",
        },
        intent,
      };
    }
    /*
      And the approval it was staged under still stands.

      Everything above compares the intent to the request: the account, the
      operation, the idempotency key, the payload fingerprint and the four
      lineage ids. Every one of them still matches after the reviewed brief
      those ids point at has been moved back to `draft`, because the intent
      stores the brief's ID and not its status — so an approval withdrawn any
      time between the staging and this call was, until now, invisible here.

      It is asked LAST, so an intent that is already consumed or has an
      unresolved provider outcome still reports that instead: a withdrawal
      cannot make a launch that may already be live look like one that never
      ran. A refusal here leaves the intent `prepared` and writes nothing, so
      re-reviewing the brief makes this same intent executable again rather
      than forcing a new one.

      That recovery is a property of THIS refusal and of the one the scheduled
      tail makes immediately before it persists its validation receipt — the
      last two points at which the intent has not yet moved. Once
      `recordMetaLaunchIntentValidation` has taken it to `ready`, the status
      check above answers `launch_intent_already_consumed` for it, and a launch
      refused from there reached no provider and can no longer be re-run
      either. So the question is asked wherever the answer is still free, and
      the pre-POST boundary — the only ask that can sit between two POSTs —
      remains the one refusal that does leave the intent `ready`.
    */
    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: input.businessId,
      providerAccountId: intent.providerAccountId,
      lineage: intent.lineage,
    });
    if (!standing.stands) {
      return {
        ok: false,
        status: 409,
        error: { code: standing.code, message: standing.message },
        intent,
      };
    }
    return { ok: true, intent, created: false };
  }

  let created: Awaited<ReturnType<typeof createMetaLaunchIntent>>;
  try {
    created = await createMetaLaunchIntent(input);
  } catch (error) {
    const guarded = error as {
      code?: unknown;
      message?: unknown;
      intent?: unknown;
    };
    if (
      (guarded.code === "launch_intent_provider_outcome_ambiguous" ||
        guarded.code === "launch_intent_semantic_execution_in_flight") &&
      guarded.intent &&
      typeof guarded.intent === "object"
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: guarded.code,
          message:
            typeof guarded.message === "string"
              ? guarded.message
              : "An equivalent semantic LaunchIntent is blocked.",
        },
        intent: guarded.intent as MetaLaunchIntent,
      };
    }
    throw error;
  }
  if (!created.created) {
    if (hasAmbiguousProviderOutcome(created.intent)) {
      return {
        ok: false,
        status: 409,
        error: ambiguousProviderOutcomeError(),
        intent: created.intent,
      };
    }
    return {
      ok: false,
      status: 409,
      error: {
        code: "launch_intent_already_exists",
        message:
          "An intent already exists for this account, operation, and idempotency key. It will not be retried automatically.",
      },
      intent: created.intent,
    };
  }
  return { ok: true, intent: created.intent, created: true };
}
