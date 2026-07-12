import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  getCreativeShareSnapshot,
  getCreativeShareLedgerCapability,
  revokeCreativeShareSnapshot,
  rotateCreativeShareSnapshot,
} from "@/lib/creative-share-store";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

function shareNotFoundResponse() {
  return NextResponse.json(
    { error: "not_found", message: "Share link not found, revoked, or expired." },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const payload = await getCreativeShareSnapshot(token);
  if (!payload) {
    return shareNotFoundResponse();
  }
  return NextResponse.json({ payload }, { headers: NO_STORE_HEADERS });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const body = (await request.json().catch(() => null)) as { businessId?: unknown } | null;
  const queryBusinessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const bodyBusinessId = typeof body?.businessId === "string" ? body.businessId.trim() : "";
  const businessId = queryBusinessId || bodyBusinessId;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "creative_share_revoke");
  if (reviewerBlocked) return reviewerBlocked;
  const capability = await getCreativeShareLedgerCapability();
  if (!capability.canWrite) {
    return NextResponse.json(
      { error: "creative_share_migration_required", message: "Creator share writes require the pending database migration.", capability },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const { token } = await context.params;
  const revoked = await revokeCreativeShareSnapshot({
    token,
    businessId: access.membership.businessId,
    revokedBy: access.session.user.id,
  });
  if (!revoked) return shareNotFoundResponse();

  return NextResponse.json(
    { revoked: true, token },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const body = (await request.json().catch(() => null)) as
    | { businessId?: unknown; action?: unknown }
    | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId.trim() : "";
  if (!businessId || body?.action !== "rotate") {
    return NextResponse.json(
      { error: "invalid_payload", message: "businessId and action=rotate are required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "creative_share_rotate");
  if (reviewerBlocked) return reviewerBlocked;
  const capability = await getCreativeShareLedgerCapability();
  if (!capability.canWrite) {
    return NextResponse.json(
      { error: "creative_share_migration_required", message: "Creator share writes require the pending database migration.", capability },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const { token } = await context.params;
  const rotated = await rotateCreativeShareSnapshot({
    token,
    businessId: access.membership.businessId,
    revokedBy: access.session.user.id,
  });
  if (!rotated) return shareNotFoundResponse();
  return NextResponse.json(rotated, { headers: NO_STORE_HEADERS });
}
