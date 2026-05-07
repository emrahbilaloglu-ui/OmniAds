"use client";

import { DecisionLabelChip } from "@/components/common/briefing";
import {
  Thumb,
  asDecisionLabel,
  cardId,
  cardName,
} from "@/components/creatives/briefing/card-utils";
import type {
  BriefingCreativeCard,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

interface HealthyRowProps extends CardSelectionProps {
  card: BriefingCreativeCard;
}

export function HealthyRow({
  card,
  selected = false,
  onSelectChange,
}: HealthyRowProps) {
  const rowId = cardId(card);
  const name = cardName(card);
  const label = asDecisionLabel(card.label, "keep");

  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 text-[12px] border-b border-slate-100 last:border-b-0">
      <input
        type="checkbox"
        data-select={rowId}
        data-lane="healthy"
        checked={selected}
        onChange={(event) => onSelectChange?.(rowId, event.currentTarget.checked)}
        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600"
      />
      <Thumb name={name} size="xs" />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-slate-800 truncate">{name}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          {card.brand || "Brand"}
        </span>
      </div>
      <DecisionLabelChip label={label} size="sm" />
      <span className="font-mono tabular-nums text-slate-700 w-16 text-right font-medium">
        {formatRoas(card.roas)}
      </span>
      <span className="font-mono tabular-nums text-slate-500 w-20 text-right">
        {formatCurrency(card.spend)}
      </span>
    </div>
  );
}
