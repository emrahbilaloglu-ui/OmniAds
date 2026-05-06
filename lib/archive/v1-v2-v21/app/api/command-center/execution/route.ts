import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getCommandCenterPermissions } from "@/lib/command-center-store";
import { findCommandCenterActionForRange } from "@/lib/command-center-service";
import {
  getCommandCenterExecutionPreview,
  isCommandCenterExecutionError,
} from "@/lib/command-center-execution-service";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const actionFingerprint = request.nextUrl.searchParams.get("actionFingerprint");

  if (!businessId || !actionFingerprint) {
    return NextResponse.json(
      {
        error: "invalid_query",
        message: "businessId and actionFingerprint are required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });
  const startDate =
    request.nextUrl.searchParams.get("startDate") ?? toISODate(daysAgo(29));
  const endDate =
    request.nextUrl.searchParams.get("endDate") ?? toISODate(new Date());

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
    const preview = await getCommandCenterExecutionPreview({
      request,
      businessId,
      startDate,
      endDate,
      action,
      permissions,
    });
    return NextResponse.json(preview, {
      headers: { "Cache-Control": "no-store" },
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
        error: "execution_preview_failed",
        message:
          error instanceof Error
            ? error.message
            : "Execution preview failed.",
      },
      { status: 500 },
    );
  }
}
