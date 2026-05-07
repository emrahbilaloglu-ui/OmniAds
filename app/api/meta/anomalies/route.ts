import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const activeOnly = searchParams.get("activeOnly") === "1";

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId is required." },
      { status: 400 },
    );
  }

  const result = await readMetaAnomaliesForBusiness({
    businessId,
    activeOnly,
  });

  return NextResponse.json(result);
}
