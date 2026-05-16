import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { requestMetaSnapshotRefreshForBusiness } from "@/lib/meta/snapshot-refresh";

export const dynamic = "force-dynamic";

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { businessId?: unknown } | null;
  const businessId =
    stringValue(body?.businessId) ||
    stringValue(request.nextUrl.searchParams.get("businessId"));

  if (!businessId) {
    return NextResponse.json(
      { ok: false, error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const refresh = await requestMetaSnapshotRefreshForBusiness({
    businessId: access.membership.businessId,
    reason: "manual",
  });

  return NextResponse.json(
    refresh,
    {
      status: refresh.ok ? 200 : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
