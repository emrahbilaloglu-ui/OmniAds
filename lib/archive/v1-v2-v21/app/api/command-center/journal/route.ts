import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isCommandCenterV1EnabledForBusiness } from "@/lib/command-center-config";
import { listCommandCenterJournal } from "@/lib/command-center-store";

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

  const actionFingerprint = request.nextUrl.searchParams.get("actionFingerprint");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  const journal = await listCommandCenterJournal({
    businessId,
    actionFingerprint,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  return NextResponse.json({ journal }, { headers: { "Cache-Control": "no-store" } });
}
