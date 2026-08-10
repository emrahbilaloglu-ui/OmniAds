import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getCustomReportById } from "@/lib/custom-report-store";
import { getBusinessCurrency } from "@/lib/account-store";
import { renderCustomReport, renderCustomReportRecord } from "@/lib/custom-report-renderer";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> }
) {
  const { reportId } = await params;
  const report = await getCustomReportById(reportId);
  if (!report) {
    return NextResponse.json(
      { error: "not_found", message: "Report not found." },
      { status: 404 }
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId: report.businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");
  const dateRangePreset = request.nextUrl.searchParams.get("dateRangePreset");

  const definition =
    dateRangePreset === "7" || dateRangePreset === "30" || dateRangePreset === "90"
      ? { ...report.definition, dateRangePreset: dateRangePreset as "7" | "30" | "90" }
      : report.definition;

  const rendered = await renderCustomReport({
    request,
    businessId: report.businessId,
    reportId: report.id,
    name: report.name,
    description: report.description,
    definition,
    startDateOverride: startDate ?? undefined,
    endDateOverride: endDate ?? undefined,
    currency: await getBusinessCurrency(report.businessId),
  });
  return NextResponse.json({ report: rendered });
}
