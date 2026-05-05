import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { findCommandCenterActionForRange } from "@/lib/command-center-service";
import {
  addCommandCenterNote,
  getCommandCenterPermissions,
} from "@/lib/command-center-store";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

interface NoteBody {
  businessId?: string;
  startDate?: string;
  endDate?: string;
  actionFingerprint?: string;
  clientMutationId?: string;
  note?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as NoteBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

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

  const actionFingerprint =
    typeof body?.actionFingerprint === "string" ? body.actionFingerprint : null;
  const clientMutationId =
    typeof body?.clientMutationId === "string" ? body.clientMutationId : null;
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!actionFingerprint || !clientMutationId || note.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "actionFingerprint, clientMutationId, and a non-empty note are required.",
      },
      { status: 400 },
    );
  }

  const startDate =
    typeof body?.startDate === "string" ? body.startDate : toISODate(daysAgo(29));
  const endDate =
    typeof body?.endDate === "string" ? body.endDate : toISODate(new Date());
  const action = await findCommandCenterActionForRange({
    request,
    businessId,
    startDate,
    endDate,
    actionFingerprint,
    permissions,
  });

  if (!action) {
    return NextResponse.json(
      {
        error: "action_not_found",
        message: "Command Center action could not be resolved from the live decision snapshot.",
      },
      { status: 404 },
    );
  }

  const state = await addCommandCenterNote({
    businessId,
    action,
    actorUserId: access.session.user.id,
    actorName: access.session.user.name,
    actorEmail: access.session.user.email,
    clientMutationId,
    note,
  });

  return NextResponse.json({
    ok: true,
    state,
  });
}
