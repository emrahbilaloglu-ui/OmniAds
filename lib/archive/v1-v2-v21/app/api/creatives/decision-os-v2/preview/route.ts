import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isCreativeDecisionOsV1EnabledForBusiness } from "@/lib/creative-decision-os-config";
import type { CreativeDecisionBenchmarkScopeInput } from "@/lib/creative-decision-os";
import {
  getLatestCreativeDecisionOsSnapshot,
  resolveCreativeDecisionOsSnapshotScope,
} from "@/lib/creative-decision-os-snapshots";
import {
  CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
  buildCreativeDecisionOsV2PreviewPayloadFromDecisionOs,
  isCreativeDecisionOsV2PreviewEnabledForSearchParams,
  type CreativeDecisionOsV2PreviewApiResponse,
} from "@/lib/creative-decision-os-v2-preview";

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBenchmarkScope(
  searchParams: URLSearchParams,
): CreativeDecisionBenchmarkScopeInput | null {
  const scope = searchParams.get("benchmarkScope");
  if (scope !== "account" && scope !== "campaign") return null;

  const scopeId = normalizeString(searchParams.get("benchmarkScopeId"));
  const scopeLabel = normalizeString(searchParams.get("benchmarkScopeLabel"));
  return {
    scope,
    ...(scopeId ? { scopeId } : {}),
    ...(scopeLabel ? { scopeLabel } : {}),
  };
}

function responsePayload(
  input: Omit<CreativeDecisionOsV2PreviewApiResponse, "contractVersion" | "generatedAt">,
) {
  return {
    contractVersion: CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    ...input,
  } satisfies CreativeDecisionOsV2PreviewApiResponse;
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

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const authorized = await authorize(request, businessId);
  if ("error" in authorized) return authorized.error;

  const benchmarkScope = parseBenchmarkScope(request.nextUrl.searchParams);
  const scope = resolveCreativeDecisionOsSnapshotScope(benchmarkScope);
  const enabled = isCreativeDecisionOsV2PreviewEnabledForSearchParams(request.nextUrl.searchParams);

  if (!enabled) {
    return NextResponse.json(
      responsePayload({
        enabled: false,
        status: "not_run",
        scope,
        decisionOsV2Preview: null,
        error: null,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const snapshot = await getLatestCreativeDecisionOsSnapshot({
    businessId: authorized.businessId,
    benchmarkScope,
  });
  const decisionOs = snapshot?.payload ?? null;

  return NextResponse.json(
    responsePayload({
      enabled: true,
      status: snapshot ? snapshot.status : "not_run",
      scope,
      decisionOsV2Preview: decisionOs
        ? buildCreativeDecisionOsV2PreviewPayloadFromDecisionOs(decisionOs)
        : null,
      error: snapshot?.error ?? null,
    }),
    { headers: { "Cache-Control": "no-store" } },
  );
}
