import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getIntegrationMetadata } from "@/lib/integrations";
import {
  klaviyoBelongsInRail,
  klaviyoIsConnectable,
  resolveKlaviyoState,
} from "@/lib/klaviyo/state";
import { readKlaviyoFlowSnapshot } from "@/lib/klaviyo/warehouse";
import { isKlaviyoOAuthConfigured } from "@/lib/oauth/klaviyo-config";

/**
 * GET /api/klaviyo/status?businessId=...
 *
 * The one server fact the Integrations card cannot derive in the browser:
 * whether this DEPLOYMENT holds Klaviyo client credentials at all.
 *
 * Without it the card has only two bad options — show a Connect button that
 * lands on a 501 (what defect KLAVIYO-INTEGRATIONS-28 refused), or never show
 * one (what it has done since). `connectable` is the third: true once the
 * owner has created a Klaviyo OAuth app and set its secrets, false until then.
 *
 * AUTHORIZATION — `requireBusinessAccess` with `minRole: "guest"`, identical to
 * its closest sibling, `app/api/integrations/status/route.ts`. It returns no
 * credential and no metric; the connection's own status is already readable
 * through `/api/integrations` at the same floor.
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

  return NextResponse.json({
    state,
    connectable: klaviyoIsConnectable(state),
    inRail: klaviyoBelongsInRail(state),
    providerAccountName: integration?.provider_account_name ?? null,
    lastSyncedAt: snapshot?.fetchedAt ?? null,
    flowCount: snapshot?.rows.length ?? 0,
  });
}
