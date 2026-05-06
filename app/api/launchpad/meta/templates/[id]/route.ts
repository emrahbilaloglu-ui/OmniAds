import { NextRequest, NextResponse } from "next/server";
import { deleteManualMetaLaunchTemplate } from "@/lib/launchpad/meta-store";
import {
  jsonError,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../route-utils";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, context: RouteParams) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const { id } = await context.params;
  const templateId = id?.trim() ?? "";
  if (!templateId) {
    return jsonError(400, "template_id_required", "Template id is required.");
  }

  try {
    const deleted = await deleteManualMetaLaunchTemplate({
      businessId: access.businessId,
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
