import { META_CAMPAIGN_ROLE_LABELS, type MetaCampaignRole } from "@/lib/meta/types";

interface MetaCampaignRoleChipProps {
  role: MetaCampaignRole | "out_of_scope" | "decommission";
}

type DisplayRole = MetaCampaignRole | "out_of_scope" | "decommission";

const ROLE_TONES: Record<DisplayRole, string> = {
  promo_clearance: "bg-amber-50 text-amber-800 border-amber-200",
  catalog_dpa: "bg-violet-50 text-violet-700 border-violet-200",
  retargeting: "bg-indigo-50 text-indigo-700 border-indigo-200",
  existing_customer_ltv: "bg-teal-50 text-teal-700 border-teal-200",
  geo_expansion: "bg-cyan-50 text-cyan-700 border-cyan-200",
  prospecting_scale: "bg-emerald-50 text-emerald-700 border-emerald-200",
  prospecting_validation: "bg-sky-50 text-sky-700 border-sky-200",
  prospecting_test: "bg-amber-50 text-amber-800 border-amber-200",
  out_of_scope: "bg-rose-50 text-rose-700 border-rose-200",
  decommission: "bg-rose-50 text-rose-700 border-rose-200",
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
