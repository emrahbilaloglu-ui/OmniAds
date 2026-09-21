import { NextRequest, NextResponse } from "next/server";

import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegration } from "@/lib/integrations";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { hasShopifyScope } from "@/lib/shopify/admin";
import {
  getShopifyUnitCostCatalog,
  ShopifyUnitCostStorageUnavailableError,
  ShopifyUnitCostSyncError,
  syncShopifyUnitCosts,
} from "@/lib/shopify/unit-cost-catalog";

async function connectionState(businessId: string) {
  const integration = await getIntegration(businessId, "shopify").catch(() => null);
  const connected = Boolean(
    integration?.status === "connected" &&
      integration.provider_account_id &&
      integration.access_token,
  );
  const missingScopes = connected
    ? ["read_products", "read_inventory"].filter(
        (scope) => !hasShopifyScope(integration?.scopes, scope),
      )
    : [];
  return {
    connected,
    shopDomain: connected ? integration?.provider_account_id ?? null : null,
    scopeReady: connected && missingScopes.length === 0,
    missingScopes,
  };
}

function parseInteger(value: string | null, fallback: number) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  const [catalog, connection] = await Promise.all([
    getShopifyUnitCostCatalog({
      businessId: access.membership.businessId,
      search: request.nextUrl.searchParams.get("search"),
      limit: parseInteger(request.nextUrl.searchParams.get("limit"), 50),
      offset: parseInteger(request.nextUrl.searchParams.get("offset"), 0),
    }),
    connectionState(access.membership.businessId),
  ]);
  return NextResponse.json({ ...catalog, connection });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { businessId?: unknown } | null;
  const businessId = typeof body?.businessId === "string" ? body.businessId : null;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  const reviewerBlocked = rejectIfReviewerReadOnly(access, "shopify_unit_cost_sync");
  if (reviewerBlocked) return reviewerBlocked;
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "shopify_unit_cost_sync",
  );
  if (demoBlocked) return demoBlocked;

  try {
    const sync = await syncShopifyUnitCosts(access.membership.businessId);
    const [catalog, connection] = await Promise.all([
      getShopifyUnitCostCatalog({ businessId: access.membership.businessId }),
      connectionState(access.membership.businessId),
    ]);
    return NextResponse.json({ ...catalog, connection, sync });
  } catch (error) {
    if (error instanceof ShopifyUnitCostStorageUnavailableError) {
      return NextResponse.json(
        {
          error: "shopify_unit_cost_storage_unavailable",
          message: "Shopify cost storage is not migrated yet; no catalog data was changed.",
          missingTables: error.missingTables,
        },
        { status: 503 },
      );
    }
    if (error instanceof ShopifyUnitCostSyncError) {
      const status = error.code === "not_connected" ? 409 : error.code === "missing_scopes" ? 403 : 502;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    throw error;
  }
}
