import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  getCreativeShareSnapshot,
  getCreativeShareLedgerCapability,
  deleteCreativeShareSnapshot,
  revokeCreativeShareSnapshot,
  rotateCreativeShareSnapshot,
} from "@/lib/creative-share-store";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { normalizeCreativeShareToken } from "@/lib/creative-share-link";
import { toPublicShare } from "@/lib/zero-base/creative/public-share";

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
  const token = normalizeCreativeShareToken((await context.params).token);
  if (!token) return shareNotFoundResponse();
  const payload = await getCreativeShareSnapshot(token);
  if (!payload) {
    return shareNotFoundResponse();
  }
  // This endpoint is public. Return the same closed projection as the public
  // page, never the stored buyer payload with workspace/account identifiers.
  return NextResponse.json({ payload: toPublicShare(payload) }, { headers: NO_STORE_HEADERS });
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
  /*
   * Demo authority on the withdrawal paths too.
   *
   * Revoking, rotating and deleting are writes against the share ledger, and a
   * demo workspace has no rows there that a real operator issued. Note the
   * release gate is deliberately NOT applied to withdrawal — taking a link
   * back must never depend on a rollout flag — but WRITE AUTHORITY is a
   * different question, and a workspace with none has none in either
   * direction. Fail-closed.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "creative_share_revoke",
  );
  if (demoBlocked) return demoBlocked;
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
  const action = body?.action;
  if (!businessId || (action !== "rotate" && action !== "delete")) {
    return NextResponse.json(
      { error: "invalid_payload", message: "businessId and action=rotate|delete are required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    action === "delete" ? "creative_share_delete" : "creative_share_rotate",
  );
  if (reviewerBlocked) return reviewerBlocked;
  // The same authority for rotate and delete. See DELETE above.
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    action === "delete" ? "creative_share_delete" : "creative_share_rotate",
  );
  if (demoBlocked) return demoBlocked;
  const capability = await getCreativeShareLedgerCapability();
  if (!capability.canWrite) {
    return NextResponse.json(
      { error: "creative_share_migration_required", message: "Creator share writes require the pending database migration.", capability },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const { token } = await context.params;

  if (action === "delete") {
    const deleted = await deleteCreativeShareSnapshot({
      token,
      businessId: access.membership.businessId,
      revokedBy: access.session.user.id,
    });
    if (!deleted) return shareNotFoundResponse();
    return NextResponse.json({ deleted: true, token }, { headers: NO_STORE_HEADERS });
  }

  const rotated = await rotateCreativeShareSnapshot({
    token,
    businessId: access.membership.businessId,
    revokedBy: access.session.user.id,
  });
  if (!rotated) return shareNotFoundResponse();
  return NextResponse.json(rotated, { headers: NO_STORE_HEADERS });
}
