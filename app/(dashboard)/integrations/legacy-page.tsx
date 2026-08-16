"use client";

import { measuredAsOf, newestObservation } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBanner } from "@/components/ui/product-surface";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import {
  IntegrationProvider,
  useIntegrationsStore,
} from "@/store/integrations-store";
import { deriveProviderViewStates } from "@/store/integrations-support";
import { IntegrationsCard, getProviderLogo } from "@/components/integrations/integrations-card";
import { SoonCard } from "@/components/integrations/soon-card";
import { ConnectModal } from "@/components/integrations/connect-modal";
import { useIntegrationConnection } from "@/hooks/use-integration-connection";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { ProviderAssignmentDrawer } from "@/components/integrations/provider-assignment-drawer";
import { GA4PropertyPicker } from "@/components/integrations/ga4-property-picker";
import { getProviderLabel } from "@/components/integrations/oauth";
import { logClientAuthEvent } from "@/lib/auth-diagnostics";
import { isDemoBusinessId } from "@/lib/demo-business";
import { usePreferencesStore } from "@/store/preferences-store";
import { ArrowRight, Link2 } from "lucide-react";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import { getGoogleAdsStatusRefetchInterval } from "@/lib/google-ads/sync-progress-ux";
import {
  formatMetaDateTime,
  getMetaStatusNotice,
} from "@/lib/meta/ui";

/** Providers that have real backend OAuth (not mock) */
const REAL_PROVIDERS: IntegrationProvider[] = [
  "shopify",
  "meta",
  "google",
  "ga4",
  "search_console",
];

/**
 * Providers a user can actually connect right now — each has a real authorization flow
 * (OAuth start route, or Shopify's app-store install). Providers NOT in this list have no
 * live backend, so their cards render an honest "coming soon" state rather than a Connect
 * button that would 404 (tiktok/pinterest/snapchat) or fake a handshake (klaviyo).
 */
const CONNECTABLE_PROVIDERS: IntegrationProvider[] = [
  "meta",
  "google",
  "ga4",
  "search_console",
  "shopify",
];

const DISPLAY_PROVIDERS: IntegrationProvider[] = [
  "meta",
  "google",
  "ga4",
  "search_console",
  "shopify",
  "klaviyo",
  "tiktok",
  "pinterest",
  "snapchat",
];

