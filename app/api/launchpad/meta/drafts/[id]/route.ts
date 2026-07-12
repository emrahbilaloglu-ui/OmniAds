import { NextRequest, NextResponse } from "next/server";
import { deleteMetaLaunchDraft } from "@/lib/launchpad/meta-store";
import {
  jsonError,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";
import { getMetaLaunchStoreCapability } from "@/lib/launchpad/meta-store-capability";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, context: RouteParams) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_draft_delete");
  if (reviewerBlocked) return reviewerBlocked;
  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: request.nextUrl.searchParams.get("providerAccountId"),
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const capability = await getMetaLaunchStoreCapability("drafts");
  if (!capability.canWrite) {
    return jsonError(
      503,
      "launch_draft_migration_required",
      "Draft storage requires the pending account-scope database migration.",
    );
  }

  const { id } = await context.params;
  const draftId = id?.trim() ?? "";
  if (!draftId) {
    return jsonError(400, "draft_id_required", "Draft id is required.");
  }

  try {
    const deleted = await deleteMetaLaunchDraft({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
      id: draftId,
    });
    if (!deleted) {
      return jsonError(404, "draft_not_found", "Draft not found.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(500, "draft_delete_failed", sanitizeErrorMessage(error));
  }
}
