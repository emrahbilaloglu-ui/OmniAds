import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { getCommandCenterSnapshot } from "@/lib/command-center-service";
import { getCommandCenterPermissions } from "@/lib/command-center-store";

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
  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
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

  if (!isCommandCenterV1EnabledForBusiness(businessId)) {
    return NextResponse.json(
      {
        error: "command_center_disabled",
        message: "Command Center is feature-gated for this workspace.",
      },
      { status: 404 },
    );
  }

  const startDate =
    request.nextUrl.searchParams.get("startDate") ?? toISODate(daysAgo(29));
  const endDate =
    request.nextUrl.searchParams.get("endDate") ?? toISODate(new Date());
  const viewKey = request.nextUrl.searchParams.get("viewKey");
  const permissions = getCommandCenterPermissions({
    businessId,
    email: access.session.user.email,
    role: access.membership.role,
  });

  const payload = await getCommandCenterSnapshot({
    request,
    businessId,
    startDate,
    endDate,
    activeViewKey: viewKey,
    permissions,
  });

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
