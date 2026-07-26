import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoGa4Properties } from "@/lib/demo-business";
import {
  getIntegration,
  upsertIntegration,
  ProviderConnectionGenerationConflictError,
} from "@/lib/integrations";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";
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
  // The MATCHED provider row, not the caller's body.
  //
  // Names and account ids were taken straight from the request, so a caller
  // could bind a property under any label and any account id it liked — the
  // integration then reported an account relationship Google never asserted, and
  // every surface downstream read it as provider truth.
  const matchedProperty = propertiesResult.properties.find(
    (candidate) =>
      normalizeGa4PropertyId(candidate.propertyId) === normalizedPropertyId,
  );
  if (
    !matchedProperty ||
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
  // Re-read the lane and the exact connection generation AFTER the slow provider
  // calls above. Listing properties and fetching metadata are two network round
  // trips; a disconnect, a reconnect as a different Google principal, or a
  // cutover quiesce can all land inside that window, and the write would
  // otherwise commit a selection validated against a connection that no longer
  // exists.
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
  const generationAfterProviderCalls = await readProviderConnectionGenerationToken(
    businessId,
    "ga4",
  ).catch(() => null);

  let updatedIntegration;
  try {
    updatedIntegration = await upsertIntegration({
      businessId,
      provider: "ga4",
      status: "connected",
      providerAccountId: normalizedPropertyId,
      // Provider truth, every field of it.
      providerAccountName: matchedProperty.propertyName ?? normalizedPropertyId,
      expectedConnectionGeneration: generationAfterProviderCalls,
      metadata: {
        ...existingMetadata,
        ga4PropertyId: normalizedPropertyId,
        ga4PropertyName: matchedProperty.propertyName ?? normalizedPropertyId,
        ga4AccountId: matchedProperty.accountId ?? null,
        ga4AccountName: matchedProperty.accountName ?? null,
        ga4PropertyTimeZone: propertyMetadata.timeZone,
      },
    });
  } catch (error: unknown) {
    if (error instanceof ProviderConnectionGenerationConflictError) {
      return NextResponse.json(
        {
          error: "connection_changed",
          message:
            "The Google Analytics connection changed while this property was being validated. Nothing was saved; try again.",
          retryable: true,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  logRuntimeDebug("ga4-select-property", "property_linked", {
    businessId,
    propertyId: normalizedPropertyId,
    propertyName: matchedProperty.propertyName ?? normalizedPropertyId,
    accountId: matchedProperty.accountId ?? null,
    accountName: matchedProperty.accountName ?? null,
    callerSuppliedPropertyName: propertyName,
    callerSuppliedAccountId: accountId,
    callerSuppliedAccountName: accountName,
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
