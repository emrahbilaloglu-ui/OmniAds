import { NextRequest, NextResponse } from "next/server";
import { listRecentMetaLaunchTemplates } from "@/lib/launchpad/meta-store";
import {
  jsonError,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  try {
    const templates = await listRecentMetaLaunchTemplates({
      businessId: access.businessId,
    });
    return NextResponse.json({ ok: true, templates });
  } catch (error) {
    return jsonError(500, "recent_templates_failed", sanitizeErrorMessage(error));
  }
}
