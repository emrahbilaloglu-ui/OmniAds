import { META_CAMPAIGN_ROLE_LABELS, type MetaCampaignRole } from "@/lib/meta/types";

interface MetaCampaignRoleChipProps {
  role: MetaCampaignRole | "out_of_scope" | "decommission";
}

type DisplayRole = MetaCampaignRole | "out_of_scope" | "decommission";

const ROLE_TONES: Record<DisplayRole, string> = {
  promo_clearance: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] border-[var(--adc-caution-bd)]",
  catalog_dpa: "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] border-[var(--adc-auto-bd)]",
  retargeting: "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] border-[var(--adc-auto-bd)]",
  existing_customer_ltv: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] border-[var(--adc-pos-bd)]",
  geo_expansion: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] border-[var(--adc-info-bd)]",
  prospecting_scale: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] border-[var(--adc-pos-bd)]",
  prospecting_validation: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] border-[var(--adc-info-bd)]",
  prospecting_test: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] border-[var(--adc-caution-bd)]",
  out_of_scope: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)] border-[var(--adc-danger-bd)]",
  decommission: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)] border-[var(--adc-danger-bd)]",
};

const FALLBACK_LABELS: Record<DisplayRole, string> = {
  ...META_CAMPAIGN_ROLE_LABELS,
  out_of_scope: "Decommission",
  decommission: "Decommission",
};

export function MetaCampaignRoleChip({ role }: MetaCampaignRoleChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${ROLE_TONES[role]}`}
      data-campaign-role={role}
    >
      {FALLBACK_LABELS[role]}
    </span>
  );
}
