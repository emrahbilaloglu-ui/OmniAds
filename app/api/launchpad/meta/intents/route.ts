import { NextRequest, NextResponse } from "next/server";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  createMetaLaunchIntent,
  listMetaLaunchIntents,
} from "@/lib/launchpad/meta-launch-intent-store";
import type { MetaLaunchIntentOperation } from "@/lib/launchpad/meta-launch-intent";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
} from "@/lib/launchpad/meta-manual-authority";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../demo-write-authority";

type IntentBody = {
  businessId?: string;
  providerAccountId?: string;
  operation?: MetaLaunchIntentOperation;
  idempotencyKey?: string;
  payload?: unknown;
  actionOrigin?: string;
  manualConfirmation?: string;
  sourceDraftId?: string | null;
};

export const dynamic = "force-dynamic";

function accountErrorResponse(
  result: Extract<
    Awaited<ReturnType<typeof resolveAssignedMetaLaunchAccount>>,
    { ok: false }
  >,
) {
  return jsonError(
    metaLaunchAccountBlockerHttpStatus(result.blocker.code),
    result.blocker.code,
    result.blocker.message,
  );
}

function normalizeIntentPayload(operation: MetaLaunchIntentOperation, payload: unknown) {
  return operation === "add_to_existing"
    ? {
        operation,
        payload: normalizeMetaAddToExistingPayload(payload),
      }
    : {
        operation,
        payload: normalizeMetaLaunchPayload(payload),
      };
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: requestedAccountId,
  });
  if (!account.ok) return accountErrorResponse(account);

  try {
    const capability = await getMetaLaunchIntentCapability();
    if (!capability.canRead) {
      return NextResponse.json({
        ok: true,
        providerAccountId: account.providerAccountId,
        capability,
        intents: [],
      });
    }
    const intents = await listMetaLaunchIntents({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
      limit: Number(request.nextUrl.searchParams.get("limit") ?? 25),
    });
    return NextResponse.json({
      ok: true,
      providerAccountId: account.providerAccountId,
      capability,
      intents,
    });
  } catch (error) {
    return jsonError(
      500,
      "launch_intents_failed",
      sanitizeErrorMessage(error),
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<IntentBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(
    access,
    "launchpad_prepare_intent",
  );
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_prepare_intent",
  );
  if (demoBlocked) return demoBlocked;
  const manualAuthority = evaluateMetaLaunchpadManualAuthority(body);
  if (!manualAuthority.ok) {
    return jsonError(
      manualAuthority.status,
      manualAuthority.error.code,
      manualAuthority.error.message,
    );
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) return accountErrorResponse(account);

  const operation = body?.operation;
  if (operation !== "new_campaign" && operation !== "add_to_existing") {
    return jsonError(
      400,
      "launch_intent_operation_required",
      "operation must be new_campaign or add_to_existing.",
    );
  }
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  if (!idempotencyKey) {
    return jsonError(
      400,
      "idempotency_key_required",
      "idempotencyKey is required.",
    );
  }
  if (!body || !("payload" in body)) {
    return jsonError(
      400,
      "launch_intent_payload_required",
      "payload is required.",
    );
  }

  const normalizedIntent = normalizeIntentPayload(operation, body.payload);
  const executionBounds =
    normalizedIntent.operation === "add_to_existing"
      ? evaluateMetaLaunchpadExecutionBounds({
          operation: normalizedIntent.operation,
          creativeCount: normalizedIntent.payload.creativeIds.length,
          adSetOrTargetCount: normalizedIntent.payload.targets.length,
          copyMode: normalizedIntent.payload.copyMode,
        })
      : evaluateMetaLaunchpadExecutionBounds({
          operation: normalizedIntent.operation,
          creativeCount: normalizedIntent.payload.creativeIds.length,
          adSetOrTargetCount: normalizedIntent.payload.adSets.length,
        });
  if (!executionBounds.ok) {
    const blocker = executionBounds.blockers[0]!;
    return NextResponse.json(
      {
        ok: false,
        error: blocker,
        blockers: executionBounds.blockers,
        counts: executionBounds.counts,
      },
      { status: 413 },
    );
  }

  try {
    const capability = await getMetaLaunchIntentCapability();
    if (!capability.canWrite) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "launch_intent_migration_required",
            message:
              "LaunchIntent storage is unavailable until the pending database migration is applied.",
          },
          capability,
        },
        { status: 503 },
      );
    }
    const result = await createMetaLaunchIntent({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
      operation: normalizedIntent.operation,
      idempotencyKey,
      requestPayload: bindMetaLaunchpadManualAuthorityToPayload(
        normalizedIntent.payload,
        manualAuthority.authority,
      ),
      sourceDraftId: body.sourceDraftId,
      createdBy: access.userId,
    });
    if (!result.created) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "launch_intent_already_exists",
            message:
              "An intent already exists for this account, operation, and idempotency key. It will not be retried automatically.",
          },
          intent: result.intent,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, intent: result.intent }, { status: 201 });
  } catch (error) {
    if (error instanceof MetaLaunchIntentLineageError) {
      return jsonError(422, error.code, error.message);
    }
    const guarded = error as {
      code?: unknown;
      message?: unknown;
      intent?: unknown;
    };
    if (
      guarded.code === "launch_intent_provider_outcome_ambiguous" ||
      guarded.code === "launch_intent_semantic_execution_in_flight"
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: guarded.code,
            message:
              typeof guarded.message === "string"
                ? guarded.message
                : "An equivalent semantic LaunchIntent is blocked.",
          },
          intent:
            guarded.intent && typeof guarded.intent === "object"
              ? guarded.intent
              : null,
        },
        { status: 409 },
      );
    }
    return jsonError(
      500,
      "launch_intent_create_failed",
      sanitizeErrorMessage(error),
    );
  }
}
