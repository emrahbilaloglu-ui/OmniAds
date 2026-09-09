import { NextRequest, NextResponse } from "next/server";
import { getIntegration } from "@/lib/integrations";
import { fetchMetaAdAccounts } from "@/lib/meta-ad-accounts";
import { requireBusinessAccess } from "@/lib/access";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;
  const authorizedBusinessId = access.membership.businessId;
  const integration = await getIntegration(authorizedBusinessId, "meta");
  if (!integration) {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message: "Meta integration not found for this business.",
      },
      { status: 404 }
    );
  }

  if (!integration.access_token) {
    return NextResponse.json(
      {
        error: "missing_access_token",
        message: "Meta access token is missing for this business integration.",
      },
      { status: 401 }
    );
  }

  const result = await fetchMetaAdAccounts(integration.access_token);
  /*
    Diagnostics, not a mirror of the provider response.

    This handler used to return `result.body` and `result.rawBody` verbatim.
    Both carried Meta's `error.message`, which is free text the provider
    controls and has been observed echoing the access token back inside it, and
    `rawBody` carried the entire response. `rawBody` no longer exists, and
    `result.body.error` is now a `MetaSafeGraphError` this repository authored:
    a locally-written sentence plus the four named Graph identifiers.
  */
  return NextResponse.json({
    businessId: authorizedBusinessId,
    integration: {
      id: integration.id,
      status: integration.status,
      token_expires_at: integration.token_expires_at,
      has_access_token: Boolean(integration.access_token),
      scopes: integration.scopes,
    },
    meta: {
      status: result.status,
      ok: result.ok,
      error: result.body?.error ?? null,
      graph_error: result.graphError ?? null,
      normalized_count: result.normalized.length,
      business_discovery: result.businessDiscovery
        ? {
            status: result.businessDiscovery.status,
            ok: result.businessDiscovery.ok,
            business_count: result.businessDiscovery.businessCount,
            account_count: result.businessDiscovery.accountCount,
            errors: result.businessDiscovery.errors,
          }
        : null,
    },
  });
}
