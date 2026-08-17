import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoGa4Properties } from "@/lib/demo-business";
import {
  getIntegration,
  upsertIntegration,
  ProviderConnectionGenerationConflictError,
} from "@/lib/integrations";
import { connectionGenerationTokenFromIntegration } from "@/lib/provider-property-selection";
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
 *
 * GA4 authority is SELF-CONTAINED, unlike Search Console's, so this writer
 * deliberately carries no derived authority. The evidence, all of it in code:
 *
 *  - `resolveGa4AnalyticsContext` (lib/google-analytics-reporting.ts) reads
 *    `getIntegration(businessId, "ga4")` and takes `access_token` /
 *    `refresh_token` from THAT row. It never reads the `google` connection, and
 *    no GA4 module references the `"google"` provider at all.
 *  - The refresh path is `refreshGA4AccessToken(integration.refresh_token)` —
 *    again the `ga4` row's own refresh token.
 *  - `app/api/oauth/google-analytics/callback` is a separate OAuth flow that
 *    writes `accessToken`/`refreshToken` onto the `ga4` connection.
 *  - The property listing this route validates against
 *    (`fetchGA4Properties(ga4Context.accessToken)`) therefore runs on the ga4
 *    credential, which lives on the same connection this route writes.
 *
 * So a GA4 reconnect supplies a credential, `upsertIntegration` counts that as
 * an authority change, the `ga4` connection generation increments, and the
 * `expectedConnectionGeneration` compare-and-set below SEES it. That is exactly
 * what Search Console cannot do: there the listing runs on `google` while the
 * selection lands on `search_console`, so a Google reconnect moves a generation
 * the write never looks at. Binding GA4 to `google` would assert a relationship
 * the code does not have, and would start failing the moment a business connects
 * GA4 without connecting Google Ads.
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
          // The demo workspace's own denomination — every fabricated money
          // figure in `lib/demo-business.ts` is already declared in USD.
          ga4PropertyCurrency: "USD",
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

  // The generation every later decision in this request is bound to, captured
  // from the integration row itself and never re-read.
  //
  // It used to be read by a separate query issued after the property listing, so
  // a reconnect that landed during the listing was invisible: the token handed
  // to the compare-and-set was the one the reconnect had just produced, the
  // compare-and-set matched, and a property validated against the OLD Google
  // principal was written onto the NEW connection. Capturing it here — strictly
  // before the credential this request lists with is resolved — makes the
  // guarded window a superset of the credential's own validity window, so every
  // reconnect inside it is a refusal rather than a silent overwrite.
  const expectedConnectionGeneration =
    connectionGenerationTokenFromIntegration(integration);

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

  // Every persisted field is derived from `matchedProperty` from here on, including
  // the identifier. The caller's spelling only ever decided WHICH provider row
  // matched; letting it also decide what gets stored would record an identity the
  // listing never returned the moment the match stops being a byte comparison.
  const selectedPropertyResourceName = normalizeGa4PropertyId(
    matchedProperty.propertyId,
  );

  const propertyMetadata = await fetchGA4PropertyMetadata(
    ga4Context.accessToken,
    selectedPropertyResourceName,
  ).catch((error: unknown) => {
    console.warn("[ga4-select-property] property_metadata_failed", {
      businessId,
      propertyId: selectedPropertyResourceName,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      propertyId: selectedPropertyResourceName,
      timeZone: null,
      currencyCode: null,
    };
  });

  // Save property selection to integration metadata
  const existingMetadata = (integration.metadata ?? {}) as Record<
    string,
    unknown
  >;
  // Re-check the lane AFTER the slow provider calls above. Listing properties and
  // fetching metadata are two network round trips, and a cutover quiesce that
  // begins inside that window must stop this writer like every other one rather
  // than let an in-flight request slip a selection change past the switch.
  //
  // The connection generation is deliberately NOT re-read here; it was captured
  // before the credential was resolved, and re-reading it would hand the
  // compare-and-set the very reconnect it is meant to detect.
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

  let updatedIntegration;
  try {
    updatedIntegration = await upsertIntegration({
      businessId,
      provider: "ga4",
      status: "connected",
      providerAccountId: selectedPropertyResourceName,
      // Provider truth, every field of it.
      providerAccountName:
        matchedProperty.propertyName ?? selectedPropertyResourceName,
      expectedConnectionGeneration,
      metadata: {
        ...existingMetadata,
        ga4PropertyId: selectedPropertyResourceName,
        ga4PropertyName:
          matchedProperty.propertyName ?? selectedPropertyResourceName,
        ga4AccountId: matchedProperty.accountId ?? null,
        ga4AccountName: matchedProperty.accountName ?? null,
        ga4PropertyTimeZone: propertyMetadata.timeZone,
        // The unit every GA4 revenue metric this property serves is quoted in.
        // Stored beside the time zone from the same Admin read; `null` when the
        // provider did not give one, which every reader renders as missing
        // rather than as dollars.
        ga4PropertyCurrency: propertyMetadata.currencyCode,
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
    propertyId: selectedPropertyResourceName,
    propertyName: matchedProperty.propertyName ?? selectedPropertyResourceName,
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
