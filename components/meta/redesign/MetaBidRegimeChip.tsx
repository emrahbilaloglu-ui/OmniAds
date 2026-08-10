import { META_BID_REGIME_LABELS, type MetaBidRegime } from "@/lib/meta/types";

interface MetaBidRegimeChipProps {
  regime: MetaBidRegime;
}

const REGIME_TONES: Record<MetaBidRegime, string> = {
  lowest_cost: "bg-slate-50 text-slate-700 border-slate-200",
  cost_cap: "bg-blue-50 text-blue-700 border-blue-200",
  bid_cap: "bg-violet-50 text-violet-700 border-violet-200",
  minimum_roas: "bg-emerald-50 text-emerald-700 border-emerald-200",
  unknown: "bg-slate-50 text-slate-500 border-slate-200",
};

export function MetaBidRegimeChip({ regime }: MetaBidRegimeChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wider ${REGIME_TONES[regime]}`}
      data-bid-regime={regime}
    >
      {META_BID_REGIME_LABELS[regime]}
    </span>
  );
}
