"use client";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CommercialTruthScreen } from "@/components/commercial-truth/CommercialTruthScreen";
import { useAppStore } from "@/store/app-store";

/**
 * `/commercial-truth` — the Dashboard v2 screen and nothing else.
 *
 * The design draws seven blocks; the screen component owns all of them,
 * including its own header, so this body only resolves the workspace.
 */
export default function CommercialTruthPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;

  if (!selectedBusinessId || !activeBusiness) {
    return <BusinessEmptyState />;
  }

  return <CommercialTruthScreen businessId={selectedBusinessId} />;
}
