import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoGa4Properties } from "@/lib/demo-business";
import { getIntegration, upsertIntegration } from "@/lib/integrations";
import {
  fetchGA4Properties,
  fetchGA4PropertyMetadata,
  isPropertyAccessible
} from "@/lib/google-analytics-accounts";
import {
  resolveGa4AnalyticsContext,
  GA4AuthError,
  type GA4ResolvedAnalyticsContext,
} from "@/lib/google-analytics-reporting";
import { requireBusinessAccess } from "@/lib/access";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { logRuntimeDebug } from "@/lib/runtime-logging";

function normalizeGa4PropertyId(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `properties/${trimmed}`;
  return trimmed;
}

/**
 * POST /api/google-analytics/select-property
 *
 * Body: { businessId, propertyId, propertyName, accountId, accountName }
 *
 * Validates that the selected property is accessible by the connected
 * Google account, then persists the selection in the integration metadata.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const businessId =
    typeof body.businessId === "string" ? body.businessId : null;
  const propertyId =
    typeof body.propertyId === "string" ? body.propertyId : null;
  const propertyName =
    typeof body.propertyName === "string" ? body.propertyName : null;
  const accountId = typeof body.accountId === "string" ? body.accountId : null;
  const accountName =
    typeof body.accountName === "string" ? body.accountName : null;

  if (!businessId || !propertyId || !propertyName) {
    return NextResponse.json(
      {
        error: "missing_fields",
        message: "businessId, propertyId, and propertyName are required.",
      },
      { status: 400 },
    );
  }

  // Verify user has access to this business
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  // Selection mutation is quiesced with every other writer during a cutover. A
  // GA4 property decides what every later source-ingest run reads, so it belongs
  // to the same lane as ad-account selection rather than outside every switch.
  try {
    assertSyncLaneEnabled("assignment_mutation");
  } catch (error) {
    return NextResponse.json(
      {
        error: "lane_disabled",
        message: "Property selection is currently disabled.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  if (await isDemoBusiness(businessId)) {
    const normalizedPropertyId = normalizeGa4PropertyId(propertyId);
    const property = getDemoGa4Properties().find((item) => item.propertyId === normalizedPropertyId);
    if (!property) {
      return NextResponse.json(
        {
          error: "property_not_accessible",
          message: "The selected property is not available in the demo workspace.",
        },
        { status: 403 },
      );
    }

    const now = new Date().toISOString();
    return NextResponse.json({
      success: true,
      integration: {
        id: "demo-ga4",
        provider: "ga4",
        status: "connected",
        provider_account_id: property.propertyId,
        provider_account_name: property.propertyName,
        connected_at: now,
        updated_at: now,
        metadata: {
          ga4PropertyId: property.propertyId,
          ga4PropertyName: property.propertyName,
          ga4AccountId: property.accountId,
          ga4AccountName: property.accountName,
          ga4PropertyTimeZone: null,
          propertyId: property.propertyId.replace(/^properties\//, ""),
          propertyName: property.propertyName,
          propertyResourceName: property.propertyId,
          selectedAt: now,
        },
      },
    });
  }

  // Get the existing GA4 integration
  const integration = await getIntegration(businessId, "ga4");
  if (!integration || integration.status !== "connected") {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message:
          "Google Analytics integration not found or not connected for this business.",
      },
      { status: 404 },
    );
  }

  let ga4Context: GA4ResolvedAnalyticsContext;
  try {
    ga4Context = await resolveGa4AnalyticsContext(businessId, {
      requireProperty: false,
    });
  } catch (err) {
    if (err instanceof GA4AuthError) {
      return NextResponse.json(
        {
          error: err.code,
          message: err.message,
          action: err.action,
          reconnectRequired: err.action === "reconnect_ga4",
        },
        { status: err.status },
      );
    }
    throw err;
  }

  // Validate that the property is accessible by this user
  const propertiesResult = await fetchGA4Properties(ga4Context.accessToken);
  if (!propertiesResult.ok) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message:
          propertiesResult.error ?? "Could not validate property access.",
      },
      { status: 502 },
    );
  }

  const normalizedPropertyId = normalizeGa4PropertyId(propertyId);
  if (
    !isPropertyAccessible(normalizedPropertyId, propertiesResult.properties)
  ) {
    return NextResponse.json(
      {
        error: "property_not_accessible",
        message:
          "The selected property is not accessible with this Google account.",
      },
      { status: 403 },
    );
  }

  const propertyMetadata = await fetchGA4PropertyMetadata(
    ga4Context.accessToken,
    normalizedPropertyId,
  ).catch((error: unknown) => {
    console.warn("[ga4-select-property] property_metadata_failed", {
      businessId,
      propertyId: normalizedPropertyId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { propertyId: normalizedPropertyId, timeZone: null };
  });

  // Save property selection to integration metadata
  const existingMetadata = (integration.metadata ?? {}) as Record<
    string,
    unknown
  >;
  const updatedIntegration = await upsertIntegration({
    businessId,
    provider: "ga4",
    status: "connected",
    providerAccountId: normalizedPropertyId,
    providerAccountName: propertyName,
    metadata: {
      ...existingMetadata,
      ga4PropertyId: normalizedPropertyId,
      ga4PropertyName: propertyName,
      ga4AccountId: accountId,
      ga4AccountName: accountName,
      ga4PropertyTimeZone: propertyMetadata.timeZone,
    },
  });

  logRuntimeDebug("ga4-select-property", "property_linked", {
    businessId,
    propertyId: normalizedPropertyId,
    propertyName,
    accountId,
    accountName,
    propertyTimeZone: propertyMetadata.timeZone,
  });

  return NextResponse.json({
    success: true,
    integration: {
      id: updatedIntegration.id,
      provider: updatedIntegration.provider,
      status: updatedIntegration.status,
      metadata: updatedIntegration.metadata,
    },
  });
}
