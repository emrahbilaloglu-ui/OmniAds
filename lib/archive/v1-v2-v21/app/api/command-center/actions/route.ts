import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  COMMAND_CENTER_ACTION_MUTATIONS,
  type CommandCenterActionMutation,
} from "@/lib/command-center";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { findCommandCenterActionForRange } from "@/lib/command-center-service";
import {
  applyCommandCenterActionMutation,
  getCommandCenterPermissions,
  listAssignableCommandCenterUsers,
} from "@/lib/command-center-store";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

interface ActionMutationBody {
  businessId?: string;
  startDate?: string;
  endDate?: string;
  actionFingerprint?: string;
  clientMutationId?: string;
  mutation?: CommandCenterActionMutation;
  assigneeUserId?: string | null;
  snoozeUntil?: string | null;
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | ActionMutationBody
    | null;

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
  const mutation =
    typeof body?.mutation === "string" &&
    COMMAND_CENTER_ACTION_MUTATIONS.includes(
      body.mutation as CommandCenterActionMutation,
    )
      ? (body.mutation as CommandCenterActionMutation)
      : null;

  if (!actionFingerprint || !clientMutationId || !mutation) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "actionFingerprint, clientMutationId, and a valid mutation are required.",
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

  let assigneeName: string | null | undefined = undefined;
  if (mutation === "assign") {
    const allowedUsers = await listAssignableCommandCenterUsers(businessId);
    const assigneeUserId =
      typeof body?.assigneeUserId === "string" ? body.assigneeUserId : null;
    const assignee = assigneeUserId
      ? allowedUsers.find((user) => user.userId === assigneeUserId) ?? null
      : null;
    if (assigneeUserId && !assignee) {
      return NextResponse.json(
        {
          error: "invalid_assignee",
          message:
            "Only active collaborator/admin members can be assigned command center actions.",
        },
        { status: 400 },
      );
    }
    assigneeName = assignee?.name ?? null;
  }

  try {
    const state = await applyCommandCenterActionMutation({
      businessId,
      action,
      actorUserId: access.session.user.id,
      actorName: access.session.user.name,
      actorEmail: access.session.user.email,
      clientMutationId,
      mutation,
      assigneeUserId:
        typeof body?.assigneeUserId === "string" ? body.assigneeUserId : null,
      assigneeName,
      snoozeUntil:
        typeof body?.snoozeUntil === "string" ? body.snoozeUntil : null,
    });

    return NextResponse.json({
      ok: true,
      state,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "mutation_failed",
        message:
          error instanceof Error
            ? error.message
            : "Command Center mutation failed.",
      },
      { status: 400 },
    );
  }
}
