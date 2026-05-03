import { NextRequest, NextResponse } from "next/server";
import { getIntegration } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { CreativeFormat, CreativePreviewState, normalizeCreativePreview } from "@/lib/meta-creative-preview";
import { requireBusinessAccess } from "@/lib/access";
import { logRuntimeDebug } from "@/lib/runtime-logging";

// ── Meta API types ────────────────────────────────────────────────────────────

interface MetaActionValue {
  action_type: string;
  value: string;
}

interface MetaAdInsightRecord {
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  ctr?: string;
  actions?: MetaActionValue[];
  action_values?: MetaActionValue[];
  purchase_roas?: MetaActionValue[];
}

interface MetaAdRecord {
  id: string;
  promoted_object?: {
    product_set_id?: string | null;
    catalog_id?: string | null;
  } | null;
  creative?: {
    id?: string;
    effective_object_story_id?: string | null;
    thumbnail_url?: string | null;
    image_url?: string | null;
    // "DYNAMIC" = DPA / catalog ad; "PHOTO" | "VIDEO" | "SHARE" = standard
    object_type?: string | null;
    object_story_spec?: {
      link_data?: {
        picture?: string | null;
        image_hash?: string | null;
        child_attachments?: Array<{ picture?: string | null; image_url?: string | null }> | null;
      } | null;
      video_data?: { image_url?: string | null; thumbnail_url?: string | null } | null;
      photo_data?: { image_url?: string | null } | null;
      template_data?: Record<string, unknown> | null;
    } | null;
    asset_feed_spec?: {
      catalog_id?: string | null;
      product_set_id?: string | null;
      images?: Array<{
        url?: string | null;
        image_url?: string | null;
        original_url?: string | null;
        hash?: string | null;
        image_hash?: string | null;
      }> | null;
      videos?: Array<{ thumbnail_url?: string | null; image_url?: string | null }> | null;
    } | null;
  } | null;
}

// ── Public response shape ─────────────────────────────────────────────────────

