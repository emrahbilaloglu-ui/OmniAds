import { getDbWithTimeout } from "@/lib/db";
import { buildMetaAdDayProviderZeroReceiptSql } from "@/lib/meta/ad-day-provider-zero-receipt";
import { readMetaFunnelStageFromPayload, type MetaFunnelStageId } from "@/lib/meta/funnel-stage-parse";
import { resolveAdDayAuthoritativeLinkClicks } from "@/lib/meta/link-click-parse";
import { resolveAdDayAuthoritativePurchases } from "@/lib/meta/purchase-count-parse";
import { getMetaAdDailyCoverage } from "@/lib/meta/warehouse";

export const META_AD_FUNNEL_EVIDENCE_CONTRACT_VERSION = "meta-ad-funnel-evidence.v1";

export interface MetaAdFunnelEvidenceRow {
  id: string;
  adsetId: string | null;
  adsetName: string | null;
  spend: number | null;
  purchaseValue: number | null;
  roas: number | null;
  impressions: number | null;
  linkClicks: number | null;
  linkClicksObserved: boolean;
  landingPageViews: number | null;
  landingPageViewsObserved: boolean;
  addToCart: number | null;
  addToCartObserved: boolean;
  initiateCheckout: number | null;
  initiateCheckoutObserved: boolean;
  purchases: number | null;
  purchasesObserved: boolean;
  thumbstop: null;
  thumbstopObserved: false;
  launchDate: null;
}

export interface MetaAdFunnelEvidenceDay {
  adId: string;
  adsetId: string | null;
  date: string;
  spend: number;
  revenue: number;
  impressions: number;
  linkClicks: number | null;
  conversions: number;
  payloadJson: unknown;
  providerZeroReceiptVerified: boolean;
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : null;
}

function readFunnelStage(day: MetaAdFunnelEvidenceDay, stage: MetaFunnelStageId): number | null {
  const reading = readMetaFunnelStageFromPayload(day.payloadJson, stage);
  if (reading.state === "measured") return reading.value;
  // Meta omits the entire actions list on zero-action days. D108's exact
  // source receipt proves the list was requested and the complete request
  // published; an absent key without that receipt remains unknown.
  const actionsAbsent = typeof day.payloadJson === "object" &&
    day.payloadJson !== null && !Array.isArray(day.payloadJson) &&
    !Object.hasOwn(day.payloadJson, "actions");
  if (reading.state === "unmeasurable" && actionsAbsent &&
      day.providerZeroReceiptVerified) return 0;
  return null;
}

function completeSum(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

/** A single selected period and exact Ad; no current creative identity join. */
export function aggregateMetaAdFunnelEvidence(
  days: readonly MetaAdFunnelEvidenceDay[],
): MetaAdFunnelEvidenceRow[] {
  const byAdset = new Map<string, MetaAdFunnelEvidenceDay[]>();
  for (const day of days) {
    const key = day.adsetId ?? "";
    const group = byAdset.get(key) ?? [];
    group.push(day);
    byAdset.set(key, group);
  }
  return [...byAdset.entries()].map(([adsetId, group]) => {
    const purchases = completeSum(group.map((day) => resolveAdDayAuthoritativePurchases({
      storedConversions: day.conversions,
      payloadJson: day.payloadJson,
      providerZeroReceiptVerified: day.providerZeroReceiptVerified,
    })));
    const linkClicks = completeSum(group.map((day) => {
      const observed = resolveAdDayAuthoritativeLinkClicks({
        storedLinkClicks: day.linkClicks,
        payloadJson: day.payloadJson,
      });
      if (observed !== null) return observed;
      const actionsAbsent = typeof day.payloadJson === "object" &&
        day.payloadJson !== null && !Array.isArray(day.payloadJson) &&
        !Object.hasOwn(day.payloadJson, "actions");
      return day.linkClicks === 0 && actionsAbsent && day.providerZeroReceiptVerified ? 0 : null;
    }));
    const landingPageViews = completeSum(group.map((day) => readFunnelStage(day, "landing_page_view")));
    const addToCart = completeSum(group.map((day) => readFunnelStage(day, "add_to_cart")));
    const initiateCheckout = completeSum(group.map((day) => readFunnelStage(day, "initiate_checkout")));
    const spend = completeSum(group.map((day) => finiteNonnegative(day.spend)));
    const impressions = completeSum(group.map((day) => finiteNonnegative(day.impressions)));
    // A purchase count without source proof cannot turn a zero revenue scalar
    // into a purchase ROAS claim in this supplemental drawer.
    const purchaseValue = purchases === null ? null
      : completeSum(group.map((day) => finiteNonnegative(day.revenue)));
    return {
      id: group[0]!.adId,
      adsetId: adsetId || null,
      adsetName: null,
      spend,
      purchaseValue,
      roas: spend !== null && spend > 0 && purchaseValue !== null ? purchaseValue / spend : null,
      impressions,
      linkClicks,
      linkClicksObserved: linkClicks !== null,
      landingPageViews,
      landingPageViewsObserved: landingPageViews !== null,
      addToCart,
      addToCartObserved: addToCart !== null,
      initiateCheckout,
      initiateCheckoutObserved: initiateCheckout !== null,
      purchases,
      purchasesObserved: purchases !== null,
      thumbstop: null,
      thumbstopObserved: false,
      launchDate: null,
    };
  });
}

export async function readMetaAdFunnelEvidenceWindow(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  start: string;
  end: string;
}): Promise<{ rows: MetaAdFunnelEvidenceRow[]; coverageComplete: boolean }> {
  const requestedDays = Math.floor((Date.parse(`${input.end}T00:00:00Z`) -
    Date.parse(`${input.start}T00:00:00Z`)) / 86_400_000) + 1;
  const coverage = await getMetaAdDailyCoverage({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: input.start,
    endDate: input.end,
    timeoutMs: 2_500,
  });
  if (coverage.completed_days < requestedDays) {
    return { rows: [], coverageComplete: false };
  }
  const receiptSql = buildMetaAdDayProviderZeroReceiptSql({
    qualifier: "d", cutoffSql: "$6::timestamptz",
  });
  const rows = await getDbWithTimeout(25_000).query<{
    ad_id: string;
    adset_id: string | null;
    date: string;
    spend: number | string;
    revenue: number | string;
    impressions: number | string;
    link_clicks: number | string | null;
    conversions: number | string;
    payload_json: unknown;
    provider_zero_receipt_verified: boolean;
  }>(`SELECT d.ad_id, d.adset_id, d.date, d.spend, d.revenue,
      d.impressions, d.link_clicks, d.conversions, d.payload_json,
      ${receiptSql} AS provider_zero_receipt_verified
    FROM meta_ad_daily d
    WHERE d.business_id = $1 AND d.provider_account_id = $2 AND d.ad_id = $3
      AND d.date BETWEEN $4::date AND $5::date
    ORDER BY d.date ASC`, [
    input.businessId, input.providerAccountId, input.adId, input.start,
    input.end, new Date().toISOString(),
  ]);
  return {
    coverageComplete: true,
    rows: aggregateMetaAdFunnelEvidence(rows.map((row) => ({
      adId: row.ad_id,
      adsetId: row.adset_id,
      date: String(row.date).slice(0, 10),
      spend: Number(row.spend),
      revenue: Number(row.revenue),
      impressions: Number(row.impressions),
      linkClicks: row.link_clicks === null ? null : Number(row.link_clicks),
      conversions: Number(row.conversions),
      payloadJson: row.payload_json,
      providerZeroReceiptVerified: row.provider_zero_receipt_verified === true,
    }))),
  };
}
