import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { buildBreakEvenRoasPreview } from "@/lib/commerce-cost/break-even-preview";
import { readBreakEvenPreviewFacts } from "@/lib/commerce-cost/break-even-preview-source";
import { parseCostStructurePayload } from "@/lib/commerce-cost/payload";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validWindow(startDate: unknown, endDate: unknown) {
  if (typeof startDate !== "string" || typeof endDate !== "string") return null;
  if (!DATE.test(startDate) || !DATE.test(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days < 1 || days > 366) return null;
  return { startDate, endDate };
}

/**
 * Calculates a draft-only threshold without saving either the cost structure
 * or the Target Pack. POST is used because the unsaved component structure is
 * the calculation input; the operation itself remains read-only.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: unknown;
    structure?: unknown;
    startDate?: unknown;
    endDate?: unknown;
  } | null;
  const businessId = typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const window = validWindow(body?.startDate, body?.endDate);
  if (!window) {
    return NextResponse.json(
      {
        error: "invalid_window",
        message: "startDate and endDate must define a valid window of at most 366 days.",
      },
      { status: 422 },
    );
  }

  const parsed = parseCostStructurePayload(body?.structure, {
    businessId: access.membership.businessId,
    version: 0,
    recordedAt: new Date().toISOString(),
  });
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "invalid_cost_structure",
        message: "The draft cost structure could not be read.",
        issues: parsed.issues,
      },
      { status: 422 },
    );
  }

  const facts = await readBreakEvenPreviewFacts({
    businessId: access.membership.businessId,
    startDate: window.startDate,
    endDate: window.endDate,
    reportingCurrency: parsed.structure.reportingCurrency,
  });
  const preview = buildBreakEvenRoasPreview({ structure: parsed.structure, facts });

  return NextResponse.json(
    { preview },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
