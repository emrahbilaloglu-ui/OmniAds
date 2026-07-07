"use client";

import {
  BriefingTile,
  DecisionLabelChip,
  deriveTileFormat,
  deriveTileShape,
  type TileMetric,
} from "@/components/common/briefing";
import {
  CampaignKindChip,
  asDecisionLabel,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  numberOrZero,
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
  const shape = deriveTileShape(card);
  const format = deriveTileFormat(card);

  const metrics: TileMetric[] = [
    { key: "roas", label: "ROAS", value: formatRoas(card.roas), tone: "good" },
    { key: "spend", label: "Spend", value: formatCurrency(card.spend) },
    {
      key: "purch",
      label: "Purch",
      value: String(numberOrZero(card.purchases)),
    },
  ];

  const chips = (
    <>
      <DecisionLabelChip label={label} size="sm" />
      <CampaignKindChip card={card} />
    </>
  );

  const meta = `${cardCampaign(card)} · ${cardAdset(card)}${
    card.ageDays != null ? ` · ${card.ageDays}d` : ""
  }`;

  const why = card.reason || "At target — no action needed today.";

  const primaryAction = (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-200 bg-white px-3 text-[11.5px] text-neutral-600">
      Healthy
    </span>
  );

  return (
    <div className="relative" data-card={rowId} data-lane="healthy">
      <BriefingTile
        testId={`healthy-card-${rowId}`}
        laneVariant="healthy"
        shape={shape}
        format={format}
        chips={chips}
        name={name}
        meta={meta}
        why={why}
        metrics={metrics}
        primaryAction={primaryAction}
        selected={selected}
        onSelectChange={(next) => onSelectChange?.(rowId, next)}
        selectLabel={`Select ${name}`}
      />
    </div>
  );
}
