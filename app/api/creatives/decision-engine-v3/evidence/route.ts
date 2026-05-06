import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  decideCreative,
  resolveAccountDecisionProfile,
} from "@/lib/creative-decision-engine";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveDataSource } from "../data-source";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const creativeId = url.searchParams.get("creativeId");
  const campaignId = url.searchParams.get("campaignId")?.trim() || undefined;
  const asOf =
    url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);

  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }
  if (!creativeId) {
    return NextResponse.json({ error: "creativeId required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const resolvedBusinessId = access.membership.businessId;
  const flags = await resolveEngineV3Flags(resolvedBusinessId);
  if (!flags.enabled) {
    return NextResponse.json(
      {
        status: "disabled",
        reason: "engine_v3_disabled_for_business",
        flags: { ...flags },
      },
      { status: 200 },
    );
  }

  const { instance: dataSource } = resolveDataSource();
  const profile = await resolveAccountDecisionProfile({
    businessId: resolvedBusinessId,
    asOf,
    dataSource,
    flags,
    campaignId,
  });
  const dataHealth = await dataSource.getDataHealth({
    businessId: resolvedBusinessId,
    asOf,
  });
  const inputs = await dataSource.listCreativeInputs({
    businessId: resolvedBusinessId,
    asOf,
    creativeIds: [creativeId],
  });
  const input = inputs.find((candidate) => candidate.creativeId === creativeId);
  if (!input) {
    return NextResponse.json(
      { error: "creative input not found" },
      { status: 404 },
    );
  }

  const decision = decideCreative(input, profile, dataHealth);
  const [funnelDiagnosis, operatorResponse] = await Promise.all([
    dataSource.getLatestFunnelDiagnosis({
      businessId: resolvedBusinessId,
      creativeId,
      asOf,
    }),
    dataSource.getLatestOperatorResponse({
      businessId: resolvedBusinessId,
      creativeId,
      asOf,
    }),
  ]);

  return NextResponse.json({
    businessId: resolvedBusinessId,
    creativeId,
    asOf,
    engineVersion: decision.engineVersion,
    flags,
    dataHealth,
    scope: profile.scope,
    accountProfile: profile,
    decision,
    input,
    funnelDiagnosis,
    operatorResponse,
  });
}
