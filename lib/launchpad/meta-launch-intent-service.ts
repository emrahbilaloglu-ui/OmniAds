import {
  metaLaunchIntentRequestFingerprint,
  type MetaLaunchIntent,
  type MetaLaunchIntentOperation,
} from "@/lib/launchpad/meta-launch-intent";
import {
  createMetaLaunchIntent,
  getMetaLaunchIntent,
} from "@/lib/launchpad/meta-launch-intent-store";

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
    if (intent.status !== "prepared") {
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
