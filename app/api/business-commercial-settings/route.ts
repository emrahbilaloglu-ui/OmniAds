import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  BusinessCommercialSnapshotConflictError,
  businessCommercialSnapshotRevision,
  getBusinessCommercialTruthSnapshot,
  reconfirmBusinessTargetPack,
  upsertBusinessCommercialTruthSnapshot,
} from "@/lib/business-commercial";
import { requestMetaSnapshotRefreshForBusiness } from "@/lib/meta/snapshot-refresh";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { readLaunchpadWriteAuthority } from "@/app/api/launchpad/meta/demo-write-authority";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";

const STRICT_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const STRICT_SNAPSHOT_REVISION = /^[a-f0-9]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const match = STRICT_ISO_TIMESTAMP.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value))
  );
}

function readCommercialValidationError(error: unknown) {
  if (
    !(error instanceof Error) ||
    error.name !== "BusinessCommercialInputValidationError"
  ) {
    return null;
  }
  const detail = error as Error & {
    code?: unknown;
    field?: unknown;
    reason?: unknown;
  };
  return {
    code: typeof detail.code === "string" ? detail.code : "invalid_target_pack",
    field: typeof detail.field === "string" ? detail.field : null,
    reason: typeof detail.reason === "string" ? detail.reason : null,
    message: detail.message,
  };
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const snapshot = await getBusinessCommercialTruthSnapshot(businessId);
  /*
   * What the screen may OFFER, restated from the same two authorities the
   * write path enforces — never a third opinion.
   *
   * The reviewer half is `rejectIfReviewerReadOnly`'s own test, and the demo
   * half is the fail-closed read. A GET must not be refused for either: a
   * reviewer and a demo operator may both READ commercial truth, and telling
   * them so before the click is the point of this field.
   */
  const reviewerReadOnly = Boolean(rejectIfReviewerReadOnly(access, "commercial_truth_update"));
  const writeAuthority = await readLaunchpadWriteAuthority(access.membership.businessId);
  const readOnlyReason = reviewerReadOnly
    ? "Reviewer access is read-only; commercial truth cannot be edited."
    : writeAuthority === "demo"
      ? "Demo workspaces have zero Meta write authority, so commercial truth is read-only here."
      : writeAuthority !== "live"
        ? "This workspace could not be confirmed as a live workspace, so commercial truth is held read-only."
        : null;

  return NextResponse.json({
    snapshot,
    revision: businessCommercialSnapshotRevision(snapshot),
    permissions: {
      canEdit: !readOnlyReason && access.membership.role !== "guest",
      reason: readOnlyReason,
      role: access.membership.role,
    },
  });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: string;
    snapshot?: unknown;
    expectedRevision?: unknown;
  } | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  /*
   * The reviewer floor, and the same one every sibling Meta write route uses.
   *
   * This was a narrower, hand-rolled check: refuse only when the caller was
   * BOTH the reviewer email AND on the well-known demo id. It therefore let a
   * reviewer write commercial truth on any other workspace, and it answered
   * the demo question with `isDemoBusinessId`, an id comparison that never
   * reads `businesses.is_demo_business`. The plan's §18 says the reviewer/demo
   * guard belongs on every Meta server write route; this is that guard, and
   * the demo half is the fail-closed authority below.
   */
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "commercial_truth_update");
  if (reviewerBlocked) return reviewerBlocked;

  if (!isPlainObject(body?.snapshot)) {
    return NextResponse.json(
      {
        error: "invalid_snapshot",
        message: "snapshot must be a JSON object.",
      },
      { status: 422 },
    );
  }
  if (
    typeof body.snapshot.businessId === "string" &&
    body.snapshot.businessId !== businessId
  ) {
    return NextResponse.json(
      {
        error: "snapshot_business_mismatch",
        message: "snapshot.businessId must match businessId.",
      },
      { status: 422 },
    );
  }
  if (
    typeof body.expectedRevision !== "string" ||
    !STRICT_SNAPSHOT_REVISION.test(body.expectedRevision)
  ) {
    return NextResponse.json(
      {
        error: "invalid_expected_revision",
        message:
          "expectedRevision must be the revision returned by the latest GET.",
      },
      { status: 422 },
    );
  }

  /*
   * Demo authority, before the first durable write.
   *
   * The commercial truth snapshot is what `INVARIANTS.md` calls the hard-action
   * anchor: `target_roas`, `break_even_roas`, `target_cpa`, `break_even_cpa`.
   * Writing it for a demo workspace changes what the recommendation engine is
   * allowed to do, and the engine then runs on the next snapshot. Read against
   * the SERVER's resolved business id, and fail-closed on an unreadable flag.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "commercial_truth_update",
  );
  if (demoBlocked) return demoBlocked;

  let snapshot;
  try {
    snapshot = await upsertBusinessCommercialTruthSnapshot({
      businessId,
      updatedByUserId: access.session.user.id,
      snapshot: body.snapshot as never,
      expectedRevision: body.expectedRevision,
    });
  } catch (error) {
    if (error instanceof BusinessCommercialSnapshotConflictError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    }
    const validation = readCommercialValidationError(error);
    if (!validation) throw error;
    return NextResponse.json(
      {
        error: validation.code,
        message: validation.message,
        field: validation.field,
        reason: validation.reason,
      },
      { status: 422 },
    );
  }
  const decisionSnapshotRefresh = await requestMetaSnapshotRefreshForBusiness({
    businessId,
    reason: "commercial_truth_updated",
  });

  return NextResponse.json({
    snapshot,
    revision: businessCommercialSnapshotRevision(snapshot),
    decisionSnapshotRefresh,
    permissions: {
      canEdit: true,
      reason: null,
      role: access.membership.role,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: string;
    action?: string;
    expectedUpdatedAt?: unknown;
  } | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  /*
   * The reviewer floor, and the same one every sibling Meta write route uses.
   *
   * This was a narrower, hand-rolled check: refuse only when the caller was
   * BOTH the reviewer email AND on the well-known demo id. It therefore let a
   * reviewer write commercial truth on any other workspace, and it answered
   * the demo question with `isDemoBusinessId`, an id comparison that never
   * reads `businesses.is_demo_business`. The plan's §18 says the reviewer/demo
   * guard belongs on every Meta server write route; this is that guard, and
   * the demo half is the fail-closed authority below.
   */
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "target_pack_reconfirm");
  if (reviewerBlocked) return reviewerBlocked;

  if (body?.action !== "reconfirm_target_pack") {
    return NextResponse.json(
      {
        error: "invalid_action",
        message: "action must be reconfirm_target_pack.",
      },
      { status: 400 },
    );
  }
  const unexpectedFields = body
    ? Object.keys(body).filter(
        (field) =>
          !["businessId", "action", "expectedUpdatedAt"].includes(field),
      )
    : [];
  if (unexpectedFields.length > 0) {
    return NextResponse.json(
      {
        error: "unexpected_field",
        message:
          "Target-pack reconfirmation accepts only businessId, action, and expectedUpdatedAt.",
        fields: unexpectedFields,
      },
      { status: 400 },
    );
  }
  if (!isStrictIsoTimestamp(body.expectedUpdatedAt)) {
    return NextResponse.json(
      {
        error: "invalid_expected_updated_at",
        message:
          "expectedUpdatedAt must be a valid ISO 8601 timestamp with a timezone and at most six fractional digits.",
      },
      { status: 400 },
    );
  }

  /*
   * The same boundary for reconfirmation. It stamps a fresh confirmation on
   * the target pack, which is what maturity and hard-action gates read as
   * proof the anchors are current — a durable write by any measure.
   */
  const reconfirmDemoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "target_pack_reconfirm",
  );
  if (reconfirmDemoBlocked) return reconfirmDemoBlocked;

  const reconfirmation = await reconfirmBusinessTargetPack({
    businessId,
    updatedByUserId: access.session.user.id,
    expectedUpdatedAt: body.expectedUpdatedAt,
  });

  if (reconfirmation.status === "missing") {
    return NextResponse.json(
      {
        error: "target_pack_missing",
        message: "The target pack no longer exists.",
        reconfirmation,
      },
      { status: 404 },
    );
  }
  if (reconfirmation.status === "conflict") {
    return NextResponse.json(
      {
        error: "target_pack_changed",
        message:
          "The target pack changed after it was loaded. Reload it before reconfirming.",
        reconfirmation,
      },
      { status: 409 },
    );
  }
  if (reconfirmation.status === "invalid_target_pack") {
    return NextResponse.json(
      {
        error: "invalid_target_pack",
        message:
          "The stored target pack has invalid economic anchors and cannot be reconfirmed.",
        reconfirmation,
      },
      { status: 422 },
    );
  }

  const decisionSnapshotRefresh = await requestMetaSnapshotRefreshForBusiness({
    businessId,
    reason: "commercial_truth_updated",
  });
  const snapshot = await getBusinessCommercialTruthSnapshot(businessId);

  return NextResponse.json({
    snapshot,
    revision: businessCommercialSnapshotRevision(snapshot),
    reconfirmation,
    decisionSnapshotRefresh,
    permissions: {
      canEdit: true,
      reason: null,
      role: access.membership.role,
    },
  });
}
