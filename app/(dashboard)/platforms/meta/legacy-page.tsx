"use client";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";
import { useAppStore } from "@/store/app-store";

interface MetaPageProps {
  businessId?: string | null;
  businessName?: string | null;
  currency?: string | null;
}

export default function MetaPage({
  businessId: authorizedBusinessId = null,
  businessName: authorizedBusinessName = null,
  currency: authorizedCurrency = null,
}: MetaPageProps = {}) {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = authorizedBusinessId ?? selectedBusinessId;
  const business =
    businesses.find((item) => item.id === businessId) ?? null;

  if (!businessId) return <BusinessEmptyState />;

  return (
    <MetaPlatformPage
      businessId={businessId}
      businessName={authorizedBusinessName ?? business?.name ?? null}
      currency={authorizedCurrency ?? business?.currency ?? null}
    />
  );
}
