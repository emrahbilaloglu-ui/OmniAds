import { NextRequest, NextResponse } from "next/server";
import { listUserBusinesses, requireBusinessAccess } from "@/lib/access";
import { renderCustomReportRecord } from "@/lib/custom-report-renderer";
import {
  createCustomReportShareSnapshot,
  getCustomReportById,
} from "@/lib/custom-report-store";

export async function POST(
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
  const business = (await listUserBusinesses(access.session.user.id)).find(
    (item) => item.id === report.businessId,
  );

  const body = (await request.json().catch(() => null)) as { expiryDays?: number } | null;
  const expiryDays = body?.expiryDays === 1 || body?.expiryDays === 30 ? body.expiryDays : 7;
  const rendered = await renderCustomReportRecord(request, report);
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = await createCustomReportShareSnapshot(report.id, {
    ...rendered,
    expiresAt,
    businessName: business?.name ?? null,
    currency: business?.currency ?? null,
    clientEmail: null,
  });

  return NextResponse.json({
    token: snapshot.token,
    url: `/share/report/${snapshot.token}`,
    expiresAt: snapshot.expiresAt,
  });
}