export interface MetaCreativeRow {
  creative_id: string;
  name: string;
  /** Best available static preview URL (image_url → thumbnail_url → null). Null for catalog ads. */
  preview_url: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  /**
   * true when creative.object_type === "DYNAMIC" (DPA / catalog ad).
   * These ads dynamically render products from a catalog and have no
   * meaningful static preview.
   */
  is_catalog: boolean;
  /**
   * Normalized preview state:
   *   "catalog"     — is_catalog=true (DPA/dynamic product ad)
   *   "preview"     — static image/thumbnail available
   *   "unavailable" — no preview URL and not a catalog ad
   */
  preview_state: CreativePreviewState;
  /** "video" | "image" | "catalog" — derived from creative structure */
  format: CreativeFormat;
  spend: number;
  revenue: number;
  roas: number;
  ctr: number;
  purchases: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAction(arr: MetaActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? parseFloat(found.value) || 0 : 0;
}

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function nDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function fetchAssignedAccountIds(businessId: string): Promise<string[]> {
  const readiness = await getDbSchemaReadiness({
    tables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
  });
  if (!readiness.ready) {
    return [];
  }
  try {
    const row = await getProviderAccountAssignments(businessId, "meta");
    return row?.account_ids ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch ad-level insights for an account.
 * Returns ad_id, spend, ctr, actions, action_values, purchase_roas.
 */
async function fetchAdInsights(
  accountId: string,
  since: string,
  until: string,
  accessToken: string
): Promise<MetaAdInsightRecord[]> {
  const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
  url.searchParams.set("level", "ad");
  url.searchParams.set(
    "fields",
    "ad_id,ad_name,spend,ctr,actions,action_values,purchase_roas"
  );
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("sort", "spend_descending");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", accessToken);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      console.warn("[meta-top-creatives] insights non-ok", {
        accountId,
        status: res.status,
        raw: raw.slice(0, 300),
      });
      return [];
    }
    const json = (await res.json()) as { data?: MetaAdInsightRecord[] };
    return json.data ?? [];
  } catch (e: unknown) {
    console.warn("[meta-top-creatives] insights threw", {
      accountId,
      message: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Fetch all ads for an account with creative thumbnail/image fields.
 * Returns a map of ad_id → creative info.
 *
 * We request thumbnail_url, image_url, and object_type so we can:
 *   1. Determine if the ad is a catalog/DPA ad (object_type === "DYNAMIC")
 *   2. Get the best available preview URL
 */
async function fetchAdCreativeMap(
  accountId: string,
  accessToken: string
): Promise<Map<string, MetaAdRecord>> {
  let nextUrl: string | null = null;
  const map = new Map<string, MetaAdRecord>();

  try {
    do {
      const url = nextUrl ? new URL(nextUrl) : new URL(`https://graph.facebook.com/v25.0/${accountId}/ads`);
      if (!nextUrl) {
        url.searchParams.set(
          "fields",
          [
            "id",
            "promoted_object{product_set_id,catalog_id}",
            [
              "creative{",
              "id,name,object_type,effective_object_story_id,thumbnail_url,image_url,",
              "object_story_spec{link_data{picture,image_hash,child_attachments{picture,image_url}},video_data{image_url,thumbnail_url},photo_data{image_url},template_data},",
              "asset_feed_spec{images{url,image_url,original_url,hash,image_hash},videos{thumbnail_url,image_url}}",
              "}",
            ].join(""),
          ].join(",")
        );
        url.searchParams.set("limit", "500");
        url.searchParams.set("access_token", accessToken);
      }

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        console.warn("[meta-top-creatives] ads non-ok", {
          accountId,
          status: res.status,
          raw: raw.slice(0, 300),
        });
        return map;
      }

      const json = (await res.json()) as { data?: MetaAdRecord[]; paging?: { next?: string } };
      for (const ad of json.data ?? []) {
        map.set(ad.id, ad);
      }
      nextUrl = json.paging?.next ?? null;
    } while (nextUrl);

    return map;
  } catch (e: unknown) {
    console.warn("[meta-top-creatives] ads threw", {
      accountId,
      message: e instanceof Error ? e.message : String(e),
    });
    return map;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "6", 10), 20);

  logRuntimeDebug("meta-top-creatives", "request", { businessId, startDate, endDate, limit });

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const resolvedStart = startDate ?? toISODate(nDaysAgo(29));
  const resolvedEnd = endDate ?? toISODate(new Date());

  // Step 1: Assigned accounts
  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  logRuntimeDebug("meta-top-creatives", "assigned_accounts", {
    businessId,
    count: assignedAccountIds.length,
  });

  if (assignedAccountIds.length === 0) {
    return NextResponse.json({ status: "no_accounts_assigned", rows: [] });
  }

  // Step 2: Access token
  const integration = await getIntegration(businessId, "meta").catch(() => null);
  const accessToken = integration?.access_token ?? null;

  if (!accessToken) {
    return NextResponse.json({ status: "no_access_token", rows: [] });
  }

  // Step 3: Per account — fetch insights + ad creative info in parallel, then merge
  const allRows: MetaCreativeRow[] = [];

  for (const accountId of assignedAccountIds) {
    try {
      const [insightData, creativeMap] = await Promise.all([
        fetchAdInsights(accountId, resolvedStart, resolvedEnd, accessToken),
        fetchAdCreativeMap(accountId, accessToken),
      ]);

      for (const insight of insightData) {
        const spend = parseFloat(insight.spend ?? "0") || 0;
        if (spend === 0) continue;

        const adId = insight.ad_id ?? "";
        const ad = creativeMap.get(adId);
        const creative = ad?.creative ?? null;
        const normalizedPreview = normalizeCreativePreview({
          creative,
          promotedObject: ad?.promoted_object ?? null,
        });

        const purchases = parseAction(insight.actions, "purchase");
        const revenueFromValues = parseAction(insight.action_values, "purchase");
        const purchaseRoasVal = parseAction(insight.purchase_roas, "omni_purchase");
        const revenue = revenueFromValues > 0 ? revenueFromValues : spend * purchaseRoasVal;
        const roas = spend > 0 ? revenue / spend : 0;
        const ctr = parseFloat(insight.ctr ?? "0") || 0;

        allRows.push({
          creative_id: creative?.id ?? adId,
          name: insight.ad_name ?? "Unknown Ad",
          preview_url: normalizedPreview.preview_url,
          image_url: normalizedPreview.image_url,
          thumbnail_url: normalizedPreview.thumbnail_url,
          is_catalog: normalizedPreview.is_catalog,
          preview_state: normalizedPreview.preview_state,
          format: normalizedPreview.format,
          spend: r2(spend),
          revenue: r2(revenue),
          roas: r2(roas),
          ctr: r2(ctr),
          purchases: Math.round(purchases),
        });
      }
    } catch (e: unknown) {
      console.warn("[meta-top-creatives] account processing failed", {
        businessId,
        accountId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Sort by ROAS desc, then spend desc; return top N
  allRows.sort((a, b) => b.roas - a.roas || b.spend - a.spend);
  const rows = allRows.slice(0, limit);

  logRuntimeDebug("meta-top-creatives", "response", {
    businessId,
    rowCount: rows.length,
    catalogCount: rows.filter((r) => r.is_catalog).length,
    withPreviewCount: rows.filter((r) => r.preview_url !== null).length,
  });

  return NextResponse.json({ rows });
}
