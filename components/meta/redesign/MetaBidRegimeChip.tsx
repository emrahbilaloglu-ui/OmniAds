import { META_BID_REGIME_LABELS, type MetaBidRegime } from "@/lib/meta/types";

interface MetaBidRegimeChipProps {
  regime: MetaBidRegime;
}

const REGIME_TONES: Record<MetaBidRegime, string> = {
  lowest_cost: "bg-slate-50 text-slate-700 border-slate-200",
  cost_cap: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] border-[var(--adc-info-bd)]",
  bid_cap: "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] border-[var(--adc-auto-bd)]",
  minimum_roas: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] border-[var(--adc-pos-bd)]",
  unknown: "bg-slate-50 text-slate-500 border-slate-200",
};

export function MetaBidRegimeChip({ regime }: MetaBidRegimeChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${REGIME_TONES[regime]}`}
      data-bid-regime={regime}
    >
      {META_BID_REGIME_LABELS[regime]}
    </span>
  );
}
