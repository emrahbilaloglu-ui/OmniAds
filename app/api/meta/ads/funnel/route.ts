import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import {
  META_AD_FUNNEL_EVIDENCE_CONTRACT_VERSION,
  readMetaAdFunnelEvidenceWindow,
} from "@/lib/meta/ad-funnel-evidence";

export const dynamic = "force-dynamic";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Supplemental exact-Ad facts for the Meta Decisions drawer. Never an action input. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId")?.trim() ?? "";
  const providerAccountId = params.get("providerAccountId")?.trim() ?? "";
  const adId = params.get("adId")?.trim() ?? "";
  const start = params.get("start")?.trim() ?? "";
  const end = params.get("end")?.trim() ?? "";
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days = Math.floor((endMs - startMs) / 86_400_000) + 1;
  const validDay = (value: string, time: number) => ISO_DAY.test(value) &&
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  if (!businessId || !providerAccountId || !adId ||
      !validDay(start, startMs) || !validDay(end, endMs) ||
      !Number.isFinite(days) || days < 1 || days > 90) {
    return NextResponse.json({ error: "invalid_meta_ad_funnel_scope" }, { status: 400 });
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;
  const assignedAccounts = await fetchAssignedAccountIds(businessId);
  if (!assignedAccounts.includes(providerAccountId)) {
    return NextResponse.json({ error: "account_not_assigned" }, { status: 403 });
  }
  const evidence = await readMetaAdFunnelEvidenceWindow({
    businessId, providerAccountId, adId, start, end,
  });
  if (!evidence.coverageComplete) {
    return NextResponse.json({ error: "incomplete_ad_day_coverage" }, { status: 409 });
  }
  return NextResponse.json({
    status: "ok",
    contractVersion: META_AD_FUNNEL_EVIDENCE_CONTRACT_VERSION,
    ...evidence,
  });
}
