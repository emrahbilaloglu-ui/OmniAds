import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import {
  listBusinessTargetPackHistory,
  type BusinessTargetPackHistoryEntry,
} from "@/lib/business-commercial";

const FIELD_LABELS: Array<[keyof NonNullable<BusinessTargetPackHistoryEntry["targetPack"]>, string]> = [
  ["targetRoas", "Target ROAS"],
  ["targetCpa", "Target CPA"],
  ["breakEvenRoas", "Break-even ROAS"],
  ["breakEvenCpa", "Break-even CPA"],
  ["contributionMarginAssumption", "Contribution margin"],
  ["aovAssumption", "AOV assumption"],
  ["defaultRiskPosture", "Risk posture"],
];

function describeChanges(
  current: BusinessTargetPackHistoryEntry,
  older: BusinessTargetPackHistoryEntry | undefined,
) {
  if (current.operation === "delete") return ["Target pack deleted"];
  if (!current.targetPack || !older?.targetPack) return ["Target pack created"];

  const changes = FIELD_LABELS.filter(
    ([field]) => current.targetPack?.[field] !== older.targetPack?.[field],
  ).map(([, label]) => `${label} updated`);
  return changes.length > 0 ? changes : ["Target pack reconfirmed"];
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId query parameter is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const history = await listBusinessTargetPackHistory({ businessId, limit: 20 });
  return NextResponse.json({
    entries: history.map((entry, index) => ({
      id: entry.id,
      at: entry.effectiveAt,
      operation: entry.operation,
      sourceLabel: entry.sourceLabel,
      actor: null,
      changes: describeChanges(entry, history[index + 1]),
    })),
  });
}
