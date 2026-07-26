import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSearchConsoleSiteAccessible } from "@/lib/search-console-site-selection-authority";
import { upsertIntegration } from "@/lib/integrations";
import {  } from "@/lib/demo-business";
import {
  getSearchConsoleSiteType,
  resolveSearchConsoleContext,
  SearchConsoleAuthError,
} from "@/lib/search-console";

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

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { businessId?: unknown; siteUrl?: unknown }
    | null;

  const businessId =
    typeof body?.businessId === "string" ? body.businessId : null;
  const siteUrl = normalizeSiteUrl(body?.siteUrl);

  if (!businessId || !siteUrl) {
    return NextResponse.json(
      {
        error: "missing_fields",
        message: "businessId and siteUrl are required.",
      },
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
        provider: "search_console",
        status: "connected",
        provider_account_id: siteUrl,
        provider_account_name: siteUrl,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          siteUrl,
          siteType: getSearchConsoleSiteType(siteUrl),
          propertyName: "urbantrail.co",
          connectedAt: new Date().toISOString(),
        },
      },
    });
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

  try {
    const context = await resolveSearchConsoleContext({
      businessId,
      requireSite: false,
    });

    const existingMetadata =
      context.integration.metadata && typeof context.integration.metadata === "object"
        ? (context.integration.metadata as Record<string, unknown>)
        : {};

    const selected = await upsertIntegration({
      businessId,
      provider: "search_console",
      status: "connected",
      providerAccountId: verifiedSiteUrl,
      providerAccountName: verifiedSiteUrl,
      metadata: {
        ...existingMetadata,
        siteUrl: verifiedSiteUrl,
        siteType: getSearchConsoleSiteType(verifiedSiteUrl),
        propertyName: verifiedSiteUrl,
        connectedAt:
          context.integration.connected_at ?? new Date().toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      integration: {
        id: selected.id,
        provider: selected.provider,
        status: selected.status,
        provider_account_id: selected.provider_account_id,
        provider_account_name: selected.provider_account_name,
        connected_at: selected.connected_at,
        updated_at: selected.updated_at,
        metadata: selected.metadata,
      },
    });
  } catch (error) {
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
