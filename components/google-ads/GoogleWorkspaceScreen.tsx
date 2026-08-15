"use client";

import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { GoogleAdsIntelligenceDashboard } from "@/components/google-ads/GoogleAdsIntelligenceDashboard";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import type { PanelKey } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * Shared shell for the six routed Google Ads surfaces the v2 design defines.
 * Every screen shares the same connection gating and workspace data; only the
 * pinned panel and the page title change.
 */
export function GoogleWorkspaceScreen({
  panel,
  title,
}: {
  panel: PanelKey;
  title: string;
}) {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined,
  );
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null,
  );

  if (!selectedBusinessId) return <BusinessEmptyState />;

  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const googleView = deriveProviderViewState(
    "google",
    domains?.google ?? buildDefaultProviderDomains().google,
  );
  const hasGoogleAccess =
    isDemoBusiness ||
    googleView.isConnected ||
    googleView.status === "action_required" ||
    googleView.status === "degraded" ||
    googleView.status === "needs_assignment";
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      googleView.status === "loading_data" ||
      (bootstrapStatus !== "ready" && !hasGoogleAccess));

  // The page frame owns the gutters, so these surfaces carry no padding of
  // their own and no nested scroll container.
  if (showBootstrapGuard) {
    return <LoadingSkeleton rows={4} />;
  }

  if (!hasGoogleAccess) {
    return (
      <div>
        <IntegrationEmptyState
          providerLabel="Google Ads"
          status={googleView.status === "action_required" ? "error" : "disconnected"}
          title="Connect Google Ads to unlock intelligence"
          description="Link your Google Ads account to see campaign performance, search intelligence, product return, Performance Max asset coverage, budget recommendations, and diagnostics."
        />
      </div>
    );
  }

  return (
    <div>
      <GoogleAdsIntelligenceDashboard
        businessId={selectedBusinessId}
        panel={panel}
        screenTitle={title}
      />
    </div>
  );
}
