import { NextRequest, NextResponse } from "next/server";
import {
  decideCreative,
  defaultBusinessConfig,
  type DecisionResponse,
} from "@/lib/creative-decision-engine";
import { resolveDataSource } from "./data-source";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
): Promise<NextResponse<DecisionResponse | { error: string }>> {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const creativeIdsParam = url.searchParams.get("creativeIds");
  const asOf = url.searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);

  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }

  const { instance: dataSource, label: dataSourceLabel } = resolveDataSource();
  const config = defaultBusinessConfig(businessId);
  const calibration = await dataSource.getAccountCalibration({ businessId, asOf });
  const dataHealth = await dataSource.getDataHealth({ businessId, asOf });
  const inputs = await dataSource.listCreativeInputs({
    businessId,
    asOf,
    creativeIds: creativeIdsParam
      ? creativeIdsParam.split(",").filter(Boolean)
      : undefined,
  });
  const decisions = inputs.map((input) =>
    decideCreative(input, config, calibration),
  );

  return NextResponse.json({
    businessId,
    asOf,
    engineVersion: decisions[0]?.engineVersion ?? "unknown",
    dataSource: dataSourceLabel,
    dataHealth,
    decisions,
  });
}
