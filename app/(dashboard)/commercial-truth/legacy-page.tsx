"use client";

import { useQuery } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CommercialTruthSettingsSection } from "@/components/settings/commercial-truth-settings";
import {
  CommercialChangeHistory,
  CommercialConsumers,
  CommercialRevenueSplit,
  CommercialSpendBands,
  type SpendBandRow,
} from "@/components/settings/commercial-truth-blocks";
import { formatMoney } from "@/components/creatives/money";
import { SettingsStat } from "@/components/settings/settings-section";
import { WorkspaceSurface, WorkspacePill } from "@/components/workspace/workspace-surface";
import { getTranslations } from "@/lib/i18n";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";

/** The pack fields the revenue split reads; everything else stays in the form. */
interface CommercialSnapshotResponse {
  snapshot?: {
    targetPack?: {
      targetRoas?: number | null;
      breakEvenRoas?: number | null;
      costStructure?: {
        cogsPercent: number | null;
        shippingPercent: number | null;
        fulfillmentPercent: number | null;
        paymentProcessingPercent: number | null;
      } | null;
    } | null;
    // The live cost model the decision engine actually reads; the target pack's
    // own cost fields are the operator's override of it.
    costModelContext?: {
      cogsPercent: number | null;
      shippingPercent: number | null;
      feePercent: number | null;
      fixedCost: number | null;
    } | null;
  } | null;
}

interface OverviewSummaryResponse {
  summary?: {
    pins?: Array<{ id: string; value: number | null }>;
  } | null;
}

export default function CommercialTruthPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const language = usePreferencesStore((state) => state.language);
  const navigationTranslations = getTranslations(language).navigation;

  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;

  const { data: commercial } = useQuery<CommercialSnapshotResponse>({
    queryKey: ["commercial-truth-snapshot", selectedBusinessId],
    queryFn: async () => {
      const res = await fetch(
        `/api/business-commercial-settings?businessId=${encodeURIComponent(selectedBusinessId!)}`,
      );
      if (!res.ok) throw new Error("commercial settings fetch failed");
      return res.json();
    },
    enabled: Boolean(selectedBusinessId),
    staleTime: 60 * 1000,
  });

  // Blended MER for the split's ad segment: paid spend over total revenue.
  const { data: overview } = useQuery<OverviewSummaryResponse>({
    queryKey: ["commercial-truth-mer", selectedBusinessId],
    queryFn: async () => {
      const res = await fetch(
        `/api/overview-summary?businessId=${encodeURIComponent(selectedBusinessId!)}`,
      );
      if (!res.ok) throw new Error("overview summary fetch failed");
      return res.json();
    },
    enabled: Boolean(selectedBusinessId),
    staleTime: 5 * 60 * 1000,
  });

  // Live campaign spend for the band preview — the same rows the Meta surface
  // reads, labelled here against the pack rather than against a stored verdict.
  const { data: campaigns } = useQuery<{ rows?: SpendBandRow[] }>({
    queryKey: ["commercial-truth-bands", selectedBusinessId],
    queryFn: async () => {
      const res = await fetch(
        `/api/meta/campaigns?businessId=${encodeURIComponent(selectedBusinessId!)}`,
      );
      if (!res.ok) throw new Error("campaigns fetch failed");
      return res.json();
    },
    enabled: Boolean(selectedBusinessId),
    staleTime: 5 * 60 * 1000,
  });

  if (!selectedBusinessId || !activeBusiness) {
    return <BusinessEmptyState />;
  }

  const pins = overview?.summary?.pins ?? [];
  const spend = pins.find((pin) => pin.id === "pins-spend")?.value ?? null;
  const revenue = pins.find((pin) => pin.id === "pins-revenue")?.value ?? null;
  const adSpendShare =
    typeof spend === "number" && typeof revenue === "number" && revenue > 0
      ? spend / revenue
      : null;
  const costStructure = commercial?.snapshot?.targetPack?.costStructure ?? null;
  const costModel = commercial?.snapshot?.costModelContext ?? null;
  // Prefer the operator's pack override, fall back to the live cost model.
  const pick = (packValue: number | null | undefined, modelValue: number | null | undefined) =>
    typeof packValue === "number" ? packValue : (modelValue ?? null);
  // Fixed costs are an absolute amount; they only become a share of revenue
  // once the window's revenue is known.
  const fixedCostShare =
    typeof costModel?.fixedCost === "number" &&
    costModel.fixedCost > 0 &&
    typeof revenue === "number" &&
    revenue > 0
      ? costModel.fixedCost / revenue
      : null;

  return (
    <WorkspaceSurface
      eyebrow="Targets & economics"
      title={navigationTranslations.commercialTruth}
      description="The single economic ground truth every decision surface reads. Meta Decisions, Creative Studio and the Google advisor all resolve their thresholds from this pack."
      width="wide"
      meta={<WorkspacePill tone="info">Single source</WorkspacePill>}
      actions={
        <div className="grid gap-3 sm:grid-cols-3">
          <SettingsStat label="Workspace" value={activeBusiness.name} />
          <SettingsStat label="Currency" value={activeBusiness.currency} />
          <SettingsStat
            label="Timezone"
            value={activeBusiness.timezone ?? "Derived from connected sources"}
            tone={activeBusiness.timezone ? "default" : "warning"}
          />
        </div>
      }
    >
      {/* The design frames the pack with its economics on the left and its
          consumers and change log on the right. */}
      <div className="grid items-start gap-3 [grid-template-columns:minmax(0,1.35fr)_minmax(300px,1fr)] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
        <CommercialRevenueSplit
          input={{
            cogsPercent: pick(costStructure?.cogsPercent, costModel?.cogsPercent),
            shippingPercent: pick(costStructure?.shippingPercent, costModel?.shippingPercent),
            fulfillmentPercent: costStructure?.fulfillmentPercent ?? null,
            paymentProcessingPercent: pick(
              costStructure?.paymentProcessingPercent,
              costModel?.feePercent,
            ),
            fixedCostShare,
            adSpendShare,
          }}
        />
        <div className="flex flex-col gap-3 min-w-0">
          <CommercialConsumers />
          <CommercialChangeHistory businessId={selectedBusinessId} />
        </div>
      </div>

      <CommercialTruthSettingsSection businessId={selectedBusinessId} />

      <CommercialSpendBands
        rows={campaigns?.rows ?? []}
        targetRoas={commercial?.snapshot?.targetPack?.targetRoas ?? null}
        breakEvenRoas={commercial?.snapshot?.targetPack?.breakEvenRoas ?? null}
        currencyFormatter={(value) => formatMoney(value, activeBusiness.currency, null)}
        coverageNote={`${(campaigns?.rows ?? []).filter((row) => Number(row.spend) > 0).length} campaigns with spend`}
      />
    </WorkspaceSurface>
  );
}
