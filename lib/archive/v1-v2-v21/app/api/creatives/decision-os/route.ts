import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  isCreativeDecisionCenterV21EnabledForBusiness,
  isCreativeDecisionCenterV21LiveRowsEnabledForBusiness,
  isCreativeDecisionOsV1EnabledForBusiness,
} from "@/lib/creative-decision-os-config";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import type { CreativeDecisionBenchmarkScopeInput } from "@/lib/creative-decision-os";
import {
  buildCreativeDecisionOsSnapshotResponse,
  type CreativeDecisionOsSnapshot,
  getLatestCreativeDecisionOsSnapshot,
  resolveCreativeDecisionOsSnapshotScope,
  saveCreativeDecisionOsSnapshot,
} from "@/lib/creative-decision-os-snapshots";
import { buildValidatedCreativeDecisionCenterV21Snapshot } from "@/lib/creative-decision-center/snapshot-builder";

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readBody(request: NextRequest) {
  try {
    return bodyRecord(await request.json());
  } catch {
    return {};
  }
}

function parseBenchmarkScopeFromParts(input: {
  searchParams: URLSearchParams;
  body?: Record<string, unknown>;
}): CreativeDecisionBenchmarkScopeInput | null {
  const bodyBenchmark = bodyRecord(input.body?.benchmarkScope);
  const scope =
    normalizeString(bodyBenchmark.scope) ??
    normalizeString(input.body?.benchmarkScope) ??
    input.searchParams.get("benchmarkScope");
  if (scope !== "account" && scope !== "campaign") return null;

  const scopeId =
    normalizeString(bodyBenchmark.scopeId) ??
    normalizeString(input.body?.benchmarkScopeId) ??
    normalizeString(input.searchParams.get("benchmarkScopeId"));
  const scopeLabel =
    normalizeString(bodyBenchmark.scopeLabel) ??
    normalizeString(input.body?.benchmarkScopeLabel) ??
    normalizeString(input.searchParams.get("benchmarkScopeLabel"));

  return {
    scope,
    ...(scopeId ? { scopeId } : {}),
    ...(scopeLabel ? { scopeLabel } : {}),
  };
}

function readDateParam(input: {
  searchParams: URLSearchParams;
  body: Record<string, unknown>;
  key: string;
  fallback?: string | null;
}) {
  return (
    normalizeString(input.body[input.key]) ??
    normalizeString(input.searchParams.get(input.key)) ??
    input.fallback ??
    null
  );
}

async function authorize(request: NextRequest, businessId: string | null) {
  if (!businessId) {
    return {
      error: NextResponse.json(
        {
          error: "missing_business_id",
          message: "businessId query parameter is required.",
        },
        { status: 400 },
      ),
    };
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return { error: access.error };

  if (!isCreativeDecisionOsV1EnabledForBusiness(businessId)) {
    return {
      error: NextResponse.json(
        {
          error: "creative_decision_os_disabled",
          message: "Creative Decision OS is feature-gated for this workspace.",
        },
        { status: 404 },
      ),
    };
  }

  return { access, businessId };
}

function maybeBuildDecisionCenter(input: {
  businessId: string;
  snapshot: CreativeDecisionOsSnapshot | null;
}) {
  if (!isCreativeDecisionCenterV21EnabledForBusiness(input.businessId)) {
    return null;
  }
  return buildValidatedCreativeDecisionCenterV21Snapshot({
    snapshot: input.snapshot,
    enableRows: isCreativeDecisionCenterV21LiveRowsEnabledForBusiness(input.businessId),
  });
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const authorized = await authorize(request, businessId);
  if ("error" in authorized) return authorized.error;

  const benchmarkScope = parseBenchmarkScopeFromParts({
    searchParams: request.nextUrl.searchParams,
  });
  const scope = resolveCreativeDecisionOsSnapshotScope(benchmarkScope);
  const snapshot = await getLatestCreativeDecisionOsSnapshot({
    businessId: authorized.businessId,
    benchmarkScope,
  });

  return NextResponse.json(
    buildCreativeDecisionOsSnapshotResponse({
      scope,
      snapshot,
      status: snapshot ? snapshot.status : "not_run",
      decisionCenter: maybeBuildDecisionCenter({
        businessId: authorized.businessId,
        snapshot,
      }),
    }),
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const body = await readBody(request);
  const businessId =
    normalizeString(body.businessId) ?? request.nextUrl.searchParams.get("businessId");
  const authorized = await authorize(request, businessId);
  if ("error" in authorized) return authorized.error;

  const searchParams = request.nextUrl.searchParams;
  const analyticsStartDateParam = readDateParam({
    searchParams,
    body,
    key: "analyticsStartDate",
  });
  const analyticsEndDateParam = readDateParam({
    searchParams,
    body,
    key: "analyticsEndDate",
  });
  const startDate = readDateParam({
    searchParams,
    body,
    key: "startDate",
    fallback: analyticsStartDateParam ?? toISODate(daysAgo(29)),
  });
  const endDate = readDateParam({
    searchParams,
    body,
    key: "endDate",
    fallback: analyticsEndDateParam ?? toISODate(new Date()),
  });
  const analyticsStartDate = analyticsStartDateParam ?? startDate;
  const analyticsEndDate = analyticsEndDateParam ?? endDate;
  const decisionAsOf = readDateParam({
    searchParams,
    body,
    key: "decisionAsOf",
  });
  const benchmarkScope = parseBenchmarkScopeFromParts({
    searchParams,
    body,
  });
  const scope = resolveCreativeDecisionOsSnapshotScope(benchmarkScope);

  try {
    const payload = await getCreativeDecisionOsForRange({
      request,
      businessId: authorized.businessId,
      startDate: startDate ?? toISODate(daysAgo(29)),
      endDate: endDate ?? toISODate(new Date()),
      analyticsStartDate: analyticsStartDate ?? startDate ?? toISODate(daysAgo(29)),
      analyticsEndDate: analyticsEndDate ?? endDate ?? toISODate(new Date()),
      decisionAsOf,
      benchmarkScope,
    });

    const snapshot = await saveCreativeDecisionOsSnapshot({
      businessId: authorized.businessId,
      benchmarkScope,
      payload,
      generatedBy: authorized.access.session.user?.id ?? null,
      analyticsStartDate,
      analyticsEndDate,
      reportingStartDate: startDate,
      reportingEndDate: endDate,
    });

    return NextResponse.json(
      buildCreativeDecisionOsSnapshotResponse({
        scope,
        snapshot,
        status: "ready",
        decisionCenter: maybeBuildDecisionCenter({
          businessId: authorized.businessId,
          snapshot,
        }),
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creative Decision OS analysis failed.";
    return NextResponse.json(
      {
        ...buildCreativeDecisionOsSnapshotResponse({
          scope,
          status: "error",
          error: {
            code: "creative_decision_os_analysis_failed",
            message,
          },
        }),
        message,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
