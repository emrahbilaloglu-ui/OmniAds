import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { ensureReportDefinition } from "@/lib/custom-reports";
import { getBusinessCurrency } from "@/lib/account-store";
import { renderCustomReport } from "@/lib/custom-report-renderer";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        businessId?: string;
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
  return NextResponse.json({ report });
}
