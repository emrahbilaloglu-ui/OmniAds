import { NextRequest, NextResponse } from "next/server";
import { deleteManualMetaLaunchTemplate } from "@/lib/launchpad/meta-store";
import {
  jsonError,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../../demo-write-authority";
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
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_template_delete");
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_template_delete",
  );
  if (demoBlocked) return demoBlocked;
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
  const capability = await getMetaLaunchStoreCapability("templates");
  if (!capability.canWrite) {
    return jsonError(
      503,
      "launch_template_migration_required",
      "Saved template storage requires the pending account-scope database migration.",
    );
  }

  const { id } = await context.params;
  const templateId = id?.trim() ?? "";
  if (!templateId) {
    return jsonError(400, "template_id_required", "Template id is required.");
  }

  try {
    const deleted = await deleteManualMetaLaunchTemplate({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
      id: templateId,
    });
    if (!deleted) {
      return jsonError(404, "template_not_found", "Template not found.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(500, "template_delete_failed", sanitizeErrorMessage(error));
  }
}
