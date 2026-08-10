import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  createCustomReport,
  listCustomReportsByBusiness,
} from "@/lib/custom-report-store";
import { ensureReportDefinition } from "@/lib/custom-reports";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "business_id_required", message: "businessId is required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const reports = await listCustomReportsByBusiness(businessId);
  // When this list was read. The surface used to date itself from the newest
  // row's `updatedAt`, which is when a human last saved a report definition --
  // a property of the content, not of the read. A list nobody has edited in a
  // month is not a month old.
  return NextResponse.json({ reports, generatedAt: new Date().toISOString() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        businessId?: string;
        name?: string;
        description?: string | null;
        templateId?: string | null;
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
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const report = await createCustomReport({
    businessId: body.businessId,
    name: body.name.trim(),
    description: body.description ?? null,
    templateId: body.templateId ?? null,
    definition: ensureReportDefinition(body.definition as never),
  });

  // Section 9: a report was generated. Business-scoped, awaited, and carrying no
  // report content -- only that one was created.
  await recordProductInstrumentationEvent({
    businessId: body.businessId,
    scope: "business",
    eventName: "report_generated",
    surface: "reports",
    outcome: "ok",
    occurredAt: new Date().toISOString(),
  });

  return NextResponse.json({ report }, { status: 201 });
}
