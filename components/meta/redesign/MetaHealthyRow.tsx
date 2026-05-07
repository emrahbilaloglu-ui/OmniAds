import { CheckCircle2 } from "lucide-react";
import type { MetaHealthyEntity } from "@/components/meta/redesign/types";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

interface MetaHealthyRowProps {
  row: MetaHealthyEntity;
}

export function MetaHealthyRow({ row }: MetaHealthyRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2" data-healthy-row={row.id}>
      <CheckCircle2 className="inline-block shrink-0 text-emerald-600" size={15} aria-hidden="true" />
      <MetaScopeChip level={row.level} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-slate-900">{row.name}</div>
        {row.campaignName ? <div className="truncate text-[11px] text-slate-500">{row.campaignName}</div> : null}
      </div>
      <div className="font-mono tabular-nums text-[11.5px] text-slate-600">{formatCurrency(row.spend)}</div>
      <div className="font-mono tabular-nums text-[11.5px] text-emerald-700">{formatRoas(row.roas)}</div>
    </div>
  );
}
