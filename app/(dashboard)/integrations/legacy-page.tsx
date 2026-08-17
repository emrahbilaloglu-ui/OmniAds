"use client";

import { measuredAsOf, newestObservation } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/app-store";
import {
  IntegrationProvider,
  useIntegrationsStore,
} from "@/store/integrations-store";
import { deriveProviderViewStates } from "@/store/integrations-support";
import {
  IntegrationsExact,
  IntegrationsExactSkeleton,
} from "@/components/integrations/IntegrationsExact";
import {
  buildIntegrationsExactModel,
  INTEGRATIONS_LIVE_ORDER,
} from "@/components/integrations/integrations-exact-adapter";
import { getProviderLogo } from "@/components/integrations/provider-logos";
import { useIntegrationConnection } from "@/hooks/use-integration-connection";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { ProviderAssignmentDrawer } from "@/components/integrations/provider-assignment-drawer";
import { GA4PropertyPicker } from "@/components/integrations/ga4-property-picker";
import { getOAuthStartUrl } from "@/components/integrations/oauth";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import { getGoogleAdsStatusRefetchInterval } from "@/lib/google-ads/sync-progress-ux";

/** Providers that have real backend OAuth (not mock) */
const REAL_PROVIDERS: IntegrationProvider[] = [
  "shopify",
  "meta",
  "google",
  "ga4",
  "search_console",
];

/**
 * Providers a user can actually authorize right now — each has a real flow
 * (OAuth start route, or Shopify's app-store install). Klaviyo is deliberately
 * absent: `app/api/oauth/klaviyo/start` answers 501 rather than fabricating a
 * connection, so its card renders no button at all instead of one that fails.
 */
const CONNECTABLE_PROVIDERS: IntegrationProvider[] = [
  "meta",
  "google",
  "ga4",
  "search_console",
  "shopify",
];

interface SearchConsoleProperty {
  siteUrl: string;
  permissionLevel?: string;
  siteType?: "domain" | "url-prefix";
}

async function fetchMetaStatus(businessId: string): Promise<MetaStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/meta/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Meta status request failed (${response.status})`
    );
  }
  return payload as MetaStatusResponse;
}

async function fetchGoogleAdsStatus(
  businessId: string
): Promise<GoogleAdsStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/google-ads/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Google Ads status request failed (${response.status})`
    );
  }
  return payload as GoogleAdsStatusResponse;
}

