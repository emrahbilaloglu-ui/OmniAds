import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { readTriageState } from "@/lib/triage-events";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const scopeType = request.nextUrl.searchParams.get("scopeType")?.trim() || null;

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const state = await readTriageState({
    businessId: access.membership.businessId,
    scopeType,
  });

  return NextResponse.json(
    {
      ok: true,
      businessId: access.membership.businessId,
      rows: state.rows,
      deferredCount: state.deferredCount,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
