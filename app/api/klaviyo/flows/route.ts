import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getIntegrationMetadata } from "@/lib/integrations";
import { presentKlaviyoFlow } from "@/lib/klaviyo/flow-presentation";
import {
  klaviyoMayServeRows,
  resolveKlaviyoState,
} from "@/lib/klaviyo/state";
import {
  KLAVIYO_FLOW_WINDOW_DAYS,
  readKlaviyoFlowSnapshot,
} from "@/lib/klaviyo/warehouse";
import { isKlaviyoOAuthConfigured } from "@/lib/oauth/klaviyo-config";

/**
 * GET /api/klaviyo/flows?businessId=...
 *
 * The five columns of the design's lifecycle table (design 1710-1727), read
 * from `klaviyo_flow_metrics`. Never from Klaviyo directly: this is a read
 * path, and a page view must not be able to spend a provider's rate limit or
 * write to the warehouse.
 *
 * AUTHORIZATION — `requireBusinessAccess` with `minRole: "guest"`, copied from
 * its closest sibling read, `app/api/search-console/analytics/route.ts` (and
 * matching `app/api/integrations/status/route.ts`). Guest is the right floor:
 * this returns only aggregate marketing performance for a business the caller
 * is already a member of, and the screen it feeds is read-only by design.
 *
 * `flows: null` and `flows: []` mean different things and both are true:
 *   null — no snapshot exists (not connected, reconnect required, or the first
 *          import has not landed). The adapter draws the design's one em-dash
 *          row and invents nothing.
 *   []   — a snapshot exists and this Klaviyo account genuinely has no flows.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const integration = await getIntegrationMetadata(businessId, "klaviyo");
  const snapshot = await readKlaviyoFlowSnapshot({ businessId });

  const state = resolveKlaviyoState({
    oauthConfigured: isKlaviyoOAuthConfigured(),
    connectionStatus: integration?.status ?? null,
    hasSnapshot: snapshot != null,
  });

  // The gate. A stored snapshot describes a grant; if that grant is no longer
  // connected the snapshot is withheld rather than served as if it were current.
  if (!klaviyoMayServeRows(state) || !snapshot) {
    return NextResponse.json({
      state,
      flows: null,
      meta: {
        windowDays: KLAVIYO_FLOW_WINDOW_DAYS,
        windowStart: null,
        windowEnd: null,
        fetchedAt: null,
        rowCount: 0,
      },
    });
  }

  return NextResponse.json({
    state,
    flows: snapshot.rows.map(presentKlaviyoFlow),
    meta: {
      windowDays: snapshot.windowDays,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      fetchedAt: snapshot.fetchedAt,
      rowCount: snapshot.rows.length,
    },
  });
}
