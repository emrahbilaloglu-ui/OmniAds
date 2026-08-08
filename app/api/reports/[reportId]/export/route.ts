import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getBusinessCurrency } from "@/lib/account-store";
import { renderCustomReport, renderWidgetCsv } from "@/lib/custom-report-renderer";
import { getCustomReportById } from "@/lib/custom-report-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> }
) {
  const { reportId } = await params;
  const widgetId = request.nextUrl.searchParams.get("widgetId");
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
  const widget =
    rendered.widgets.find((item) => item.id === widgetId) ??
    rendered.widgets.find((item) => item.type === "table");

  if (!widget || widget.type !== "table" || !widget.rows?.length) {
    return NextResponse.json(
      {
        error: "table_widget_required",
        message: "This report does not have an exportable table widget.",
      },
      { status: 400 }
    );
  }

  const csv = renderWidgetCsv(widget);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"${report.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-${widget.id}.csv\"`,
    },
  });
}
