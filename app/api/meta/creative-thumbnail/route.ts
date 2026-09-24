import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { normalizeMediaUrl } from "@/lib/meta/creatives-utils";

export const dynamic = "force-dynamic";

/** A bounded, read-only retry for a Decisions image that failed in the browser. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId")?.trim() ?? "";
  const providerAccountId = params.get("providerAccountId")?.trim() ?? "";
  const creativeId = params.get("creativeId")?.trim() ?? "";
  const adId = params.get("adId")?.trim() ?? null;
  const providerAccountRefId = params.get("providerAccountRefId")?.trim() ?? null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!businessId || !/^act_\d{5,30}$/.test(providerAccountId) ||
      !/^\d{5,40}$/.test(creativeId) ||
      (adId !== null && !/^\d{5,40}$/.test(adId)) ||
      (providerAccountRefId !== null && !uuid.test(providerAccountRefId)) ||
      Boolean(adId) !== Boolean(providerAccountRefId)) {
    return NextResponse.json({ error: "invalid_thumbnail_scope" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  // Membership alone is insufficient: the connected token may span accounts.
  const assigned = await fetchAssignedAccountIds(businessId);
  if (!assigned.includes(providerAccountId)) {
    return NextResponse.json({ error: "account_not_assigned" }, { status: 403 });
  }

  try {
    const matching = await getDb().query<{ creative_id: string }>(
      `SELECT creative_id FROM meta_creative_media
       WHERE business_id = $1 AND provider_account_id = $2 AND creative_id = $3
       UNION ALL
       SELECT creative_id FROM meta_creative_dimensions
       WHERE business_id = $1 AND provider_account_id = $2 AND creative_id = $3
       UNION ALL
       SELECT creative_id FROM meta_creative_daily
       WHERE business_id = $1 AND provider_account_id = $2 AND creative_id = $3
       LIMIT 1`,
      [businessId, providerAccountId, creativeId],
    );
    // Native Decisions can carry an exact Ad -> creative identity before (or
    // without) a separate creative-media row. The Ad ID keeps this fallback
    // indexed and account-scoped; Creative-page URLs without it retain the
    // existing warehouse-only membership proof.
    const nativeMatch = matching.length === 0 && adId && providerAccountRefId &&
      uuid.test(businessId)
      ? await getDb().query<{ creative_id: string }>(
          `SELECT creative_id FROM engine_v3_ad_decision_snapshots_daily
           WHERE business_ref_id = $1::uuid AND business_id = $1::text
             AND provider_account_ref_id = $5::uuid
             AND provider_account_id = $2 AND ad_id = $4
             AND creative_id = $3 AND decision_entity_type = 'ad'
             AND decision_entity_id = ad_id AND scope_type = 'account'
             AND scope_id = $2
           ORDER BY as_of_date DESC LIMIT 1`,
          [businessId, providerAccountId, creativeId, adId, providerAccountRefId],
        )
      : [];
    if (matching.length === 0 && nativeMatch.length === 0) {
      return NextResponse.json({ error: "creative_not_in_account" }, { status: 404 });
    }

    const integration = await getIntegration(businessId, "meta");
    if (integration?.status !== "connected" || !integration.access_token) {
      return NextResponse.json({ error: "meta_connection_unavailable" }, { status: 503 });
    }
    // This failure-only read must not use the bulk thumbnail cache: that cache
    // also caches transient Graph failures as an empty map for 30 minutes.
    const providerUrl = new URL(`https://graph.facebook.com/v25.0/${creativeId}`);
    providerUrl.searchParams.set("fields", "thumbnail_url");
    providerUrl.searchParams.set("thumbnail_width", "150");
    providerUrl.searchParams.set("thumbnail_height", "120");
    providerUrl.searchParams.set("access_token", integration.access_token);
    const providerResponse = await fetch(providerUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!providerResponse.ok) {
      return NextResponse.json({ error: "meta_thumbnail_read_failed" }, { status: 502 });
    }
    const body = (await providerResponse.json()) as { thumbnail_url?: unknown };
    const thumbnailUrl = normalizeMediaUrl(body.thumbnail_url);
    return NextResponse.json(
      { thumbnailUrl: thumbnailUrl?.startsWith("https://") ? thumbnailUrl : null },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "thumbnail_refresh_failed" }, { status: 503 });
  }
}
