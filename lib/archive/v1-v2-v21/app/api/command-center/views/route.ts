import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import {
  createCommandCenterSavedView,
  deleteCommandCenterSavedView,
  getCommandCenterPermissions,
  listCommandCenterSavedViews,
  updateCommandCenterSavedView,
} from "@/lib/command-center-store";
import { sanitizeCommandCenterSavedViewDefinition } from "@/lib/command-center";

interface ViewBody {
  businessId?: string;
  viewKey?: string;
  name?: string;
  definition?: unknown;
}

async function resolveAccess(request: NextRequest, businessId: string | null, minRole: "guest" | "collaborator") {
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole,
  });
  if ("error" in access) return access.error;
  return access;
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

  const access = await resolveAccess(request, businessId, "guest");
  if (access instanceof NextResponse) return access;

  if (!isCommandCenterV1EnabledForBusiness(businessId)) {
    return NextResponse.json(
      {
        error: "command_center_disabled",
        message: "Command Center is feature-gated for this workspace.",
      },
      { status: 404 },
    );
  }

  const views = await listCommandCenterSavedViews(businessId);
  return NextResponse.json({ views }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ViewBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await resolveAccess(request, businessId, "collaborator");
  if (access instanceof NextResponse) return access;

  if (!isCommandCenterV1EnabledForBusiness(businessId)) {
    return NextResponse.json(
      {
        error: "command_center_disabled",
        message: "Command Center is feature-gated for this workspace.",
      },
      { status: 404 },
    );
  }

  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });
  if (!permissions.canEdit) {
    return NextResponse.json(
      { error: "forbidden", message: permissions.reason ?? "Read-only access." },
      { status: 403 },
    );
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "invalid_payload", message: "name is required." },
      { status: 400 },
    );
  }

  try {
    const view = await createCommandCenterSavedView({
      businessId,
      name,
      definition: sanitizeCommandCenterSavedViewDefinition(body?.definition),
    });
    return NextResponse.json({ ok: true, view });
  } catch (error) {
    return NextResponse.json(
      {
        error: "view_create_failed",
        message:
          error instanceof Error ? error.message : "Could not create saved view.",
      },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ViewBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  const viewKey = typeof body?.viewKey === "string" ? body.viewKey : null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!businessId || !viewKey || !name) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: "businessId, viewKey, and name are required.",
      },
      { status: 400 },
    );
  }

  const access = await resolveAccess(request, businessId, "collaborator");
  if (access instanceof NextResponse) return access;

  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });
  if (!permissions.canEdit) {
    return NextResponse.json(
      { error: "forbidden", message: permissions.reason ?? "Read-only access." },
      { status: 403 },
    );
  }

  const view = await updateCommandCenterSavedView({
    businessId,
    viewKey,
    name,
    definition: sanitizeCommandCenterSavedViewDefinition(body?.definition),
  });
  if (!view) {
    return NextResponse.json(
      { error: "view_not_found", message: "Saved view was not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, view });
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ViewBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  const viewKey = typeof body?.viewKey === "string" ? body.viewKey : null;
  if (!businessId || !viewKey) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: "businessId and viewKey are required.",
      },
      { status: 400 },
    );
  }

  const access = await resolveAccess(request, businessId, "collaborator");
  if (access instanceof NextResponse) return access;

  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });
  if (!permissions.canEdit) {
    return NextResponse.json(
      { error: "forbidden", message: permissions.reason ?? "Read-only access." },
      { status: 403 },
    );
  }

  await deleteCommandCenterSavedView({ businessId, viewKey });
  return NextResponse.json({ ok: true });
}
