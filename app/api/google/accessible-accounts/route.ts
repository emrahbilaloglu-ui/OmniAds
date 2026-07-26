import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoProviderDiscoveryPayload } from "@/lib/demo-business";
import { fetchGoogleAdsAccounts } from "@/lib/google-ads-accounts";
import { resolveGoogleAccessTokenWithGeneration } from "@/lib/google-token-refresh";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";
import { getIntegration } from "@/lib/integrations";
import { resolveProviderDiscoveryPayload } from "@/lib/provider-account-discovery";
import { refreshProviderDiscoveryPayload } from "@/lib/provider-account-discovery-refresh";
import { GOOGLE_CONFIG } from "@/lib/oauth/google-config";
import { ProviderAccountSnapshotRefreshError } from "@/lib/provider-account-snapshots";

const GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS = 6 * 60 * 60_000;

function getGoogleDiscoveryFailureMessage(hasSnapshot: boolean) {
  if (hasSnapshot) {
    return "Your accounts list could not be refreshed right now. Showing the last available list.";
  }
  return "We couldn't load your Google Ads accounts right now. A background sync has been scheduled.";
}

function formatRetryAfter(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getGoogleQuotaCooldownNotice(retryAfterAt: string | null) {
  const formatted = formatRetryAfter(retryAfterAt);
  if (!formatted) {
    return "Google Ads account refresh is temporarily rate-limited. Using cached accounts for now.";
  }
  return `Google Ads account refresh is temporarily rate-limited. Using cached accounts until ${formatted}.`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const refreshRequested = searchParams.get("refresh") === "1";

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  // `refresh=1` on a GET was accepted and silently ignored: this route handed
  // back the cached snapshot with whatever `meta` it carried, so a user pressing
  // Refresh saw the same stale list presented as current and no provider call
  // was ever made. A refresh is a write, and this is the read path, so it is
  // refused explicitly and pointed at the endpoint that really performs one.
  if (refreshRequested) {
    return NextResponse.json(
      {
        error: "refresh_requires_post",
        message:
          "Refreshing the Google Ads account list performs a provider call and a write. POST this endpoint to refresh.",
      },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  if (await isDemoBusiness(businessId)) {
    const payload = getDemoProviderDiscoveryPayload("google");
    return NextResponse.json({
      data: payload.data,
      count: payload.data.length,
      meta: payload.meta,
      notice: payload.notice,
    });
  }

  const integration = await getIntegration(businessId, "google");
  if (!integration) {
    return NextResponse.json(
      {
        error: "google_integration_missing",
        message: "No connected Google integration found for this business.",
      },
      { status: 404 }
    );
  }

  // Read BEFORE anything downstream reads the credential, so the refresh can
  // refuse rather than stamp an old-token result with a new generation.
  const capturedConnectionGeneration = await readProviderConnectionGenerationToken(
    businessId,
    "google",
  );

  const discoveryInput = {
      businessId,
      provider: "google",
      refreshRequested,
      freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      missingSnapshotNotice:
        "Showing your saved Google Ads assignments while the full account list is prepared.",
      degradedNotice: getGoogleDiscoveryFailureMessage(true),
      quotaNotice: getGoogleQuotaCooldownNotice,
      unavailableNotice:
        "Google Ads accounts are being prepared in the background. You can keep using the page without waiting.",
      // The generation this request's credential belongs to, captured with the
      // credential rather than after it. The refresh then runs OUTSIDE the
      // snapshot transaction and CASes its write-back, so a successful token
      // update can no longer be rolled back by a later snapshot failure and an
      // in-flight reconnect wins instead of being overwritten.
      expectedConnectionGeneration: capturedConnectionGeneration,
      liveLoader: async () => {
        const hasAdsScope = Boolean(
          integration.scopes?.split(/\s+/).includes("https://www.googleapis.com/auth/adwords")
        );
        if (!hasAdsScope) {
          throw new Error(
            "This Google connection is missing the Google Ads scope. Reconnect Google Ads and approve Google Ads access."
          );
        }

        const { accessToken } = await resolveGoogleAccessTokenWithGeneration({
          businessId,
          provider: "google",
        });

        let hasDeveloperToken = false;
        try {
          hasDeveloperToken = Boolean(GOOGLE_CONFIG.developerToken);
        } catch {
          hasDeveloperToken = false;
        }

        const result = await fetchGoogleAdsAccounts(accessToken, {
          scopePresent: hasAdsScope,
        });

        if (!result.ok) {
          throw new Error(
            result.error ??
              (hasDeveloperToken
                ? "Could not discover accessible Google Ads accounts."
                : "Google Ads developer token is missing.")
          );
        }

        return result.customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          currency: customer.currency ?? undefined,
          timezone: customer.timezone ?? undefined,
          isManager: customer.isManager,
        }));
      },
    } as const;

  try {
    const payload = await resolveProviderDiscoveryPayload(discoveryInput);

    return NextResponse.json({
      data: payload.data,
      count: payload.data.length,
      meta: payload.meta,
      notice: payload.notice,
    });
  } catch (error) {
    if (error instanceof ProviderAccountSnapshotRefreshError) {
      if (refreshRequested) {
        const fallbackPayload = await resolveProviderDiscoveryPayload({
          ...discoveryInput,
          refreshRequested: false,
        }).catch(() => null);
        if (fallbackPayload?.meta.lastKnownGoodAvailable) {
          return NextResponse.json({
            data: fallbackPayload.data,
            count: fallbackPayload.data.length,
            meta: fallbackPayload.meta,
            notice: fallbackPayload.notice,
          });
        }
      }
      return NextResponse.json(
        {
          error: "google_ads_discovery_unavailable",
          message: getGoogleDiscoveryFailureMessage(false),
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error: "google_ads_discovery_error",
        message:
          error instanceof Error && error.message
            ? error.message
            : getGoogleDiscoveryFailureMessage(false),
      },
      { status: 500 }
    );
  }
}

/**
 * The real refresh: a provider call and a snapshot write.
 *
 * It lives on POST because it writes, and because `refresh=1` on the GET was
 * accepted and ignored — returning cached data that the UI presented as
 * just-fetched. The credential generation is captured with the credential and
 * carried into the refresh, so a reconnect landing mid-flight is refused rather
 * than producing a snapshot stamped with a generation its accounts never
 * belonged to.
 */
export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");

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

  if (await isDemoBusiness(businessId)) {
    const payload = getDemoProviderDiscoveryPayload("google");
    return NextResponse.json({
      data: payload.data,
      count: payload.data.length,
      meta: payload.meta,
      notice: payload.notice,
    });
  }

  const integration = await getIntegration(businessId, "google");
  if (!integration) {
    return NextResponse.json(
      {
        error: "google_integration_missing",
        message: "No connected Google integration found for this business.",
      },
      { status: 404 },
    );
  }

  const capturedConnectionGeneration = await readProviderConnectionGenerationToken(
    businessId,
    "google",
  );

  const liveLoader = async () => {
    const hasAdsScope = Boolean(
      integration.scopes?.split(/\s+/).includes("https://www.googleapis.com/auth/adwords"),
    );
    if (!hasAdsScope) {
      throw new Error(
        "This Google connection is missing the Google Ads scope. Reconnect Google Ads and approve Google Ads access.",
      );
    }
    const { accessToken } = await resolveGoogleAccessTokenWithGeneration({
      businessId,
      provider: "google",
    });
    const result = await fetchGoogleAdsAccounts(accessToken, { scopePresent: hasAdsScope });
    if (!result.ok) {
      throw new Error(
        result.error ??
          (GOOGLE_CONFIG.developerToken
            ? "Could not discover accessible Google Ads accounts."
            : "Google Ads developer token is missing."),
      );
    }
    return result.customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      currency: customer.currency ?? undefined,
      timezone: customer.timezone ?? undefined,
      isManager: customer.isManager,
    }));
  };

  try {
    const payload = await refreshProviderDiscoveryPayload({
      businessId,
      provider: "google",
      liveLoader,
      freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      reason: "google_accounts_manual_refresh",
      expectedConnectionGeneration: capturedConnectionGeneration,
    });
    return NextResponse.json({
      data: payload.data,
      count: payload.data.length,
      meta: payload.meta,
      notice: payload.notice,
    });
  } catch (error) {
    if (error instanceof ProviderAccountSnapshotRefreshError) {
      return NextResponse.json(
        {
          error: "google_ads_discovery_unavailable",
          message: getGoogleDiscoveryFailureMessage(true),
          retryAfterMs: error.retryAfterMs ?? null,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: "google_ads_discovery_error",
        message:
          error instanceof Error && error.message
            ? error.message
            : getGoogleDiscoveryFailureMessage(false),
      },
      { status: 500 },
    );
  }
}
