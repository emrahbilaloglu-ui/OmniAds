"use client";

import { useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
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
  PrimaryActionButton,
  SecondaryButton,
  asDecisionLabel,
  buildEvidenceSections,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import {
  getCreativeScopeId,
  isCutPrimaryAction,
} from "@/components/creatives/briefing/action-handlers";
import {
  mapBriefingPrimaryToLaunchpadMode,
  type LaunchpadOpenPayload,
} from "@/components/creatives/briefing/launchpad-bridge";
import type {
  BriefingCreativeCard,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

interface ActionNowCardProps extends CardSelectionProps {
  card: BriefingCreativeCard;
  deferred?: boolean;
  cutting?: boolean;
  cutPending?: boolean;
  onDefer?: (id: string) => void;
  onUndefer?: (id: string) => void;
  onCut?: (card: BriefingCreativeCard) => void;
  onLaunchpadOpen?: (payload: LaunchpadOpenPayload) => void;
  evidenceOpen?: boolean;
  onEvidenceOpen?: (card: BriefingCreativeCard) => void;
}

export function ActionNowCard({
  card,
  selected = false,
  deferred = false,
  cutting = false,
  cutPending = false,
  onSelectChange,
  onDefer,
  onUndefer,
  onCut,
  onLaunchpadOpen,
  evidenceOpen,
  onEvidenceOpen,
}: ActionNowCardProps) {
  const [localEvidenceOpen, setLocalEvidenceOpen] = useState(false);
  const label = asDecisionLabel(card.label);
  const name = cardName(card);
  const badges = Array.isArray(card.badges) ? card.badges : [];
  const actionCardId = cardId(card);
  const scopeId = getCreativeScopeId(card);
  const cutAction = isCutPrimaryAction(card);
  const primaryKind = cutAction ? card.primary?.kind || "cut" : card.primary?.kind;
  const primaryLabel = cutAction
    ? card.primary?.label || "Cut"
    : card.primary?.label;
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
  const tone = label === "cut" || label === "below_breakeven" ? "warn" : label === "scale" ? "good" : "neutral";

  const metrics: TileMetric[] = [
    { key: "roas", label: "ROAS", value: formatRoas(card.roas), tone },
    { key: "spend", label: "Spend", value: formatCurrency(card.spend) },
    {
      key: "purchases",
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

  const primaryAction = (
    <PrimaryActionButton
      kind={primaryKind}
      label={primaryLabel}
      primaryStyle="filled"
      disabled={cutPending}
      onClick={() => {
        if (cutAction) {
          onCut?.(card);
          return;
        }
        const mode = mapBriefingPrimaryToLaunchpadMode(card);
        if (mode) onLaunchpadOpen?.({ card, mode });
        else openEvidence();
      }}
    />
  );

  const secondaryActions = (
    <>
      <DeferTooltip>
        <SecondaryButton
          data-action="defer"
          disabled={deferred}
          icon={<Clock className="inline-block shrink-0" size={12} aria-hidden="true" />}
          onClick={() => onDefer?.(scopeId)}
        >
          Defer
        </SecondaryButton>
      </DeferTooltip>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-0.5 rounded-md border border-slate-300 bg-white px-2 text-[11.5px] text-slate-600 hover:bg-slate-50"
        data-action="evidence"
        data-id={actionCardId}
        aria-haspopup="dialog"
        aria-expanded={isEvidenceOpen}
        onClick={openEvidence}
      >
        <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
      </button>
    </>
  );

  return (
    <div className="relative" data-card={actionCardId} data-lane="action">
      <BriefingTile
        testId={`action-card-${actionCardId}`}
        laneVariant="action"
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
        onSelectChange={(next) => onSelectChange?.(actionCardId, next)}
        selectLabel={`Select ${name}`}
        deferred={deferred}
        removing={cutting}
        borderClass="border-slate-300"
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
