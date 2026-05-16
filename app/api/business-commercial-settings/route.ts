import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  getBusinessCommercialTruthSnapshot,
  upsertBusinessCommercialTruthSnapshot,
} from "@/lib/business-commercial";
import { isDemoBusinessId } from "@/lib/demo-business";
import { requestMetaSnapshotRefreshForBusiness } from "@/lib/meta/snapshot-refresh";
import { isReviewerEmail } from "@/lib/reviewer-access";

function readOnlyReasonForRequest(input: {
  businessId: string;
  email: string | null | undefined;
}) {
  if (isDemoBusinessId(input.businessId) && isReviewerEmail(input.email)) {
    return "The seeded reviewer remains read-only on the canonical demo business.";
  }
  return null;
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
  const readOnlyReason = readOnlyReasonForRequest({
    businessId,
    email: access.session.user.email,
  });

  return NextResponse.json({
    snapshot,
    permissions: {
      canEdit: !readOnlyReason && access.membership.role !== "guest",
      reason: readOnlyReason,
      role: access.membership.role,
    },
  });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        businessId?: string;
        snapshot?: unknown;
      }
    | null;
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

  const readOnlyReason = readOnlyReasonForRequest({
    businessId,
    email: access.session.user.email,
  });
  if (readOnlyReason) {
    return NextResponse.json(
      { error: "forbidden", message: readOnlyReason },
      { status: 403 },
    );
  }

  const snapshot = await upsertBusinessCommercialTruthSnapshot({
    businessId,
    updatedByUserId: access.session.user.id,
    snapshot:
      body?.snapshot && typeof body.snapshot === "object"
        ? (body.snapshot as never)
        : null,
  });
  const decisionSnapshotRefresh = await requestMetaSnapshotRefreshForBusiness({
    businessId,
    reason: "commercial_truth_updated",
  });

  return NextResponse.json({
    snapshot,
    decisionSnapshotRefresh,
    permissions: {
      canEdit: true,
      reason: null,
      role: access.membership.role,
    },
  });
}
