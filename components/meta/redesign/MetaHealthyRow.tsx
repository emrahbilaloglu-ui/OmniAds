import { CheckCircle2 } from "lucide-react";
import type { MetaHealthyEntity } from "@/components/meta/redesign/types";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { cn } from "@/lib/utils";

interface MetaHealthyRowProps {
  row: MetaHealthyEntity;
  depth?: "root" | "child";
  hideCampaignName?: boolean;
}

export function MetaHealthyRow({ row, depth = "root", hideCampaignName = false }: MetaHealthyRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2",
        depth === "child" ? "shadow-[0_1px_1px_rgba(15,23,42,0.03)]" : "",
      )}
      data-healthy-row={row.id}
      data-healthy-level={row.level}
      data-healthy-depth={depth}
    >
      <CheckCircle2 className="inline-block shrink-0 text-emerald-600" size={15} aria-hidden="true" />
      <MetaScopeChip level={row.level} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-slate-900">{row.name}</div>
        {!hideCampaignName && row.campaignName ? <div className="truncate text-[11px] text-slate-500">{row.campaignName}</div> : null}
      </div>
      <div className="font-mono tabular-nums text-[11.5px] text-slate-600">{formatCurrency(row.spend)}</div>
      <div className="font-mono tabular-nums text-[11.5px] text-emerald-700">{formatRoas(row.roas)}</div>
    </div>
  );
}
