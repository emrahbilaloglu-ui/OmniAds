import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import type { MetaWarehouseFreshness } from "@/lib/meta/warehouse-types";

export const dynamic = "force-dynamic";

type BreakdownType = "age" | "country" | "placement" | "adset" | "campaign";

interface MetaActionValue {
  action_type: string;
  value: string;
}

interface BreakdownInsightRow {
  age?: string;
  country?: string;
  publisher_platform?: string;
  platform_position?: string;
  impression_device?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  clicks?: string;
  impressions?: string;
  cpm?: string;
  ctr?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface AggregatedBreakdownRow {
  key: string;
  label: string;
  spend: number;
  purchases: number;
  revenue: number;
  clicks: number;
  impressions: number;
  /**
   * `null` means no measured reach for this bucket, which is a different
   * fact from a reach of zero. Every breakdown row written before the field
   * was requested from Meta carries a stored literal 0 that was never a
   * measurement; it is not a divisor, so frequency stays null there.
   */
  reach?: number | null;
  frequency?: number | null;
}

export interface MetaBreakdownsResponse {
  status?:
    | "ok"
    | "no_access_token"
    | "no_connection"
    | "no_accounts_assigned"
    /**
     * A `providerAccountId` was asked for that this workspace is not assigned.
     * Refused rather than widened: silently answering with every assigned
     * account would attribute pooled spend to the one account the operator
     * picked, which is a fabricated number wearing a real account's name.
     */
    | "account_not_assigned";
  age: AggregatedBreakdownRow[];
  /**
   * The second dimension of the same `age,gender` fetch. Empty for any day
   * whose rows were written before the fold was removed at the write path —
   * those days hold no gender split at all and must stay withheld rather
   * than be inferred from the age blend they were merged into.
   */
  gender: AggregatedBreakdownRow[];
  location: AggregatedBreakdownRow[];
  placement: AggregatedBreakdownRow[];
  budget: {
    campaign: Array<{ key: string; label: string; spend: number }>;
    adset: Array<{ key: string; label: string; spend: number }>;
  };
  audience: {
    available: boolean;
    reason?: string;
  };
  products: {
    available: boolean;
    reason?: string;
  };
  isPartial?: boolean;
  notReadyReason?: string | null;
  /**
   * When the warehouse was last observed for these rows.
   *
   * Served so a reader can bind an as-of to a measured instant instead of
   * inventing one from its own clock; `null` (or a null `lastSyncedAt`) is a
   * real answer meaning "age unknown".
   */
  freshness?: MetaWarehouseFreshness | null;
}

function parseAction(arr: MetaActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? parseFloat(found.value) || 0 : 0;
}

function parseNum(input: string | undefined): number {
  return input ? parseFloat(input) || 0 : 0;
}

function breakdownParam(type: BreakdownType): { level: "ad" | "adset" | "campaign"; breakdowns?: string } {
  if (type === "age") return { level: "adset", breakdowns: "age" };
  if (type === "country") return { level: "adset", breakdowns: "country" };
  if (type === "placement") return { level: "adset", breakdowns: "publisher_platform,platform_position,impression_device" };
  if (type === "adset") return { level: "adset" };
  return { level: "campaign" };
}

async function fetchBreakdownInsights(input: {
  accountId: string;
  accessToken: string;
  since: string;
  until: string;
  type: BreakdownType;
}): Promise<BreakdownInsightRow[]> {
  const { accountId, accessToken, since, until, type } = input;
  const cfg = breakdownParam(type);
  const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
  url.searchParams.set("level", cfg.level);
  if (cfg.breakdowns) url.searchParams.set("breakdowns", cfg.breakdowns);
  url.searchParams.set(
    "fields",
    [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      "spend",
      "clicks",
      "impressions",
      "ctr",
      "cpm",
      "actions",
      "action_values",
      "purchase_roas",
    ].join(",")
  );
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: BreakdownInsightRow[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

function aggregateRows(rows: BreakdownInsightRow[], type: BreakdownType): AggregatedBreakdownRow[] {
  const map = new Map<string, AggregatedBreakdownRow>();
  for (const row of rows) {
    let key = "unknown";
    let label = "Unknown";
    if (type === "age") {
      key = row.age ?? "unknown";
      label = row.age ?? "Unknown";
    } else if (type === "country") {
      key = row.country ?? "unknown";
      label = row.country ?? "Unknown";
    } else if (type === "placement") {
      const p = row.publisher_platform ?? "unknown";
      const pos = row.platform_position ?? "unknown";
      const device = row.impression_device ?? "unknown";
      key = `${p}|${pos}|${device}`;
      label = [p, pos, device].filter(Boolean).join(" • ");
    } else if (type === "adset") {
      key = row.adset_id ?? row.adset_name ?? "unknown";
      label = row.adset_name ?? "Unknown ad set";
    } else if (type === "campaign") {
      key = row.campaign_id ?? row.campaign_name ?? "unknown";
      label = row.campaign_name ?? "Unknown campaign";
    }

    const spend = parseNum(row.spend);
    const purchases = parseAction(row.actions, "purchase");
    const revenueFromValues = parseAction(row.action_values, "purchase");
    const purchaseRoas = parseAction(row.purchase_roas, "omni_purchase");
    const revenue = revenueFromValues > 0 ? revenueFromValues : spend * purchaseRoas;
    const clicks = parseNum(row.clicks);
    const impressions = parseNum(row.impressions);

    const existing = map.get(key);
    if (existing) {
      existing.spend += spend;
      existing.purchases += purchases;
      existing.revenue += revenue;
      existing.clicks += clicks;
      existing.impressions += impressions;
    } else {
      map.set(key, {
        key,
        label,
        spend,
        purchases,
        revenue,
        clicks,
        impressions,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.spend - a.spend);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  // Read, never trust: the id narrows the read only after the source has
  // intersected it with this workspace's assignments. Omitting it keeps the
  // long-standing account-wide answer for the callers that want one.
  const providerAccountId = searchParams.get("providerAccountId");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const payload = await getMetaBreakdownsForRange({
    businessId: businessId!,
    providerAccountId,
    startDate,
    endDate,
  });
  return NextResponse.json(payload satisfies MetaBreakdownsResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
