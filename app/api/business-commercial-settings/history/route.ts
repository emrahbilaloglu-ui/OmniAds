import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getUserById } from "@/lib/account-store";
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

  /**
   * Who made each change.
   *
   * The revision rows already carry the acting user id; resolving it here is
   * what lets the Commercial Truth change log and its "last updated by" line
   * name a person instead of an em dash. A user we cannot read stays null —
   * the surface renders the absence rather than guessing an actor.
   */
  const actorIds = [
    ...new Set(
      history
        .map((entry) => entry.updatedByUserId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  const actorNames = new Map<string, string>();
  await Promise.all(
    actorIds.map(async (userId) => {
      const user = await getUserById(userId).catch(() => null);
      const label = user?.name?.trim() || user?.email?.trim();
      if (label) actorNames.set(userId, label);
    }),
  );

  return NextResponse.json({
    entries: history.map((entry, index) => ({
      id: entry.id,
      at: entry.effectiveAt,
      operation: entry.operation,
      sourceLabel: entry.sourceLabel,
      actor: entry.updatedByUserId ? (actorNames.get(entry.updatedByUserId) ?? null) : null,
      changes: describeChanges(entry, history[index + 1]),
    })),
  });
}
