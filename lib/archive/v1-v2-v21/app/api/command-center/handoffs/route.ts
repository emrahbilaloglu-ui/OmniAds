import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  COMMAND_CENTER_SHIFTS,
  type CommandCenterShift,
} from "@/lib/command-center";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import {
  acknowledgeCommandCenterHandoff,
  createCommandCenterHandoff,
  getCommandCenterPermissions,
  listCommandCenterHandoffs,
  updateCommandCenterHandoff,
} from "@/lib/command-center-store";

interface HandoffBody {
  businessId?: string;
  handoffId?: string;
  shift?: CommandCenterShift;
  summary?: string;
  blockers?: unknown;
  watchouts?: unknown;
  linkedActionFingerprints?: unknown;
  toUserId?: string | null;
  action?: "acknowledge";
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
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

  const shiftRaw = request.nextUrl.searchParams.get("shift");
  const shift =
    shiftRaw && COMMAND_CENTER_SHIFTS.includes(shiftRaw as CommandCenterShift)
      ? (shiftRaw as CommandCenterShift)
      : null;
  const handoffs = await listCommandCenterHandoffs({ businessId, shift, limit: 20 });
  return NextResponse.json({ handoffs }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as HandoffBody | null;
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

  if (!body?.shift || !COMMAND_CENTER_SHIFTS.includes(body.shift)) {
    return NextResponse.json(
      { error: "invalid_payload", message: "shift is required." },
      { status: 400 },
    );
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  if (!summary) {
    return NextResponse.json(
      { error: "invalid_payload", message: "summary is required." },
      { status: 400 },
    );
  }

  const handoff = await createCommandCenterHandoff({
    businessId,
    shift: body.shift,
    summary,
    blockers: toStringArray(body.blockers),
    watchouts: toStringArray(body.watchouts),
    linkedActionFingerprints: toStringArray(body.linkedActionFingerprints),
    fromUserId: access.session.user.id,
    toUserId: typeof body.toUserId === "string" ? body.toUserId : null,
  });

  return NextResponse.json({ ok: true, handoff });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as HandoffBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  const handoffId =
    typeof body?.handoffId === "string" ? body.handoffId : null;
  if (!businessId || !handoffId) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message: "businessId and handoffId are required.",
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

  if (body?.action === "acknowledge") {
    const handoff = await acknowledgeCommandCenterHandoff({
      businessId,
      handoffId,
      userId: access.session.user.id,
    });
    return NextResponse.json({ ok: true, handoff });
  }

  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
  if (!summary) {
    return NextResponse.json(
      { error: "invalid_payload", message: "summary is required." },
      { status: 400 },
    );
  }

  const handoff = await updateCommandCenterHandoff({
    businessId,
    handoffId,
    summary,
    blockers: toStringArray(body?.blockers),
    watchouts: toStringArray(body?.watchouts),
    linkedActionFingerprints: toStringArray(body?.linkedActionFingerprints),
    toUserId: typeof body?.toUserId === "string" ? body.toUserId : null,
  });

  return NextResponse.json({ ok: true, handoff });
}
