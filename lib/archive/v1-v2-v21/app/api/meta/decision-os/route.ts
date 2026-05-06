import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type {
  CreativeDecisionBenchmarkScopeInput,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import { isCreativeDecisionOsV1EnabledForBusiness } from "@/lib/creative-decision-os-config";
import { attachCreativeLinkage } from "@/lib/meta/decision-os-linkage";
import type { MetaDecisionOsV1Response } from "@/lib/meta/decision-os";
import { isMetaDecisionOsV1EnabledForBusiness } from "@/lib/meta/decision-os-config";
import { getMetaDecisionOsForRange } from "@/lib/meta/decision-os-source";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function parseCreativeBenchmarkScope(
  request: NextRequest,
): CreativeDecisionBenchmarkScopeInput | null {
  const scope = request.nextUrl.searchParams.get("benchmarkScope");
  if (scope !== "account" && scope !== "campaign") return null;

  const scopeId = request.nextUrl.searchParams.get("benchmarkScopeId");
  const scopeLabel = request.nextUrl.searchParams.get("benchmarkScopeLabel");

  return {
    scope,
    ...(scopeId?.trim() ? { scopeId: scopeId.trim() } : {}),
    ...(scopeLabel?.trim() ? { scopeLabel: scopeLabel.trim() } : {}),
  };
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (!isMetaDecisionOsV1EnabledForBusiness(businessId)) {
    return NextResponse.json(
      {
        error: "meta_decision_os_disabled",
        message: "Meta Decision OS is feature-gated for this workspace.",
      },
      { status: 404 },
    );
  }

  const analyticsStartDateParam = request.nextUrl.searchParams.get("analyticsStartDate");
  const analyticsEndDateParam = request.nextUrl.searchParams.get("analyticsEndDate");
  const startDate =
    request.nextUrl.searchParams.get("startDate") ??
    analyticsStartDateParam ??
    toISODate(daysAgo(29));
  const endDate =
    request.nextUrl.searchParams.get("endDate") ??
    analyticsEndDateParam ??
    toISODate(new Date());
  const analyticsStartDate = analyticsStartDateParam ?? startDate;
  const analyticsEndDate = analyticsEndDateParam ?? endDate;
  const decisionAsOf = request.nextUrl.searchParams.get("decisionAsOf");
  const benchmarkScope = parseCreativeBenchmarkScope(request);
  const payload = await getMetaDecisionOsForRange({
    businessId,
    startDate,
    endDate,
    analyticsStartDate,
    analyticsEndDate,
    decisionAsOf,
  });

  if (!isCreativeDecisionOsV1EnabledForBusiness(businessId)) {
    return NextResponse.json(payload satisfies MetaDecisionOsV1Response, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const creativePayload = await getCreativeDecisionOsForRange({
      request,
      businessId,
      startDate,
      endDate,
      analyticsStartDate,
      analyticsEndDate,
      decisionAsOf,
      benchmarkScope,
    });
    const linkedPayload = attachCreativeLinkage(
      payload,
      creativePayload satisfies CreativeDecisionOsV1Response,
    );

    return NextResponse.json(linkedPayload satisfies MetaDecisionOsV1Response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Linkage is additive only; fall back to the base Meta payload when Creative OS is unavailable.
  }

  return NextResponse.json(payload satisfies MetaDecisionOsV1Response, {
    headers: { "Cache-Control": "no-store" },
  });
}
