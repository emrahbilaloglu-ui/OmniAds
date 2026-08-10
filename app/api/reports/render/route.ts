import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { ensureReportDefinition } from "@/lib/custom-reports";
import { getBusinessCurrency } from "@/lib/account-store";
import { renderCustomReport } from "@/lib/custom-report-renderer";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        businessId?: string;
        retryOfFailedRender?: boolean;
        name?: string;
        description?: string | null;
        definition?: unknown;
      }
    | null;

  if (!body?.businessId || !body?.name) {
    return NextResponse.json(
      { error: "invalid_payload", message: "businessId and name are required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId: body.businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const report = await renderCustomReport({
    request,
    businessId: body.businessId,
    name: body.name,
    description: body.description ?? null,
    definition: ensureReportDefinition(body.definition as never),
    currency: await getBusinessCurrency(body.businessId),
  });
  // Section 9: widget failures, counted from what the render actually produced
  // rather than from a client guess. The error text is never recorded -- only
  // that widgets failed and how many, which is what the recovery-rate metric
  // needs.
  const failedWidgets = (report.widgets ?? []).filter(
    (widget: { errorMessage?: string | null }) => Boolean(widget.errorMessage),
  ).length;
  if (failedWidgets > 0) {
    await recordProductInstrumentationEvent({
      businessId: body.businessId,
      scope: "business",
      eventName: "report_widget_failed",
      surface: "reports",
      outcome: "failed",
      failureCode: "upstream_unavailable",
      itemCount: failedWidgets,
      occurredAt: new Date().toISOString(),
    });
  }

  // A re-render of a report that previously failed is the retry. The client
  // sends the marker; it carries no content, only the fact.
  if (body.retryOfFailedRender === true) {
    await recordProductInstrumentationEvent({
      businessId: body.businessId,
      scope: "business",
      eventName: "report_widget_retried",
      surface: "reports",
      outcome: failedWidgets > 0 ? "failed" : "ok",
      failureCode: failedWidgets > 0 ? "upstream_unavailable" : null,
      itemCount: failedWidgets,
      occurredAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({ report });
}
