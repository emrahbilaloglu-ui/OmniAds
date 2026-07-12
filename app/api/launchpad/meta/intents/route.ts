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

type IntentBody = {
  businessId?: string;
  providerAccountId?: string;
  operation?: MetaLaunchIntentOperation;
  idempotencyKey?: string;
  payload?: unknown;
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
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
    ? normalizeMetaAddToExistingPayload(payload)
    : normalizeMetaLaunchPayload(payload);
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
      operation,
      idempotencyKey,
      requestPayload: normalizeIntentPayload(operation, body.payload),
      sourceDecisionId: body.sourceDecisionId,
      sourceDecisionSnapshotId: body.sourceDecisionSnapshotId,
      creativeBriefId: body.creativeBriefId,
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
    return jsonError(
      500,
      "launch_intent_create_failed",
      sanitizeErrorMessage(error),
    );
  }
}
