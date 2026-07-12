"use client";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
// MetaPlatformPage is intentionally kept on disk (other surfaces may still
// reference it) but is no longer rendered from this route — the owner chose to
// supersede the old Decisions surface with the Meta OS DecisionsOsView.
import { DecisionsOsView } from "@/components/meta/os/DecisionsOsView";
import { useAppStore } from "@/store/app-store";

export default function MetaPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <DecisionsOsView
      businessId={selectedBusinessId}
      businessName={business?.name}
      currency={business?.currency}
    />
  );
}
