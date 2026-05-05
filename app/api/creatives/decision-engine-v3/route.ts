import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  decideCreative,
  resolveAccountDecisionProfile,
} from "@/lib/creative-decision-engine";
import { resolveDataSource } from "./data-source";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const creativeIdsParam = url.searchParams.get("creativeIds");
  const asOf =
    url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);

  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const resolvedBusinessId = access.membership.businessId;

  const { instance: dataSource, label: dataSourceLabel } = resolveDataSource();
  const profile = await resolveAccountDecisionProfile({
    businessId: resolvedBusinessId,
    asOf,
    dataSource,
  });
  const dataHealth = await dataSource.getDataHealth({
    businessId: resolvedBusinessId,
    asOf,
  });
  const inputs = await dataSource.listCreativeInputs({
    businessId: resolvedBusinessId,
    asOf,
    creativeIds: creativeIdsParam
      ? creativeIdsParam.split(",").filter(Boolean)
      : undefined,
  });
  const decisions = inputs.map((input) =>
    decideCreative(input, profile, dataHealth),
  );

  return NextResponse.json({
    businessId: resolvedBusinessId,
    asOf,
    engineVersion: decisions[0]?.engineVersion ?? "unknown",
    dataSource: dataSourceLabel,
    dataHealth,
    decisions,
  });
}
