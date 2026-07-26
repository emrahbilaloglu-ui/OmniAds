import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSearchConsoleSiteAccessible } from "@/lib/search-console-site-selection-authority";
import {
  upsertIntegration,
  ProviderConnectionGenerationConflictError,
} from "@/lib/integrations";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";
import {  } from "@/lib/demo-business";
import {
  getSearchConsoleSiteType,
  resolveSearchConsoleContext,
  SearchConsoleAuthError,
} from "@/lib/search-console";

interface SearchConsoleSiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

function extractGoogleApiMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { error?: { message?: unknown; status?: unknown } };
  const msg = root.error?.message;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

function isServiceDisabled(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as { error?: { status?: unknown } };
  return root.error?.status === "PERMISSION_DENIED";
}

function normalizeSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("sc-domain:")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId query parameter is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    const sites = [
      { siteUrl: "sc-domain:urbantrail.co", permissionLevel: "siteOwner", siteType: "domain" },
      { siteUrl: "https://urbantrail.co/", permissionLevel: "siteOwner", siteType: "url-prefix" },
    ];
    return NextResponse.json({ sites, data: sites });
  }

  try {
    const context = await resolveSearchConsoleContext({
      businessId,
      requireSite: false,
    });

    const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as
      | { siteEntry?: SearchConsoleSiteEntry[] }
      | null;

    if (!response.ok) {
      const providerMessage = extractGoogleApiMessage(payload);
      return NextResponse.json(
        {
          error: isServiceDisabled(payload)
            ? "search_console_api_disabled"
            : "search_console_sites_fetch_failed",
          message:
            providerMessage ??
            "Could not fetch Search Console properties.",
          details: payload,
        },
        { status: response.status || 502 },
      );
    }

    const sites = (payload?.siteEntry ?? [])
      .map((row) => {
        const siteUrl = typeof row.siteUrl === "string" ? row.siteUrl : "";
        if (!siteUrl) return null;
        return {
          siteUrl,
          permissionLevel:
            typeof row.permissionLevel === "string" ? row.permissionLevel : "unknown",
          siteType: getSearchConsoleSiteType(siteUrl),
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    // Keep both keys for backward compatibility.
    return NextResponse.json({
      sites,
      data: sites,
    });
  } catch (error) {
    if (error instanceof SearchConsoleAuthError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: "search_console_sites_fetch_failed",
        message: "Could not fetch Search Console properties.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId query parameter is required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({
      success: true,
      integration: {
        id: "demo-search-console",
        business_id: businessId,
        provider: "search_console",
        status: "connected",
        metadata: {
          siteUrl: "sc-domain:urbantrail.co",
          siteType: "domain",
          propertyName: "urbantrail.co",
          connectedAt: new Date().toISOString(),
        },
      },
    });
  }

  const body = (await request.json().catch(() => null)) as
    | { property_url?: unknown; siteUrl?: unknown }
    | null;
  const siteUrl = normalizeSiteUrl(body?.siteUrl ?? body?.property_url);

  if (!siteUrl) {
    return NextResponse.json(
      { error: "invalid_site_url", message: "A valid site URL is required." },
      { status: 400 },
    );
  }

  // Selection mutation is quiesced with every other writer during a cutover,
  // and a Search Console property is exactly as load-bearing as an ad account:
  // it decides what every later sync reads.
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

  // Membership in the CONNECTED token's live accessible-site set. Both writers
  // previously accepted any syntactically valid URL and wrote it onto the
  // canonical connection, so a typo or a third-party domain became the selected
  // property and every later sync failed against a site the token cannot see.
  const accessible = await assertSearchConsoleSiteAccessible({
    businessId,
    siteUrl,
  }).catch((error: unknown) => ({
    ok: false as const,
    refusal: {
      kind: "listing_failed" as const,
      status: 502,
      detail: error instanceof Error ? error.message : String(error),
    },
  }));
  if (!accessible.ok) {
    return NextResponse.json(
      accessible.refusal.kind === "not_accessible"
        ? {
            error: "search_console_site_not_accessible",
            message:
              "This Search Console property is not available to the connected account. Refresh the property list and choose one of the listed properties.",
          }
        : {
            error: "search_console_sites_fetch_failed",
            message:
              "Could not confirm which Search Console properties this connection can access. Nothing was changed.",
            detail: accessible.refusal.detail,
          },
      { status: accessible.refusal.kind === "not_accessible" ? 400 : 503 },
    );
  }
  const verifiedSiteUrl = accessible.siteUrl;

  // Re-read lane and generation AFTER the slow accessibility listing.
  //
  // `assertSearchConsoleSiteAccessible` is a live provider round trip. A
  // disconnect, a reconnect as a different Google principal, or a cutover
  // quiesce can all land inside that window, and the write below would
  // otherwise commit a property validated against a connection that no longer
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
  const generationAfterListing = await readProviderConnectionGenerationToken(
    businessId,
    "search_console",
  ).catch(() => null);

  try {
    const context = await resolveSearchConsoleContext({
      businessId,
      requireSite: false,
    });

    const metadata =
      context.integration.metadata && typeof context.integration.metadata === "object"
        ? (context.integration.metadata as Record<string, unknown>)
        : {};

    const updated = await upsertIntegration({
      businessId,
      provider: "search_console",
      status: "connected",
      providerAccountId: verifiedSiteUrl,
      providerAccountName: verifiedSiteUrl,
      expectedConnectionGeneration: generationAfterListing,
      metadata: {
        ...metadata,
        siteUrl: verifiedSiteUrl,
        siteType: getSearchConsoleSiteType(verifiedSiteUrl),
        propertyName: verifiedSiteUrl,
        connectedAt:
          context.integration.connected_at ?? new Date().toISOString(),
      },
    });

    return NextResponse.json({ success: true, integration: updated });
  } catch (error) {
    if (error instanceof ProviderConnectionGenerationConflictError) {
      return NextResponse.json(
        {
          error: "connection_changed",
          message:
            "The Search Console connection changed while this property was being validated. Nothing was saved; try again.",
          retryable: true,
        },
        { status: 409 },
      );
    }
    if (error instanceof SearchConsoleAuthError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "search_console_select_site_failed", message: "Could not save selected site." },
      { status: 500 },
    );
  }
}
