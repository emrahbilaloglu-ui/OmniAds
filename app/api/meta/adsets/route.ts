import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";

// ── Route ─────────────────────────────────────────────────────────────────────

export interface MetaAdSetsResponse {
  status?:
    | "ok"
    | "no_accounts_assigned"
    | "account_not_assigned"
    | "not_connected";
  rows: Awaited<ReturnType<typeof getMetaAdSetsForRange>>["rows"];
  isPartial?: boolean;
  notReadyReason?: string | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const campaignId = searchParams.get("campaignId");
  const providerAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const includePrev = searchParams.get("includePrev") === "1";

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const payload = await getMetaAdSetsForRange({
    businessId: businessId!,
    ...(providerAccountId ? { accountId: providerAccountId } : {}),
    campaignId,
    startDate,
    endDate,
    includePrev,
  });
  return NextResponse.json(payload satisfies MetaAdSetsResponse);
}
