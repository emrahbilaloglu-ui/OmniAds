import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { listUserBusinesses, requireBusinessAccess } from "@/lib/access";
import { renderCustomReportRecord } from "@/lib/custom-report-renderer";
import {
  createCustomReportShareSnapshot,
  getCustomReportById,
} from "@/lib/custom-report-store";
import {
  REPORT_SHARE_DISABLED_RESPONSE,
  REPORT_SHARE_DISABLED_STATUS,
  isReportShareFailClosed,
} from "@/lib/reports/share-fail-closed";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reportId: string }> }
) {
  // Fail closed before anything is read or written: no report lookup, no
  // render, no snapshot. Every caller gets the same body, so a refusal cannot
  // be used to probe which report IDs exist.
  if (isReportShareFailClosed()) {
    return NextResponse.json(REPORT_SHARE_DISABLED_RESPONSE, {
      status: REPORT_SHARE_DISABLED_STATUS,
    });
  }

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
  const business = (await listUserBusinesses(access.session.user.id)).find(
    (item) => item.id === report.businessId,
  );

  const body = (await request.json().catch(() => null)) as {
    expiryDays?: number;
    startDate?: string;
    endDate?: string;
  } | null;
  const expiryDays = body?.expiryDays === 1 || body?.expiryDays === 30 ? body.expiryDays : 7;

  // Share the period the operator actually reviewed. Without these, the snapshot
  // re-renders the report's stored trailing preset, so the client can receive a
  // different window from the one that was approved on screen.
  const isIsoDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const viewStart = isIsoDate(body?.startDate) ? body.startDate : undefined;
  const viewEnd = isIsoDate(body?.endDate) ? body.endDate : undefined;

  const rendered = await renderCustomReportRecord(request, report, {
    startDateOverride: viewStart && viewEnd ? viewStart : undefined,
    endDateOverride: viewStart && viewEnd ? viewEnd : undefined,
    currency: business?.currency ?? null,
  });
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = await createCustomReportShareSnapshot(report.id, {
    ...rendered,
    expiresAt,
    businessName: business?.name ?? null,
    currency: business?.currency ?? null,
    clientEmail: null,
  });

  // Section 9: a share snapshot was created. No report content recorded.

  await recordProductInstrumentationEvent({

    businessId: report.businessId,

    scope: "business",

    eventName: "report_share_created",

    surface: "reports",

    outcome: "ok",

    occurredAt: new Date().toISOString(),

  });


  return NextResponse.json({
    token: snapshot.token,
    url: `/share/report/${snapshot.token}`,
    expiresAt: snapshot.expiresAt,
  });
}
