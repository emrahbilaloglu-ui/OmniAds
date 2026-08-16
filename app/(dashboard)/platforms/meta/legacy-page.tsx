"use client";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
// MetaPlatformPage and DecisionsOsView are intentionally kept on disk (other
// surfaces still reference them, and DecisionsOsView remains the source of the
// canonical read contract this view consumes) but neither is rendered from this
// route: `/platforms/meta` is the Dashboard v2 Decision Center.
import { DecisionCenterView } from "@/components/meta/decision-center/DecisionCenterView";
import { useAppStore } from "@/store/app-store";

export default function MetaPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <DecisionCenterView
      businessId={selectedBusinessId}
      businessName={business?.name}
      currency={business?.currency}
    />
  );
}
