import { NextRequest, NextResponse } from "next/server";
import {
  createManualMetaLaunchTemplate,
  listManualMetaLaunchTemplates,
} from "@/lib/launchpad/meta-store";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

export const dynamic = "force-dynamic";

type TemplateBody = {
  businessId?: string;
  name?: string;
  description?: string | null;
  payload?: unknown;
};

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  try {
    const templates = await listManualMetaLaunchTemplates({
      businessId: access.businessId,
    });
    return NextResponse.json({ ok: true, templates });
  } catch (error) {
    return jsonError(500, "templates_failed", sanitizeErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<TemplateBody>(request);
  const businessId =
    body?.businessId ?? request.nextUrl.searchParams.get("businessId") ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const name = body?.name?.trim() ?? "";
  if (!name) {
    return jsonError(400, "template_name_required", "Template name is required.");
  }
  if (!body || !("payload" in body)) {
    return jsonError(400, "template_payload_required", "Template payload is required.");
  }

  try {
    const template = await createManualMetaLaunchTemplate({
      businessId: access.businessId,
      name,
      description: body.description ?? null,
      payload: body.payload,
      createdBy: access.userId,
    });
    return NextResponse.json({ ok: true, template });
  } catch (error) {
    return jsonError(500, "template_create_failed", sanitizeErrorMessage(error));
  }
}
