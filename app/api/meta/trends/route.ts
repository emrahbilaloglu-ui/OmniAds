import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaCanonicalOverviewTrends } from "@/lib/meta/canonical-overview";
import { getDemoMetaTrends } from "@/lib/demo-business";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";

export interface MetaTrendsRouteResponse
  extends Awaited<ReturnType<typeof getMetaCanonicalOverviewTrends>> {}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture === "demo") {
    return NextResponse.json({ ...getDemoMetaTrends(), isPartial: false, notReadyReason: null });
  }
  if (posture !== "live") return metaPostureUnavailable("meta_trends");

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_date_range", message: "startDate and endDate are required." },
      { status: 400 }
    );
  }

  const payload = await getMetaCanonicalOverviewTrends({
    businessId: businessId!,
    startDate,
    endDate,
  });

  return NextResponse.json(
    payload satisfies MetaTrendsRouteResponse,
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
