"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, Clock, Eye, Plus } from "lucide-react";
import {
  BriefingTile,
  DecisionLabelChip,
  DeferChip,
  DeferTooltip,
  EvidencePopover,
  deriveTileFormat,
  deriveTileShape,
  type TileMetric,
} from "@/components/common/briefing";
import {
  BadgeChip,
  CampaignKindChip,
  asDecisionLabel,
  buildEvidenceSections,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import { getCreativeScopeId } from "@/components/creatives/briefing/action-handlers";
import type { LaunchpadOpenPayload } from "@/components/creatives/briefing/launchpad-bridge";
import type {
  BriefingCreativeCard,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

interface WatchingCardProps extends CardSelectionProps {
  card: BriefingCreativeCard;
  deferred?: boolean;
  onDefer?: (id: string) => void;
  onUndefer?: (id: string) => void;
  onLaunchpadOpen?: (payload: LaunchpadOpenPayload) => void;
  evidenceOpen?: boolean;
  onEvidenceOpen?: (card: BriefingCreativeCard) => void;
}

export function WatchingCard({
  card,
  selected = false,
  onSelectChange,
  deferred = false,
  onDefer,
  onUndefer,
  onLaunchpadOpen,
  evidenceOpen,
  onEvidenceOpen,
}: WatchingCardProps) {
  const [localEvidenceOpen, setLocalEvidenceOpen] = useState(false);
  const label = asDecisionLabel(card.label);
  const name = cardName(card);
  const watchingCardId = cardId(card);
  const scopeId = getCreativeScopeId(card);
  const badges = Array.isArray(card.badges) ? card.badges : [];
  const isEvidenceOpen = evidenceOpen ?? localEvidenceOpen;
  const openEvidence = () => {
    if (onEvidenceOpen) {
      onEvidenceOpen(card);
      return;
    }
    setLocalEvidenceOpen(true);
  };

  const shape = deriveTileShape(card);
  const format = deriveTileFormat(card);
  const durationLabel = card.placements && card.placements > 1 ? `${card.placements} cards` : undefined;

  const metrics: TileMetric[] = [
    { key: "roas", label: "ROAS", value: formatRoas(card.roas) },
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
      {badges.map((badge) => (
        <BadgeChip key={String(badge)} label={badge} />
      ))}
    </>
  );

  const meta = `${cardCampaign(card)} · ${cardAdset(card)}${
    card.ageDays != null ? ` · ${card.ageDays}d` : ""
  }`;

  const why = (
    <>
      {card.reason || "No engine reason supplied."}
      {card.predictive ? (
        <span className="ml-1 italic text-slate-500">· {card.predictive}</span>
      ) : null}
    </>
  );

  const primaryAction =
    label === "test_more" ? (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 text-[11.5px] font-medium text-blue-700 hover:bg-blue-100"
        data-action="primary"
        data-kind="fresh_test"
        data-id={watchingCardId}
        onClick={(event) => {
          event.preventDefault();
          onLaunchpadOpen?.({ card, mode: "fresh_test" });
        }}
      >
        <Plus className="inline-block shrink-0" size={11} aria-hidden="true" />
        Fresh test
        <ArrowRight className="inline-block shrink-0" size={11} aria-hidden="true" />
      </button>
    ) : (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-[11.5px] font-medium text-slate-700 hover:bg-slate-50"
        data-action="evidence"
        data-id={watchingCardId}
        aria-haspopup="dialog"
        aria-expanded={isEvidenceOpen}
        onClick={openEvidence}
      >
        <Eye className="inline-block shrink-0" size={11} aria-hidden="true" />
        Open
        <ChevronDown className="inline-block shrink-0" size={11} aria-hidden="true" />
      </button>
    );

  const secondaryActions = (
    <DeferTooltip>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[11.5px] text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        data-action="defer"
        data-id={watchingCardId}
        disabled={deferred}
        onClick={(event) => {
          event.preventDefault();
          onDefer?.(scopeId);
        }}
      >
        <Clock className="inline-block shrink-0" size={11} aria-hidden="true" />
        Defer
      </button>
    </DeferTooltip>
  );

  return (
    <div className="relative" data-card={watchingCardId} data-lane="watching">
      <BriefingTile
        testId={`watching-card-${watchingCardId}`}
        laneVariant="watch"
        shape={shape}
        format={format}
        durationLabel={durationLabel}
        chips={chips}
        name={name}
        meta={meta}
        why={why}
        metrics={metrics}
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        selected={selected}
        onSelectChange={(next) => onSelectChange?.(watchingCardId, next)}
        selectLabel={`Select ${name}`}
        deferred={deferred}
      />
      {deferred ? <DeferChip id={scopeId} onUndo={onUndefer} /> : null}
      {onEvidenceOpen ? null : (
        <EvidencePopover
          open={localEvidenceOpen}
          title="Evidence"
          subtitle={name}
          sections={buildEvidenceSections(card)}
          variant="creative"
          onClose={() => setLocalEvidenceOpen(false)}
        />
      )}
    </div>
  );
}
