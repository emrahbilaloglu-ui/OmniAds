"use client";

import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GoogleIntegrationProgress } from "@/components/integrations/google-integration-progress";
import { getProviderLabel } from "@/components/integrations/oauth";
import { MetaIntegrationProgress } from "@/components/integrations/meta-integration-progress";
import {
  SyncStatusPill,
  SyncStatusPillSkeleton,
} from "@/components/sync/sync-status-pill";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import { resolveGoogleAdsFreshnessView } from "@/lib/google-ads/sync-progress-ux";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import {
  resolveGoogleAdsSyncStatusPill,
  resolveMetaSyncStatusPill,
  type SyncStatusPillState,
} from "@/lib/sync/sync-status-pill";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import { cn } from "@/lib/utils";
import {
  IntegrationProvider,
  ProviderViewState,
} from "@/store/integrations-store";
import { Loader2 } from "lucide-react";
import Image from "next/image";

interface IntegrationsCardProps {
  provider: IntegrationProvider;
  /**
   * The business this connection belongs to.
   *
   * Required for the recovery-started event. It used to be emitted with
   * portfolio scope while its completed half is business-scoped, so the two
   * ends of the pair could never be joined and the recovery rate was
   * unmeasurable -- the exact thing the pair exists to measure.
   */
  businessId: string | null;
  language?: MetaUiLanguage;
  description: string;
  view: ProviderViewState;
  syncNotice?: string | null;
  syncNoticeTone?: "info" | "warning" | "error";
  metaSyncStatus?: MetaStatusResponse | null;
  metaSyncLoading?: boolean;
  googleSyncStatus?: GoogleAdsStatusResponse | null;
  googleSyncLoading?: boolean;
  shopifySyncStatus?: ShopifyStatusResponse | null;
  shopifySyncLoading?: boolean;
  /** True when the provider has no live OAuth/backend yet — the card shows an honest
   *  "coming soon" state instead of a Connect button that would 404 or fake a handshake. */
  comingSoon?: boolean;
  onConnect: (provider: IntegrationProvider) => void;
  onReconnect: (provider: IntegrationProvider) => void;
  onRetry: (provider: IntegrationProvider) => void;
  onCancel: (provider: IntegrationProvider) => void;
  onDisconnect: (provider: IntegrationProvider) => void;
  onOpenAssignments: (provider: IntegrationProvider) => void;
}

