import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoProviderDiscoveryPayload } from "@/lib/demo-business";
import {
  getIntegration,
  providerConnectionGenerationTokenFromIntegration,
} from "@/lib/integrations";
import { fetchMetaAdAccounts, getMetaApiErrorMessage } from "@/lib/meta-ad-accounts";
import { resolveProviderDiscoveryPayload } from "@/lib/provider-account-discovery";
import { refreshProviderDiscoveryPayload } from "@/lib/provider-account-discovery-refresh";
import {
  ProviderAccountSnapshotRefreshError,
  readProviderAccountSnapshot,
} from "@/lib/provider-account-snapshots";

const META_ACCOUNT_SNAPSHOT_FRESHNESS_MS = 6 * 60 * 60_000;

/**
 * An error whose message this route is willing to put in an HTTP response.
 *
 * The `meta_api_error` branch used to return `error.message` for whatever it
 * caught. On the Meta path that message came from `getMetaApiErrorMessage`,
 * which returned Meta's own `error.message` — free text the provider controls,
 * observed echoing the access token back inside it. The helper is fixed, but
 * the branch also catches errors from the snapshot store and the database,
 * whose messages were never written to be shown to a browser either. Only what
 * is thrown as this class is quoted; everything else gets the standing notice.
 */
class MetaAccountsClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAccountsClientError";
  }
}

function clientSafeErrorMessage(error: unknown) {
  return error instanceof MetaAccountsClientError
    ? error.message
    : getRefreshNotice(false);
}

function getRefreshNotice(hasSnapshot: boolean) {
  if (hasSnapshot) {
    return "Your accounts list could not be refreshed right now. Showing the last available list.";
  }
  return "We couldn't load your Meta accounts right now. A background sync has been scheduled.";
}

