import { NextRequest, NextResponse } from "next/server";
import { listRecentMetaLaunchTemplates } from "@/lib/launchpad/meta-store";
import {
  jsonError,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
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

  try {
    const templates = await listRecentMetaLaunchTemplates({
      businessId: access.businessId,
      providerAccountId: account.providerAccountId,
    });
    return NextResponse.json({ ok: true, templates });
  } catch (error) {
    return jsonError(500, "recent_templates_failed", sanitizeErrorMessage(error));
  }
}
