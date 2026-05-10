"use client";

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
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { MetaUiLanguage } from "@/lib/meta/ui-status";
import {
  resolveGoogleAdsSyncStatusPill,
  resolveMetaSyncStatusPill,
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
  onConnect: (provider: IntegrationProvider) => void;
  onReconnect: (provider: IntegrationProvider) => void;
  onRetry: (provider: IntegrationProvider) => void;
  onCancel: (provider: IntegrationProvider) => void;
  onDisconnect: (provider: IntegrationProvider) => void;
  onOpenAssignments: (provider: IntegrationProvider) => void;
}

export function IntegrationsCard({
  provider,
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
        ? resolveGoogleAdsSyncStatusPill(googleSyncStatus)
        : null;
  const showSyncSkeleton =
    (provider === "meta" && metaSyncLoading) ||
    (provider === "google" && googleSyncLoading) ||
    (provider === "shopify" && shopifySyncLoading);
  const syncNoticeClasses =
    syncNoticeTone === "warning"
      ? "border-amber-300/40 bg-amber-50 text-amber-800"
      : syncNoticeTone === "error"
        ? "border-rose-300/40 bg-rose-50 text-rose-800"
        : "border-blue-300/30 bg-blue-50 text-blue-800";

  return (
    <div
      className={cn(
        "group flex h-full flex-col rounded-xl border bg-card/95 p-3 shadow-sm transition-all duration-200",
        "hover:-translate-y-0.5 hover:shadow-md",
        syncActionRequired
          ? "border-amber-200/80 bg-gradient-to-br from-card via-card to-amber-50/50"
          : isReady || isDegraded
          ? "border-emerald-200/70 bg-gradient-to-br from-card via-card to-emerald-50/50"
          : isLoading || isNeedsAssignment
            ? "border-sky-200/80 bg-gradient-to-br from-card via-card to-sky-50/50"
            : isActionRequired
              ? "border-amber-200/80 bg-gradient-to-br from-card via-card to-amber-50/50"
              : "border-border/70 bg-gradient-to-br from-card via-card to-muted/25",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-white dark:bg-muted/50">
            {logoSrc ? (
              <Image src={logoSrc} alt={providerLabel} width={20} height={20} className="object-contain" />
            ) : null}
          </div>
          <div className="min-w-0 space-y-0.5">
            <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
              {providerLabel}
            </h2>
            <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <StatusBadge status={visualStatus} />
      </div>

      <div className="mt-3 grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <CompactMetaRow label="Connection" value={view.connectionLabel} />
        <CompactMetaRow label={view.detailLabel} value={view.detailValue} />
        <CompactMetaRow label={view.lastSyncLabel} value={formatDisplayValue(view.lastSyncValue)} />
        <CompactMetaRow label={view.accountLabel} value={view.accountValue} />
      </div>

      {view.notice ? (
        <p className="mt-2 rounded-lg border border-sky-300/30 bg-sky-50 px-2.5 py-2 text-[11px] leading-4 text-sky-800">
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
        <p className={cn("mt-2 rounded-lg px-2.5 py-2 text-[11px] leading-4", syncNoticeClasses)}>
          {syncNotice}
        </p>
      ) : null}

      {isNeedsAssignment ? (
        <p className="mt-2 rounded-lg border border-sky-300/30 bg-sky-50 px-2.5 py-2 text-[11px] leading-4 text-sky-800">
          {view.assignedSummary}
        </p>
      ) : null}

      {syncActionRequired && view.status !== "action_required" ? (
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-800">
          {providerLabel} sync needs attention while the account connection remains active.
        </p>
      ) : null}

      {isActionRequired && view.errorMessage ? (
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-50 px-2.5 py-2 text-[11px] leading-4 text-amber-800">
          {view.errorMessage}
        </p>
      ) : null}

      <div className="mt-3 border-t border-border/70 pt-3">
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
              <Button size="sm" variant="outline" onClick={() => onReconnect(provider)}>
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
              <Button size="sm" variant="outline" onClick={() => onReconnect(provider)}>
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
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProviderViewState["status"] }) {
  if (status === "ready") {
    return (
      <Badge className="border border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
        Connected
      </Badge>
    );
  }
  if (status === "degraded") {
    return <Badge className="border border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">Degraded</Badge>;
  }
  if (status === "loading_data") {
    return <Badge className="border border-sky-200 bg-sky-50 text-[10px] text-sky-700">Loading</Badge>;
  }
  if (status === "needs_assignment") {
    return <Badge className="border border-sky-200 bg-sky-50 text-[10px] text-sky-700">Needs setup</Badge>;
  }
  if (status === "action_required") {
    return <Badge className="border border-amber-200 bg-amber-50 text-[10px] text-amber-800">Action required</Badge>;
  }
  return <Badge className="border border-border bg-muted text-[10px] text-muted-foreground">Not connected</Badge>;
}

function CompactMetaRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-2 text-xs">
      <p className="font-medium text-muted-foreground">{label}:</p>
      <p className="truncate font-medium text-foreground">{value}</p>
    </div>
  );
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
    <div className="mt-2 rounded-lg border border-border/70 bg-white/70 px-2.5 py-2 text-[11px] leading-4 dark:bg-muted/30">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="tracking-[0.18em] text-[10px] font-semibold uppercase text-muted-foreground">
            Shopify sync
          </p>
          <p className="mt-1 text-foreground">{summary.message}</p>
        </div>
        <Badge className={cn("shrink-0 border text-[10px]", summary.badgeClass)}>
          {summary.label}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
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
      badgeClass: "border-sky-200 bg-sky-50 text-sky-700",
      message:
        "Recent Shopify commerce data is usable while historical coverage continues in the background.",
    };
  }
  if (status.state === "syncing") {
    return {
      label: "Syncing",
      badgeClass: "border-sky-200 bg-sky-50 text-sky-700",
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

function getProviderLogo(provider: IntegrationProvider): string | null {
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