export async function GET(request: NextRequest) {
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

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    const payload = getDemoProviderDiscoveryPayload("meta");
    return NextResponse.json({
      data: payload.data,
      meta: payload.meta,
      notice: payload.notice,
    });
  }

  const integration = await getIntegration(businessId, "meta");
  if (!integration) {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message: "Meta integration not found for this business.",
      },
      { status: 404 }
    );
  }

  try {
    const payload = await resolveProviderDiscoveryPayload({
      businessId,
      provider: "meta",
      refreshRequested: false,
      freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      missingSnapshotNotice:
        "Showing your saved Meta assignments while the full account list is prepared.",
      degradedNotice: getRefreshNotice(true),
      unavailableNotice:
        "Meta ad accounts are being prepared in the background. You can keep using the page without waiting.",
      liveLoader: async () => {
        if (!integration.access_token) {
          throw new MetaAccountsClientError(
            "Meta access token is missing for this business integration.",
          );
        }
        if (
          integration.token_expires_at &&
          new Date(integration.token_expires_at).getTime() <= Date.now()
        ) {
          throw new MetaAccountsClientError(
            "Meta access token has expired. Please reconnect Meta integration.",
          );
        }
        const metaResult = await fetchMetaAdAccounts(integration.access_token as string);
        if (!metaResult.ok || metaResult.body?.error) {
          throw new MetaAccountsClientError(getMetaApiErrorMessage(metaResult));
        }
        return metaResult.normalized.map((account) => ({
          id: account.id,
          name: account.name,
          currency: account.currency ?? undefined,
          timezone: account.timezone ?? undefined,
          isManager: false,
        }));
      },
    });

    return NextResponse.json({
      data: payload.data,
      meta: payload.meta,
      notice: payload.notice,
    });
  } catch (error: unknown) {
    if (error instanceof ProviderAccountSnapshotRefreshError) {
      return NextResponse.json(
        {
          error: "meta_accounts_unavailable",
          message: getRefreshNotice(false),
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error: "meta_api_error",
        message: clientSafeErrorMessage(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
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

  if (await isDemoBusiness(businessId)) {
    const payload = getDemoProviderDiscoveryPayload("meta");
    return NextResponse.json({
      data: payload.data,
      meta: payload.meta,
      notice: payload.notice,
    });
  }

  const integration = await getIntegration(businessId, "meta");
  if (!integration) {
    return NextResponse.json(
      {
        error: "integration_not_found",
        message: "Meta integration not found for this business.",
      },
      { status: 404 },
    );
  }

  const cachedSnapshotBeforeRefresh = readProviderAccountSnapshot({
    businessId,
    provider: "meta",
    freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
  }).catch(() => null);

  const toSnapshotItems = (accounts: Awaited<ReturnType<typeof fetchMetaAdAccounts>>["normalized"]) =>
    accounts.map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency ?? undefined,
      timezone: account.timezone ?? undefined,
      isManager: false,
    }));

  const liveLoader = async () => {
    if (!integration.access_token) {
      throw new MetaAccountsClientError(
        "Meta access token is missing for this business integration.",
      );
    }
    if (
      integration.token_expires_at &&
      new Date(integration.token_expires_at).getTime() <= Date.now()
    ) {
      throw new MetaAccountsClientError(
        "Meta access token has expired. Please reconnect Meta integration.",
      );
    }
    const metaResult = await fetchMetaAdAccounts(integration.access_token as string);
    const businessDiscoveryFailed = (metaResult.businessDiscovery?.errors.length ?? 0) > 0;
    if (businessDiscoveryFailed) {
      const cachedSnapshot = await cachedSnapshotBeforeRefresh;
      const directAccounts = metaResult.normalized.filter((account) => account.source === "direct");
      if (!cachedSnapshot?.accounts.length && directAccounts.length > 0) {
        return toSnapshotItems(directAccounts);
      }
    }

    if (!metaResult.ok || metaResult.body?.error) {
      throw new MetaAccountsClientError(getMetaApiErrorMessage(metaResult));
    }
    return toSnapshotItems(metaResult.normalized);
  };

  try {
    const payload = await refreshProviderDiscoveryPayload({
      businessId,
      provider: "meta",
      freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      reason: "assignment_drawer_manual_refresh",
      liveLoader,
      /*
        ── ROUND 23, ITEM 1 ───────────────────────────────────────────────────
        The generation of the SAME record `integration` came from, so the
        access token `liveLoader` is about to use and the grant this result is
        attributed to are one fact rather than two reads.

        Omitted entirely before. `runSnapshotRefresh` then adopted whichever
        generation existed by the time it claimed, so a reconnect landing
        between this route's token read and the refresh claim let an OLD
        token's account list -- and the timezones in it -- reconcile under the
        NEW grant's authority. Google's equivalent route already captured this;
        Meta's did not.
      */
      expectedConnectionGeneration:
        providerConnectionGenerationTokenFromIntegration(integration),
    });

    return NextResponse.json({
      data: payload.data,
      meta: payload.meta,
      notice: payload.notice,
    });
  } catch (error: unknown) {
    if (error instanceof ProviderAccountSnapshotRefreshError) {
      const cachedPayload = await resolveProviderDiscoveryPayload({
        businessId,
        provider: "meta",
        refreshRequested: false,
        freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
        missingSnapshotNotice:
          "Showing your saved Meta assignments while the full account list is prepared.",
        degradedNotice: getRefreshNotice(true),
        unavailableNotice:
          "Meta ad accounts are being prepared in the background. You can keep using the page without waiting.",
        liveLoader,
      });

      if (cachedPayload.data.length > 0 || cachedPayload.meta.lastKnownGoodAvailable) {
        return NextResponse.json({
          data: cachedPayload.data,
          meta: cachedPayload.meta,
          notice: cachedPayload.notice ?? getRefreshNotice(true),
        });
      }

      return NextResponse.json(
        {
          error: "meta_accounts_unavailable",
          message: getRefreshNotice(false),
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        error: "meta_api_error",
        message: clientSafeErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