export function IntegrationsCard({
  provider,
  businessId,
  language = "en",
  description,
  view,
  syncNotice,
  syncNoticeTone = "info",
  metaSyncStatus,
  metaSyncLoading = false,
  googleSyncStatus,
  googleSyncLoading = false,
  shopifySyncStatus,
  shopifySyncLoading = false,
  comingSoon = false,
  onConnect,
  onReconnect,
  onRetry,
  onCancel,
  onDisconnect,
  onOpenAssignments,
}: IntegrationsCardProps) {
  const providerLabel = getProviderLabel(provider);
  const isDisconnected = view.status === "disconnected";
  const isLoading = view.status === "loading_data";
  const isNeedsAssignment = view.status === "needs_assignment";
  const isReady = view.status === "ready";
  const isDegraded = view.status === "degraded";
  const isActionRequired = view.status === "action_required";
  const syncActionRequired =
    (provider === "meta" && metaSyncStatus?.state === "action_required") ||
    (provider === "google" && googleSyncStatus?.state === "action_required");
  const visualStatus = syncActionRequired ? "action_required" : view.status;
  const isShopify = provider === "shopify";
  const logoSrc = getProviderLogo(provider);
  const syncPill =
    provider === "meta"
      ? resolveMetaSyncStatusPill(metaSyncStatus)
      : provider === "google"
        ? withGoogleFreshnessTruth(
            resolveGoogleAdsSyncStatusPill(googleSyncStatus),
            googleSyncStatus,
          )
        : null;
  const showSyncSkeleton =
    (provider === "meta" && metaSyncLoading) ||
    (provider === "google" && googleSyncLoading) ||
    (provider === "shopify" && shopifySyncLoading);
  const metaLine = [
    view.connectionLabel,
    view.detailValue ? `${view.detailLabel} ${view.detailValue}` : null,
    view.lastSyncValue ? `${view.lastSyncLabel} ${formatDisplayValue(view.lastSyncValue)}` : null,
    view.accountValue ? `${view.accountLabel} ${view.accountValue}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const syncNoticeClasses =
    syncNoticeTone === "warning"
      ? "border-amber-300/40 bg-amber-50 text-amber-800"
      : syncNoticeTone === "error"
        ? "border-rose-300/40 bg-rose-50 text-rose-800"
        : "border-blue-300/30 bg-blue-50 text-blue-800";

  return (
    <div
      className={cn(
        // Card geometry is the design's, to the pixel: 14px radius, 16px pad,
        // white surface. Only the border carries state.
        "group flex h-full flex-col gap-3 rounded-[14px] border bg-[var(--adv-surface)] p-4 transition-colors duration-200",
        syncActionRequired
          ? "border-amber-200"
          : isReady || isDegraded
          ? "border-emerald-200"
          : isLoading || isNeedsAssignment
            ? "border-blue-200"
            : isActionRequired
              ? "border-amber-200"
              : "border-[var(--adv-border)]",
      )}
    >
      <div className="flex items-center gap-[10px]">
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] border border-[var(--adv-border)] bg-[var(--adv-fill-2)]">
          {logoSrc ? (
            <Image src={logoSrc} alt={providerLabel} width={19} height={19} className="object-contain" />
          ) : null}
        </span>
        <h2 className="min-w-0 truncate text-[14.5px] font-semibold text-[var(--adv-ink)]">
          {providerLabel}
        </h2>
        <span className="ml-auto shrink-0">
          {comingSoon ? (
            <span className="inline-flex items-center rounded-full bg-[var(--adv-fill-2)] px-[10px] py-[3px] text-[11px] font-bold text-[var(--adv-ink-3)]">
              Coming soon
            </span>
          ) : (
            <StatusBadge status={visualStatus} />
          )}
        </span>
      </div>

      <p className="text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
        {description}
      </p>


      {view.notice ? (
        <p className="mt-2 rounded-lg border border-blue-300/30 bg-blue-50 px-2.5 py-2 text-[12px] leading-4 text-blue-800">
          {view.notice}
        </p>
      ) : null}

      {showSyncSkeleton ? (
        <div className="mt-2">
          <SyncStatusPillSkeleton className="w-28" />
        </div>
      ) : syncPill?.visible ? (
        <div className="mt-2">
          <SyncStatusPill pill={syncPill} />
        </div>
      ) : null}

      {provider === "meta" && !showSyncSkeleton ? (
        <MetaIntegrationProgress status={metaSyncStatus} language={language} />
      ) : null}

      {provider === "google" && !showSyncSkeleton ? (
        <GoogleIntegrationProgress status={googleSyncStatus} language={language} />
      ) : null}

      {provider === "shopify" && !showSyncSkeleton ? (
        <ShopifyIntegrationStatus status={shopifySyncStatus} />
      ) : null}

      {syncNotice ? (
        <p className={cn("mt-2 rounded-lg px-2.5 py-2 text-[12px] leading-4", syncNoticeClasses)}>
          {syncNotice}
        </p>
      ) : null}

      {isNeedsAssignment ? (
        <p className="mt-2 rounded-lg border border-blue-300/30 bg-blue-50 px-2.5 py-2 text-[12px] leading-4 text-blue-800">
          {view.assignedSummary}
        </p>
      ) : null}

      {syncActionRequired && view.status !== "action_required" ? (
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-50 px-2.5 py-2 text-[12px] leading-4 text-amber-800">
          {providerLabel} sync needs attention while the account connection remains active.
        </p>
      ) : null}

      {isActionRequired && view.errorMessage ? (
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-50 px-2.5 py-2 text-[12px] leading-4 text-amber-800">
          {view.errorMessage}
        </p>
      ) : null}

      {/* The design gives the card one monospace meta line rather than a grid of
          labelled cells. It carries the same four facts, joined -- dropping any
          of them to fit the shape would have been the shape editing the data. */}
      <p
        className="truncate font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]"
        title={metaLine}
      >
        {metaLine}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {comingSoon ? (
          <p className="text-[12px] leading-4 text-[var(--adv-ink-4)]">
            {providerLabel} isn&apos;t connectable yet — no live authorization or data sync
            exists for it. This card is a visible roadmap placeholder, not a working connector.
          </p>
        ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {isDisconnected ? (
            <Button size="sm" className="min-w-[104px]" onClick={() => onConnect(provider)}>
              {view.primaryActionLabel}
            </Button>
          ) : null}

          {isLoading ? (
            <>
              <Button size="sm" className="min-w-[118px] cursor-default" tabIndex={-1}>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading data...
              </Button>
              <Button size="sm" variant="outline" onClick={() => onCancel(provider)}>
                Cancel
              </Button>
            </>
          ) : null}

          {view.isConnected && !isLoading && !isActionRequired ? (
            <>
              <Button
                size="sm"
                className="min-w-[126px]"
                disabled={isShopify}
                tabIndex={isShopify ? -1 : undefined}
                onClick={() => onOpenAssignments(provider)}
              >
                {view.primaryActionLabel}
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                  // Section 9: provider health recovery started. Completion is
                  // recorded by the callback path when the connection lands.
                  emitProductInstrumentation({
                    eventName: "provider_health_recovery_started",
                    surface: "integrations",
                    outcome: "ok",
                    scope: "business",
                    businessId,
                    provider: provider === "google" ? "google" : "meta",
                  });
                  onReconnect(provider);
                }}>
                Reconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="px-2.5 text-muted-foreground hover:text-destructive"
                onClick={() => onDisconnect(provider)}
              >
                Disconnect
              </Button>
            </>
          ) : null}

          {isActionRequired ? (
            <>
              <Button size="sm" className="min-w-[108px]" onClick={() => onRetry(provider)}>
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                  // Section 9: provider health recovery started. Completion is
                  // recorded by the callback path when the connection lands.
                  emitProductInstrumentation({
                    eventName: "provider_health_recovery_started",
                    surface: "integrations",
                    outcome: "ok",
                    scope: "business",
                    businessId,
                    provider: provider === "google" ? "google" : "meta",
                  });
                  onReconnect(provider);
                }}>
                Reconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="px-2.5 text-muted-foreground hover:text-destructive"
                onClick={() => onDisconnect(provider)}
              >
                Disconnect
              </Button>
            </>
          ) : null}
        </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hold the green Google Ads pill to the freshness verdict.
 *
 * `resolveGoogleAdsSyncStatusPill` reaches "Active" — success tone, percent 100
 * — from a closed control plane, a passing release gate or `state === "ready"`.
 * None of those know whether a closed day was ever re-read, and the green pill
 * over a day captured once at 01:40 is the exact artefact this change exists to
 * remove.
 *
 * The bar it must clear is `converging` or `settled`: every day in the range
 * re-read after it closed. Not `settled` alone — with a 30-day conversion
 * lookback a rolling range never settles, so that rule would keep the pill grey
 * forever and teach the user to ignore it. `converging` keeps the green pill
 * but not the 100: the percent is corrected down to the verdict's own number.
 * Anything below the bar is demoted to an honest, non-green, still-moving pill.
 * Attention (amber) and syncing (blue) pills are left untouched — this only
 * ever removes a claim.
 */
function withGoogleFreshnessTruth(
  pill: SyncStatusPillState | null,
  status: GoogleAdsStatusResponse | null | undefined,
): SyncStatusPillState | null {
  if (!pill || pill.state !== "active") return pill;

  const freshness = resolveGoogleAdsFreshnessView(status);
  if (freshness.settled) return pill;
  // Steady but not settled: still healthy, still not 100.
  if (freshness.steady) return { ...pill, percent: freshness.percent };

  return {
    visible: true,
    label: freshness.evidenceAvailable
      ? `${freshness.percent}% ${freshness.label}`
      : `${freshness.label} freshness`,
    tone: "info",
    percent: freshness.evidenceAvailable ? freshness.percent : null,
    state: "syncing",
  };
}

/**
 * The design gives status one shape: a full-radius pill, 3px/10px, 11px bold.
 * Only the two colours change, so a state can never quietly restyle the card.
 */
function StatusBadge({ status }: { status: ProviderViewState["status"] }) {
  if (status === "ready") {
    return (
      <Badge className="rounded-full border-0 bg-emerald-50 px-[10px] py-[3px] text-[11px] font-bold text-emerald-700">
        Connected
      </Badge>
    );
  }
  if (status === "degraded") {
    return <Badge className="rounded-full border-0 bg-emerald-50 px-[10px] py-[3px] text-[11px] font-bold text-emerald-700">Degraded</Badge>;
  }
  if (status === "loading_data") {
    return <Badge className="rounded-full border-0 bg-blue-50 px-[10px] py-[3px] text-[11px] font-bold text-blue-700">Loading</Badge>;
  }
  if (status === "needs_assignment") {
    return <Badge className="rounded-full border-0 bg-blue-50 px-[10px] py-[3px] text-[11px] font-bold text-blue-700">Needs setup</Badge>;
  }
  if (status === "action_required") {
    return <Badge className="rounded-full border-0 bg-amber-50 px-[10px] py-[3px] text-[11px] font-bold text-amber-800">Action required</Badge>;
  }
  return <Badge className="rounded-full border-0 bg-[var(--adv-fill-2)] px-[10px] py-[3px] text-[11px] font-bold text-[var(--adv-ink-3)]">Not connected</Badge>;
}

function formatDisplayValue(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function ShopifyIntegrationStatus({
  status,
}: {
  status?: ShopifyStatusResponse | null;
}) {
  if (!status || !status.connected) return null;

  const summary = resolveShopifyStatusSummary(status);
  const readyThrough =
    status.sync?.ordersHistorical?.readyThroughDate ??
    status.sync?.returnsHistorical?.readyThroughDate ??
    null;
  const latestSync =
    status.sync?.ordersRecent?.latestSuccessfulSyncAt ??
    status.sync?.returnsRecent?.latestSuccessfulSyncAt ??
    null;
  const orderCount = status.warehouse?.orderRowCount ?? null;

  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-white/70 px-2.5 py-2 text-[12px] leading-4 dark:bg-muted/30">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="tracking-[0.18em] text-[12px] font-semibold uppercase text-muted-foreground">
            Shopify sync
          </p>
          <p className="mt-1 text-foreground">{summary.message}</p>
        </div>
        <Badge className={cn("shrink-0 border text-[12px]", summary.badgeClass)}>
          {summary.label}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        {readyThrough ? <span>Ready through {readyThrough}</span> : null}
        {latestSync ? <span>Last sync {new Date(latestSync).toLocaleDateString()}</span> : null}
        {orderCount !== null ? <span>{orderCount.toLocaleString()} orders</span> : null}
      </div>
    </div>
  );
}

function resolveShopifyStatusSummary(status: ShopifyStatusResponse) {
  if (status.state === "ready") {
    return {
      label: "Ready",
      badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
      message: "Shopify commerce data and historical backfill are ready.",
    };
  }
  if (status.state === "partial") {
    return {
      label: "Backfilling",
      badgeClass: "border-blue-200 bg-blue-50 text-blue-700",
      message:
        "Recent Shopify commerce data is usable while historical coverage continues in the background.",
    };
  }
  if (status.state === "syncing") {
    return {
      label: "Syncing",
      badgeClass: "border-blue-200 bg-blue-50 text-blue-700",
      message: "Shopify commerce data is syncing.",
    };
  }
  if (status.state === "stale") {
    return {
      label: "Refreshing",
      badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
      message: "Shopify data is being refreshed from the latest available sync state.",
    };
  }
  return {
    label: "Needs attention",
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    message: status.issues[0] ?? "Shopify sync needs attention before data can be trusted.",
  };
}

/** Shared with the roadmap cards, which show the same marks greyed out. */
export function getProviderLogo(provider: IntegrationProvider): string | null {
  switch (provider) {
    case "meta": return "/platform-logos/Meta.png";
    case "google": return "/platform-logos/googleAds.svg";
    case "ga4": return "/platform-logos/GA4.svg";
    case "search_console": return "/platform-logos/searchconsole.svg";
    case "shopify": return "/platform-logos/shopify_glyph.svg";
    case "tiktok": return "/platform-logos/tiktok.svg";
    case "pinterest": return "/platform-logos/Pinterest.svg";
    case "snapchat": return "/platform-logos/snapchat.svg";
    case "klaviyo": return "/platform-logos/Klaviyo.svg";
    default: return null;
  }
}
