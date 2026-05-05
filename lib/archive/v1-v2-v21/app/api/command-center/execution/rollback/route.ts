import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getCommandCenterPermissions } from "@/lib/command-center-store";
import { findCommandCenterActionForRange } from "@/lib/command-center-service";
import {
  isCommandCenterExecutionError,
  rollbackCommandCenterExecution,
} from "@/lib/command-center-execution-service";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

interface RollbackBody {
  businessId?: string;
  startDate?: string;
  endDate?: string;
  actionFingerprint?: string;
  clientMutationId?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as RollbackBody | null;
  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  const actionFingerprint =
    typeof body?.actionFingerprint === "string" ? body.actionFingerprint : null;
  const clientMutationId =
    typeof body?.clientMutationId === "string" ? body.clientMutationId : null;

  if (!businessId || !actionFingerprint || !clientMutationId) {
    return NextResponse.json(
      {
        error: "invalid_payload",
        message:
          "businessId, actionFingerprint, and clientMutationId are required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

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

  try {
    const preview = await rollbackCommandCenterExecution({
      businessId,
      action,
      startDate,
      endDate,
      permissions,
      request,
      actorUserId: access.session.user.id,
      actorName: access.session.user.name,
      actorEmail: access.session.user.email,
      clientMutationId,
    });

    return NextResponse.json({
      ok: true,
      preview,
    });
  } catch (error) {
    if (isCommandCenterExecutionError(error)) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        error: "execution_rollback_failed",
        message:
          error instanceof Error
            ? error.message
            : "Command Center execution rollback failed.",
      },
      { status: 500 },
    );
  }
}
