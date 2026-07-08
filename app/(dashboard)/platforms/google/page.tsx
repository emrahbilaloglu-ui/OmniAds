"use client";

import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { GoogleAdsIntelligenceDashboard } from "@/components/google-ads/GoogleAdsIntelligenceDashboard";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";

export default function GoogleAdsPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );

  const businessId = selectedBusinessId ?? "";
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null
  );

  if (!selectedBusinessId) return <BusinessEmptyState />;

  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const googleView = deriveProviderViewState(
    "google",
    domains?.google ?? buildDefaultProviderDomains().google
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

  if (showBootstrapGuard) {
    return (
      <div className="p-6">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!hasGoogleAccess) {
    return (
      <div className="p-6">
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
    <div className="h-full overflow-auto p-6">
      <GoogleAdsIntelligenceDashboard businessId={businessId} />
    </div>
  );
}
