import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoGoogleAdsBudget } from "@/lib/demo-business";
import { getGoogleAdsBudgetReport } from "@/lib/google-ads/serving";
import { parseGoogleAdsRequestParams } from "@/lib/google-ads-request-params";
import {
  googleAdsReadAccountAuthorityFailure,
  resolveGoogleAdsReadAccountAuthority,
} from "@/lib/google-ads/account-authority";

export async function GET(request: NextRequest) {
  const { businessId, accountId, dateRange, customStart, customEnd, debug } =
    parseGoogleAdsRequestParams(request.nextUrl.searchParams);

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoGoogleAdsBudget());
  }

  if (accountId && accountId !== "all") {
    const refusal = googleAdsReadAccountAuthorityFailure(
      await resolveGoogleAdsReadAccountAuthority(businessId, accountId),
    );
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.httpStatus },
      );
    }
  }

  const report = await getGoogleAdsBudgetReport({
    businessId,
    accountId,
    dateRange,
    customStart,
    customEnd,
    debug,
  });

  const payload = {
    data: report.rows,
    rows: report.rows,
    recommendations: report.insights,
    summary: report.summary,
    totalSpend: report.summary?.totalSpend ?? 0,
    accountAvgRoas: report.summary?.accountAvgRoas ?? 0,
    meta: report.meta,
  };
  return NextResponse.json(payload);
}
