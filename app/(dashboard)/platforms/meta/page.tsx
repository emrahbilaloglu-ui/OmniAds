"use client";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";
import { useAppStore } from "@/store/app-store";

export default function MetaPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <MetaPlatformPage
      businessId={selectedBusinessId}
      businessName={business?.name}
      currency={business?.currency}
    />
  );
}
