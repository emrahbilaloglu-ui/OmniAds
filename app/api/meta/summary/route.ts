import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaCanonicalOverviewSummary } from "@/lib/meta/canonical-overview";
import { getDemoMetaSummary } from "@/lib/demo-business";
import { readMetaBusinessDataPosture } from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";

export interface MetaSummaryRouteResponse
  extends Awaited<ReturnType<typeof getMetaCanonicalOverviewSummary>> {}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  /*
   * Tri-state, not the id comparison. `isDemoBusinessId` never reads the
   * column, so every workspace that is not the well-known demo id fell through
   * to the live branch — including one whose flag could not be read at all.
   */
  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture === "demo") {
    return NextResponse.json({ ...getDemoMetaSummary(), isPartial: false, notReadyReason: null });
  }
  if (posture !== "live") return metaPostureUnavailable("meta_summary");

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_date_range", message: "startDate and endDate are required." },
      { status: 400 }
    );
  }

  const payload = await getMetaCanonicalOverviewSummary({
    businessId: businessId!,
    startDate,
    endDate,
  });

  return NextResponse.json(
    payload satisfies MetaSummaryRouteResponse,
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