const DESCRIPTIONS: Record<IntegrationProvider, string> = {
  shopify: "Sync storefront events and conversion data for attribution.",
  meta: "Connect Ads Manager to import campaigns, ad sets, and spend.",
  google: "Link Google Ads to track performance and sync account data.",
  search_console:
    "Connect Google Search Console to analyze organic search performance and keyword visibility.",
  tiktok: "Pull campaign metrics from TikTok Ads into your dashboard.",
  pinterest: "Import Pinterest Ads performance and audience insights.",
  snapchat: "Connect Snapchat Ads for campaign and creative reporting.",
  ga4: "Connect Google Analytics 4 to enrich landing page and conversion insights.",
  klaviyo:
    "Monitor email and SMS flow performance, campaign revenue, benchmark gaps, and lifecycle recommendations.",
};

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
  const router = useRouter();
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId;
  const activeBusiness =
    businesses.find((item) => item.id === businessId) ?? null;
  const language = usePreferencesStore((state) => state.language);

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
  const toast = useIntegrationsStore((state) => state.toast);
  const setToast = useIntegrationsStore((state) => state.setToast);
  const clearToast = useIntegrationsStore((state) => state.clearToast);

  const { connect, cancel, retry } = useIntegrationConnection(
    businessId ?? "",
  );
  const { isBootstrapping } = useBusinessIntegrationsBootstrap(businessId ?? null);

  const [activeProvider, setActiveProvider] =
    useState<IntegrationProvider | null>(null);
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
  }, [businessId, searchConsoleState]);

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
      setToast({
        type: "success",
        message: "Search Console property selected.",
      });
      closeSearchConsoleSelector();
    } catch {
      setPropertyError("Could not save selected property.");
    } finally {
      setIsSavingProperty(false);
    }
  }, [
    businessId,
    closeSearchConsoleSelector,
    searchConsoleState,
    selectedPropertyUrl,
    setConnected,
    setToast,
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
    if (!toast) return;
    const timeout = setTimeout(() => clearToast(), 3000);
    return () => clearTimeout(timeout);
  }, [toast, clearToast]);

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

  const isWorkspaceLoading =
    !hasHydrated || authBootstrapStatus === "loading" || authBootstrapStatus === "idle";

  if (!businessId && isWorkspaceLoading) {
    return <IntegrationsPageSkeleton />;
  }
  if (!businessId) return <BusinessEmptyState />;
  if ((!integrations || !domains) && isBootstrapping) {
    return <IntegrationsPageSkeleton />;
  }
  if (isBootstrapping && !hasRenderableData) {
    return <IntegrationsPageSkeleton />;
  }

  const handleConnect = (provider: IntegrationProvider) => {
    setActiveProvider(provider);
  };

  const handleRetry = (provider: IntegrationProvider) => {
    retry(provider);
    setActiveProvider(provider);
  };

  const assignedIdsForDrawer = assignmentProvider
    ? (assignedAccountsByBusiness[businessId]?.[assignmentProvider] ?? [])
    : [];
  const providerCards = DISPLAY_PROVIDERS.map((provider) => {
    const view = providerViews.find((item) => item.provider === provider);
    const assignedIds = assignedAccountsByBusiness[businessId]?.[provider] ?? [];
    const domain = domains?.[provider];
    let syncNotice: string | null = null;
    let syncNoticeTone: "info" | "warning" | "error" = "info";
    let metaSyncStatus: MetaStatusResponse | null = null;
    let metaSyncLoading = false;
    let googleSyncStatus: GoogleAdsStatusResponse | null = null;
    let googleSyncLoading = false;
    let shopifySyncStatus: ShopifyStatusResponse | null = null;
    let shopifySyncLoading = false;
    if (provider === "meta") {
      const status = metaStatusQuery.data;
      metaSyncLoading = metaStatusQuery.isLoading && !status;
      metaSyncStatus = status ?? null;
      if (status?.state === "ready" && status.latestSync?.finishedAt) {
        const finishedAt = formatMetaDateTime(status.latestSync.finishedAt, language);
        syncNotice =
          language === "tr"
            ? `Geçmiş veri hazır. Son senkron ${finishedAt ?? status.latestSync.finishedAt} tarihinde tamamlandı.`
            : `Historical data is ready. The last sync finished ${finishedAt ?? status.latestSync.finishedAt}.`;
      } else if (status?.state === "action_required") {
        syncNotice = getMetaStatusNotice(status, language);
        syncNoticeTone = "error";
      } else if (status) {
        syncNotice = getMetaStatusNotice(status, language);
      }
    } else if (provider === "google") {
      const status = googleAdsStatusQuery.data;
      const sourceHealth = domain?.discovery.sourceHealth ?? null;
      googleSyncLoading = googleAdsStatusQuery.isLoading && !status;
      googleSyncStatus = status ?? null;

      if (status?.state === "action_required") {
        syncNotice =
          status.operations?.blockingReasons?.[0]?.detail ??
          status.latestSync?.lastError ??
          "Google Ads sync needs attention before required data can be refreshed.";
        syncNoticeTone = "error";
      } else if (sourceHealth === "healthy_cached") {
        syncNotice =
          domain?.discovery.notice ??
          "Cached accounts available while the latest refresh finishes.";
        syncNoticeTone = "info";
      } else if (sourceHealth === "stale_cached") {
        syncNotice =
          domain?.discovery.notice ?? "Account list may be stale.";
        syncNoticeTone = "warning";
      } else if (status?.domainReadiness?.summary) {
        syncNotice = status.domainReadiness.summary;
      }
    } else if (provider === "shopify") {
      const status = shopifyStatusQuery.data;
      shopifySyncLoading = Boolean(view?.isConnected) && shopifyStatusQuery.isLoading && !status;
      shopifySyncStatus = status ?? null;
    }
    return {
      provider,
      assignedIds,
      view,
      syncNotice,
      syncNoticeTone,
      metaSyncStatus,
      metaSyncLoading,
      googleSyncStatus,
      googleSyncLoading,
      shopifySyncStatus,
      shopifySyncLoading,
    };
  }).filter(
    (item): item is typeof item & { view: NonNullable<typeof item.view> } => Boolean(item.view)
  );

  const isDemoWorkspace = isDemoBusinessId(businessId);
  // A provider is "live" when it has a real authorization flow. Everything else
  // is roadmap, and the design keeps the two apart rather than greying a
  // Connect button that would 404.
  const liveCards = providerCards.filter((item) =>
    CONNECTABLE_PROVIDERS.includes(item.provider),
  );
  const soonCards = providerCards.filter(
    (item) => !CONNECTABLE_PROVIDERS.includes(item.provider),
  );

  return (
    <div className="flex flex-col gap-4">
      {/* The design's header: an eyebrow, the name, and one sentence about how
          sync actually behaves. It replaced the three summary tiles -- counts
          the cards below already state, one card at a time. */}
      <div>
        <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
          Workspace · Data sources
        </p>
        <h1 className="mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold tracking-[-0.02em] text-[var(--adv-ink)]">
          Integrations
        </h1>
        <p className="mt-1.5 max-w-[640px] text-[12.5px] leading-[1.55] text-[var(--adv-ink-3)]">
          Connected sources refresh themselves — a full sync runs nightly at 03:00 ET, deltas
          land continuously. Sync progress appears once: while a new source runs its first
          import.
        </p>
        <p className="mt-2 inline-flex w-fit items-center gap-2 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          {activeBusiness?.name ?? "Unknown business"}
          {isDemoWorkspace ? (
            <span className="rounded-[4px] bg-[var(--adc-caution-bg)] px-1.5 py-[1.5px] text-[9.5px] font-semibold text-[var(--adc-caution-fg)]">
              demo fixtures
            </span>
          ) : null}
        </p>
      </div>

      {toast && (
        <StateBanner
          tone={toast.type === "success" ? "success" : "danger"}
          title={toast.type === "success" ? "Integration updated" : "Integration action failed"}
        >
          {toast.message}
        </StateBanner>
      )}

      {/* One grid, not four titled groups: the design lists every live source
          together and keeps the not-yet-built ones in their own section below,
          so a roadmap card can never sit beside a working one. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {liveCards.map((item) => (
          <IntegrationsCard
            key={item.provider}
            provider={item.provider}
            businessId={selectedBusinessId}
            language={language}
            description={DESCRIPTIONS[item.provider]}
            view={item.view}
            syncNotice={item.syncNotice}
            syncNoticeTone={item.syncNoticeTone}
            metaSyncStatus={item.metaSyncStatus}
            metaSyncLoading={item.metaSyncLoading}
            googleSyncStatus={item.googleSyncStatus}
            googleSyncLoading={item.googleSyncLoading}
            shopifySyncStatus={item.shopifySyncStatus}
            shopifySyncLoading={item.shopifySyncLoading}
            onConnect={handleConnect}
            onReconnect={(p) => setActiveProvider(p)}
            onRetry={handleRetry}
            onCancel={(p) => cancel(p)}
            onDisconnect={(p) => handleDisconnect(p)}
            onOpenAssignments={(p) => {
              if (p === "shopify") {
                return;
              }
              if (p === "ga4") {
                setGa4PickerOpen(true);
                return;
              }
              if (p === "search_console") {
                void openSearchConsoleSelector();
                return;
              }
              if (p === "klaviyo") {
                router.push("/platforms/klaviyo");
                return;
              }
              setAssignmentProvider(p);
            }}
          />
        ))}
      </div>

      {soonCards.length > 0 ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-2.5">
            <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[16px] font-semibold text-[var(--adv-ink)]">
              Coming soon
            </h2>
            <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
              these stay out of the sidebar until the integration is live — never simulated
            </span>
          </div>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {soonCards.map((item) => (
              <SoonCard
                key={item.provider}
                provider={item.provider}
                logoSrc={getProviderLogo(item.provider)}
                note="No live connector yet — no date scheduled."
              />
            ))}
          </div>
        </>
      ) : null}

      <ConnectModal
        provider={activeProvider}
        businessId={businessId}
        onClose={() => setActiveProvider(null)}
        onContinue={(provider) => {
          connect(provider);
          setActiveProvider(null);
        }}
      />

      <ProviderAssignmentDrawer
        open={Boolean(assignmentProvider)}
        provider={assignmentProvider}
        businessId={businessId}
        assignedAccountIds={assignedIdsForDrawer}
        onClose={() => setAssignmentProvider(null)}
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
          setToast({
            type: "success",
            message:
              accountIds.length > 0
                ? `Assignments saved (${accountIds.length}).`
                : "Assignments cleared for this provider.",
          });
        }}
      />

      <GA4PropertyPicker
        open={ga4PickerOpen}
        businessId={businessId}
        currentPropertyId={ga4PropertyInfo?.propertyId ?? null}
        onClose={() => setGa4PickerOpen(false)}
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
          setToast({
            type: "success",
            message: `GA4 property "${property.propertyName}" linked.`,
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

            <div className="mt-5 flex justify-end gap-2">
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
    </div>
  );
}

function IntegrationsPageSkeleton() {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <Skeleton className="h-7 w-40 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-44" />
              <Skeleton className="h-4 w-full max-w-xl" />
              <Skeleton className="h-4 w-4/5 max-w-lg" />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[360px]">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="rounded-xl border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4"
              >
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-4 h-8 w-12" />
                <Skeleton className="mt-3 h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {Array.from({ length: 3 }).map((_, sectionIndex) => (
        <section key={sectionIndex} className="space-y-3">
          <div className="space-y-2">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {Array.from({ length: sectionIndex === 2 ? 1 : 2 }).map((__, cardIndex) => (
              <div
                key={`${sectionIndex}-${cardIndex}`}
                className="rounded-xl border border-[var(--adc-b1)] bg-[var(--adc-s2)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-4 w-72 max-w-full" />
                  </div>
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
                <div className="mt-6 grid gap-3 md:grid-cols-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <div className="mt-4 flex gap-2">
                  <Skeleton className="h-10 w-28 rounded-xl" />
                  <Skeleton className="h-10 w-24 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