async function fetchShopifyStatus(
  businessId: string
): Promise<ShopifyStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/shopify/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Shopify status request failed (${response.status})`
    );
  }
  return payload as ShopifyStatusResponse;
}

function getMetaStatusRefetchInterval(status: MetaStatusResponse | undefined) {
  const state = status?.state;
  const priorityWindowReady =
    (status?.priorityWindow?.totalDays ?? 0) > 0 &&
    (status?.priorityWindow?.completedDays ?? 0) >=
      (status?.priorityWindow?.totalDays ?? 0);
  const coreReady = status?.coreReadiness?.complete === true;
  const backgroundExtendedLagOnly =
    coreReady &&
    priorityWindowReady &&
    Boolean(
      status?.extendedCompleteness &&
        !status.extendedCompleteness.complete &&
        status.extendedCompleteness.state !== "blocked"
    );
  if (state === "syncing") {
    if (coreReady && priorityWindowReady && status?.extendedCompleteness?.complete) {
      return (status?.jobHealth?.queueDepth ?? 0) > 0 ||
        (status?.jobHealth?.leasedPartitions ?? 0) > 0
        ? 10_000
        : false;
    }
    if (backgroundExtendedLagOnly) {
      return (status?.jobHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
        (status?.jobHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0
        ? 30_000
        : false;
    }
    return 5_000;
  }
  if (state === "partial") {
    if (backgroundExtendedLagOnly) {
      return (status?.jobHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
        (status?.jobHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0
        ? 30_000
        : false;
    }
    return 10_000;
  }
  if (
    state === "paused" ||
    state === "stale" ||
    (status?.jobHealth?.queueDepth ?? 0) > 0 ||
    (status?.jobHealth?.leasedPartitions ?? 0) > 0
  ) {
    return 10_000;
  }
  return false;
}

function getShopifyStatusRefetchInterval(status: ShopifyStatusResponse | undefined) {
  if (!status?.connected) return false;
  if (status.state === "ready") return 60_000;
  if (status.state === "partial" || status.state === "syncing" || status.state === "stale") {
    return 15_000;
  }
  return 30_000;
}

function hasRenderableProviderViews(
  cards: Array<{ status: string; isConnected: boolean; assignedCount: number }>,
) {
  return cards.some(
    (card) => card.isConnected || card.assignedCount > 0 || card.status !== "disconnected",
  );
}

export default function IntegrationsPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId;

  const byBusinessId = useIntegrationsStore((state) => state.byBusinessId);
  const domainsByBusinessId = useIntegrationsStore((state) => state.domainsByBusinessId);
  const assignedAccountsByBusiness = useIntegrationsStore(
    (state) => state.assignedAccountsByBusiness,
  );
  const setConnected = useIntegrationsStore((state) => state.setConnected);
  const disconnect = useIntegrationsStore((state) => state.disconnect);
  const setAssignedAccounts = useIntegrationsStore(
    (state) => state.setAssignedAccounts,
  );
  const setProviderAccounts = useIntegrationsStore(
    (state) => state.setProviderAccounts,
  );

  const { isBootstrapping } = useBusinessIntegrationsBootstrap(businessId ?? null);

  const [assignmentProvider, setAssignmentProvider] =
    useState<IntegrationProvider | null>(null);
  const [ga4PickerOpen, setGa4PickerOpen] = useState(false);
  const [ga4PropertyInfo, setGa4PropertyInfo] = useState<{
    propertyId: string;
    propertyName: string;
  } | null>(null);

  const [isPropertySelectorOpen, setIsPropertySelectorOpen] = useState(false);
  const [isLoadingProperties, setIsLoadingProperties] = useState(false);
  const [isSavingProperty, setIsSavingProperty] = useState(false);
  const [propertyError, setPropertyError] = useState<string | null>(null);
  const [properties, setProperties] = useState<SearchConsoleProperty[]>([]);
  const [selectedPropertyUrl, setSelectedPropertyUrl] = useState("");
  const [viewStateLogCache] = useState(() => new Map<string, string>());

  const integrations = useMemo(() => {
    if (!businessId) return null;
    return byBusinessId[businessId];
  }, [byBusinessId, businessId]);
  const domains = useMemo(() => {
    if (!businessId) return undefined;
    return domainsByBusinessId[businessId];
  }, [businessId, domainsByBusinessId]);
  const providerViews = useMemo(() => deriveProviderViewStates(domains), [domains]);
  const hasRenderableData = useMemo(
    () => hasRenderableProviderViews(providerViews),
    [providerViews],
  );
  const searchConsoleState = integrations?.search_console;
  const metaStatusQuery = useQuery({
    queryKey: ["meta-sync-status", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getMetaStatusRefetchInterval(query.state.data as MetaStatusResponse | undefined),
    queryFn: () => fetchMetaStatus(businessId!),
  });
  const googleAdsStatusQuery = useQuery({
    queryKey: ["google-ads-sync-status", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getGoogleAdsStatusRefetchInterval(
        query.state.data as GoogleAdsStatusResponse | undefined
      ),
    queryFn: () => fetchGoogleAdsStatus(businessId!),
  });
  const shopifyStatusQuery = useQuery({
    queryKey: ["shopify-sync-status", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getShopifyStatusRefetchInterval(
        query.state.data as ShopifyStatusResponse | undefined
      ),
    queryFn: () => fetchShopifyStatus(businessId!),
  });

  useTierZeroFreshness({
    surface: "integrations",
    businessId,
    isLoading: metaStatusQuery.isLoading,
    isFetching: metaStatusQuery.isFetching,
    error: metaStatusQuery.error,
    // A provider we could not read is a hole in the picture, not a healthy
    // provider: say which one rather than showing a confident row.
    partialReason:
      googleAdsStatusQuery.error || shopifyStatusQuery.error
        ? "Some providers could not be read; connection status is incomplete"
        : null,
    // Each provider's own last sync. `dataUpdatedAt` would report when the
    // status request returned, which says nothing about the provider data.
    asOf: newestObservation([
      measuredAsOf(metaStatusQuery.data?.latestSync?.finishedAt),
      measuredAsOf(googleAdsStatusQuery.data?.latestSync?.finishedAt),
    ]),
    onRetry: () => {
      void metaStatusQuery.refetch();
      if (googleAdsStatusQuery.isError) void googleAdsStatusQuery.refetch();
      if (shopifyStatusQuery.isError) void shopifyStatusQuery.refetch();
    },
  });

  const closeSearchConsoleSelector = useCallback(() => {
    setIsPropertySelectorOpen(false);
    setIsLoadingProperties(false);
    setIsSavingProperty(false);
    setPropertyError(null);
    setProperties([]);
  }, []);

  const openSearchConsoleSelector = useCallback(async () => {
    if (!businessId || !integrations) return;
    setPropertyError(null);
    setIsLoadingProperties(true);
    setIsPropertySelectorOpen(true);
    try {
      const response = await fetch(
        `/api/google-search-console/sites?businessId=${encodeURIComponent(businessId)}`,
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPropertyError(
          (payload as { message?: string } | null)?.message ??
            "Could not load Search Console properties.",
        );
        setProperties([]);
        return;
      }

      const rows = Array.isArray((payload as { sites?: unknown[] } | null)?.sites)
        ? ((payload as { sites: SearchConsoleProperty[] }).sites ?? [])
        : [];
      setProperties(rows);
      const existingProperty =
        searchConsoleState?.providerAccountName ??
        searchConsoleState?.providerAccountId ??
        "";
      setSelectedPropertyUrl(existingProperty || rows[0]?.siteUrl || "");
    } catch {
      setProperties([]);
      setPropertyError("Could not load Search Console properties.");
    } finally {
      setIsLoadingProperties(false);
    }
  }, [businessId, integrations, searchConsoleState]);

  const loadGa4PropertyInfo = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(
        `/api/integrations?businessId=${encodeURIComponent(businessId)}&provider=ga4`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const integration = data.integration;
      if (!integration) {
        setGa4PropertyInfo(null);
        return;
      }
      const metadata = integration.metadata;
      if (metadata?.ga4PropertyId && metadata?.ga4PropertyName) {
        setGa4PropertyInfo({
          propertyId: metadata.ga4PropertyId,
          propertyName: metadata.ga4PropertyName,
        });
        return;
      }
      setGa4PropertyInfo(null);
    } catch {
      // silent
    }
  }, [businessId]);

  const saveSearchConsoleProperty = useCallback(async () => {
    if (!businessId || !integrations || !selectedPropertyUrl) return;
    setIsSavingProperty(true);
    setPropertyError(null);
    try {
      const response = await fetch(
        `/api/google-search-console/select-site`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            siteUrl: selectedPropertyUrl,
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPropertyError(
          (payload as { message?: string } | null)?.message ??
            "Could not save selected property.",
        );
        return;
      }

      const integration = (
        payload as {
          integration?: {
            id?: string;
            connected_at?: string | null;
            updated_at?: string | null;
            provider_account_id?: string | null;
            provider_account_name?: string | null;
          };
        }
      ).integration;

      setConnected(
        businessId,
        "search_console",
        integration?.id ?? searchConsoleState?.integrationId,
        {
          connectedAt:
            integration?.connected_at ?? searchConsoleState?.connectedAt,
          lastSyncAt: integration?.updated_at ?? new Date().toISOString(),
          providerAccountId:
            integration?.provider_account_id ?? selectedPropertyUrl,
          providerAccountName:
            integration?.provider_account_name ?? selectedPropertyUrl,
        },
      );
      closeSearchConsoleSelector();
    } catch {
      setPropertyError("Could not save selected property.");
    } finally {
      setIsSavingProperty(false);
    }
  }, [
    businessId,
    closeSearchConsoleSelector,
    integrations,
    searchConsoleState,
    selectedPropertyUrl,
    setConnected,
  ]);

  /** Disconnect: calls backend API for real providers, then updates local store */
  const handleDisconnect = useCallback(
    async (provider: IntegrationProvider) => {
      if (!businessId) return;
      if (REAL_PROVIDERS.includes(provider)) {
        try {
          await fetch(
            `/api/integrations?businessId=${encodeURIComponent(businessId)}&provider=${provider}`,
            { method: "DELETE" },
          );
        } catch {
          // best effort — still disconnect locally
        }
      }
      disconnect(businessId, provider);
      if (provider === "ga4") {
        setGa4PropertyInfo(null);
      }
      if (assignmentProvider === provider) {
        setAssignmentProvider(null);
      }
      if (provider === "search_console") {
        closeSearchConsoleSelector();
      }
    },
    [assignmentProvider, businessId, closeSearchConsoleSelector, disconnect],
  );

  useEffect(() => {
    if (!businessId) return;
    void loadGa4PropertyInfo();
  }, [businessId, loadGa4PropertyInfo]);

  useEffect(() => {
    if (!businessId) return;
    for (const view of providerViews) {
      const previous = viewStateLogCache.get(view.provider);
      if (previous === view.status) continue;
      viewStateLogCache.set(view.provider, view.status);
      logClientAuthEvent("provider_view_state_changed", {
        businessId,
        provider: view.provider,
        status: view.status,
        assignedCount: view.assignedCount,
      });
    }
  }, [businessId, providerViews, viewStateLogCache]);

  const viewsByProvider = useMemo(() => {
    const map: Partial<Record<IntegrationProvider, (typeof providerViews)[number]>> = {};
    for (const view of providerViews) map[view.provider] = view;
    return map;
  }, [providerViews]);

  const model = useMemo(
    () =>
      buildIntegrationsExactModel({
        views: viewsByProvider,
        metaStatus: metaStatusQuery.data ?? null,
        googleStatus: googleAdsStatusQuery.data ?? null,
        shopifyStatus: shopifyStatusQuery.data ?? null,
        connectableProviders: CONNECTABLE_PROVIDERS,
        logoFor: getProviderLogo,
      }),
    [
      googleAdsStatusQuery.data,
      metaStatusQuery.data,
      shopifyStatusQuery.data,
      viewsByProvider,
    ],
  );

  const returnTo = useMemo(() => {
    const search = searchParams.toString();
    if (!pathname || pathname === "/") return "/integrations";
    return `${pathname}${search ? `?${search}` : ""}`;
  }, [pathname, searchParams]);

  /**
   * The design gives each card one button and one click. Connect goes straight
   * to the provider handshake — there is no interstitial permissions dialog —
   * and Manage opens whatever destination that provider actually has.
   */
  const handleCardAction = useCallback(
    (provider: IntegrationProvider, kind: "connect" | "manage") => {
      if (!businessId) return;
      if (kind === "connect") {
        // Section 9: provider health recovery started. The design folds
        // Reconnect and Retry into this one button, so a Connect click on a
        // provider that already has a broken connection is the recovery start.
        // Completion is recorded by the callback path when the connection lands.
        const view = viewsByProvider[provider];
        if (
          (provider === "google" || provider === "meta") &&
          view &&
          view.status === "action_required"
        ) {
          emitProductInstrumentation({
            eventName: "provider_health_recovery_started",
            surface: "integrations",
            outcome: "ok",
            scope: "business",
            businessId,
            provider,
          });
        }
        window.location.href =
          provider === "shopify"
            ? "https://apps.shopify.com/adsecute"
            : getOAuthStartUrl(provider, businessId, returnTo);
        return;
      }
      if (provider === "ga4") {
        setGa4PickerOpen(true);
        return;
      }
      if (provider === "search_console") {
        void openSearchConsoleSelector();
        return;
      }
      setAssignmentProvider(provider);
    },
    [businessId, openSearchConsoleSelector, returnTo, viewsByProvider],
  );

  const isWorkspaceLoading =
    !hasHydrated || authBootstrapStatus === "loading" || authBootstrapStatus === "idle";

  if (!businessId && isWorkspaceLoading) {
    return <IntegrationsExactSkeleton cardCount={INTEGRATIONS_LIVE_ORDER.length} />;
  }
  if (!businessId) return <BusinessEmptyState />;
  if ((!integrations || !domains) && isBootstrapping) {
    return <IntegrationsExactSkeleton cardCount={INTEGRATIONS_LIVE_ORDER.length} />;
  }
  if (isBootstrapping && !hasRenderableData) {
    return <IntegrationsExactSkeleton cardCount={INTEGRATIONS_LIVE_ORDER.length} />;
  }

  const assignedIdsForDrawer = assignmentProvider
    ? (assignedAccountsByBusiness[businessId]?.[assignmentProvider] ?? [])
    : [];

  return (
    <>
      <IntegrationsExact model={model} onAction={handleCardAction} />

      <ProviderAssignmentDrawer
        open={Boolean(assignmentProvider)}
        provider={assignmentProvider}
        businessId={businessId}
        assignedAccountIds={assignedIdsForDrawer}
        onClose={() => setAssignmentProvider(null)}
        onDisconnect={(provider) => {
          setAssignmentProvider(null);
          void handleDisconnect(provider);
        }}
        onSave={(provider, accountIds, accounts) => {
          const normalizedAccounts = accounts.map((account) => ({
            id: account.id,
            name: account.name,
            currency: account.currency,
            timezone: account.timezone,
            isManager: account.isManager,
          }));
          setProviderAccounts(businessId, provider, normalizedAccounts);
          setAssignedAccounts(businessId, provider, accountIds);
        }}
      />

      <GA4PropertyPicker
        open={ga4PickerOpen}
        businessId={businessId}
        currentPropertyId={ga4PropertyInfo?.propertyId ?? null}
        onClose={() => setGa4PickerOpen(false)}
        onDisconnect={() => {
          setGa4PickerOpen(false);
          void handleDisconnect("ga4");
        }}
        onSave={(property) => {
          setConnected(
            businessId,
            "ga4",
            integrations?.ga4?.integrationId,
            {
              lastSyncAt: new Date().toISOString(),
              providerAccountId: property.propertyId,
              providerAccountName: property.propertyName,
            },
          );
          setGa4PropertyInfo({
            propertyId: property.propertyId,
            propertyName: property.propertyName,
          });
        }}
      />

      {isPropertySelectorOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,18,22,0.32)] p-4">
          <div className="w-full max-w-xl rounded-lg border border-[var(--adc-b2)] bg-[var(--adc-s2)] p-5">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">
                Select Search Console Property
              </h3>
              <p className="text-sm text-[var(--adc-ink3)]">
                Choose the property Adsecute should use for Search Console sync.
              </p>
            </div>

            <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded-lg border p-3">
              {isLoadingProperties ? (
                <p className="text-sm text-[var(--adc-ink3)]">
                  Loading properties...
                </p>
              ) : properties.length === 0 ? (
                <p className="text-sm text-[var(--adc-ink3)]">
                  No Search Console properties found for this connection.
                </p>
              ) : (
                properties.map((property) => (
                  <label
                    key={property.siteUrl}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="radio"
                      name="search-console-property"
                      checked={selectedPropertyUrl === property.siteUrl}
                      onChange={() => setSelectedPropertyUrl(property.siteUrl)}
                    />
                    <span className="font-medium">{property.siteUrl}</span>
                  </label>
                ))
              )}
            </div>

            {propertyError ? (
              <p className="mt-3 rounded-md border border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] px-3 py-2 text-xs text-[var(--adc-danger-fg)]">
                {propertyError}
              </p>
            ) : null}

            <div className="mt-5 flex items-center gap-2">
              <Button
                variant="ghost"
                className="px-2.5 text-muted-foreground hover:text-destructive"
                disabled={isSavingProperty}
                onClick={() => {
                  closeSearchConsoleSelector();
                  void handleDisconnect("search_console");
                }}
              >
                Disconnect
              </Button>
              <span className="flex-1" />
              <Button
                variant="outline"
                onClick={closeSearchConsoleSelector}
                disabled={isSavingProperty}
              >
                Cancel
              </Button>
              <Button
                onClick={saveSearchConsoleProperty}
                disabled={
                  isLoadingProperties || isSavingProperty || !selectedPropertyUrl
                }
              >
                {isSavingProperty ? "Saving..." : "Save Property"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
