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
  formatOptionalCurrency,
  formatOptionalInteger,
  formatOptionalRoas,
  hasMetricValue,
} from "@/components/creatives/briefing/card-utils";
import type {
  BriefingCreativeCard,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";

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
    { key: "roas", label: "ROAS", value: formatOptionalRoas(card.roas), tone: hasMetricValue(card.roas) ? "good" : undefined },
    { key: "spend", label: "Spend", value: formatOptionalCurrency(card.spend) },
    {
      key: "purch",
      label: "Purch",
      value: formatOptionalInteger(card.purchases),
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
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-200 bg-white px-3 text-[12px] text-neutral-600">
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
