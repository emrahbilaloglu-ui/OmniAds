"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, Clock, Eye, Plus } from "lucide-react";
import {
  BriefingTile,
  DecisionLabelChip,
  DeferChip,
  DeferTooltip,
  EvidencePopover,
  ConfidencePill,
  confidenceClass,
  deriveTileFormat,
  deriveTileShape,
  type TileMetric,
} from "@/components/common/briefing";
import {
  BadgeChip,
  CampaignKindChip,
  buildEvidenceSections,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  confidenceValue,
  formatOptionalCurrency,
  formatOptionalFixed,
  formatOptionalInteger,
  formatOptionalRoas,
  numberOrZero,
  Sparkline,
  Thumb,
} from "@/components/creatives/briefing/card-utils";
import { getBriefingCanonicalDecisionPresentation } from "@/components/creatives/briefing/action-authority";
import { getCreativeScopeId } from "@/components/creatives/briefing/action-handlers";
import {
  mapBriefingPrimaryToLaunchpadMode,
  type LaunchpadOpenPayload,
} from "@/components/creatives/briefing/launchpad-bridge";
import type {
  BriefingCreativeCard,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";

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
  const decisionPresentation =
    getBriefingCanonicalDecisionPresentation(card);
  const label = decisionPresentation.label;
  const name = cardName(card);
  const confidence = confidenceValue(card);
  const conf = confidenceClass(confidence);
  const watchingCardId = cardId(card);
  const scopeId = getCreativeScopeId(card);
  const badges = Array.isArray(card.badges) ? card.badges : [];
  const isEvidenceOpen = evidenceOpen ?? localEvidenceOpen;
  const launchpadMode = mapBriefingPrimaryToLaunchpadMode(card);
  const canLaunchFreshTest = launchpadMode === "fresh_test";
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
    { key: "roas", label: "ROAS", value: formatOptionalRoas(card.roas) },
    { key: "spend", label: "Spend", value: formatOptionalCurrency(card.spend, card.currency) },
    {
      key: "purch",
      label: "Purch",
      value: formatOptionalInteger(card.purchases),
    },
  ];

  const chips = (
    <>
      <DecisionLabelChip label={label} size="sm">
        {decisionPresentation.text}
      </DecisionLabelChip>
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
        <span className="ml-1 italic text-neutral-500">· {card.predictive}</span>
      ) : null}
    </>
  );

  const primaryAction =
    canLaunchFreshTest ? (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 text-[11.5px] font-medium text-blue-700 hover:bg-blue-100"
        data-action="primary"
        data-kind="fresh_test"
        data-id={watchingCardId}
        onClick={(event) => {
          event.preventDefault();
          onLaunchpadOpen?.({ card, mode: launchpadMode });
        }}
      >
        <Plus className="inline-block shrink-0" size={11} aria-hidden="true" />
        Fresh test
        <ArrowRight className="inline-block shrink-0" size={11} aria-hidden="true" />
      </button>
    ) : (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 text-[11.5px] font-medium text-neutral-700 hover:bg-neutral-50"
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
        className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 text-[11.5px] text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
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
    <div
      className={`rounded-xl ${conf.border} bg-white p-3 shadow-[0_1px_2px_rgba(16,21,28,0.04)] ${deferred ? "opacity-60" : ""}`}
      data-card={watchingCardId}
      data-lane="watching"
    >
      <div className="flex items-start gap-3">
        <label className="flex items-start pt-0.5">
          <input
            type="checkbox"
            data-select={watchingCardId}
            data-lane="watching"
            checked={selected}
            onChange={(event) => onSelectChange?.(watchingCardId, event.currentTarget.checked)}
            className="w-4 h-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
        </label>
        <button
          type="button"
          className="creative-evidence-trigger creative-evidence-trigger--watch-thumb"
          aria-label={`Open evidence for ${name}`}
          onClick={openEvidence}
        >
          <Thumb name={name} size={conf.thumb} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className={`${conf.textWeight} text-neutral-800 text-[13px] truncate`}>
              <button
                type="button"
                className="creative-evidence-trigger creative-evidence-trigger--inline-name"
                aria-label={`Open evidence for ${name}`}
                onClick={openEvidence}
              >
                {name}
              </button>
            </h4>
            <CampaignKindChip card={card} />
            <span className="text-[10px] uppercase tracking-wider text-neutral-400">
              {card.brand || "Brand"}
            </span>
            <DecisionLabelChip label={label} size="sm">
              {decisionPresentation.text}
            </DecisionLabelChip>
            {badges.map((badge) => (
              <BadgeChip key={String(badge)} label={badge} />
            ))}
            <ConfidencePill confidence={confidence} size="sm" />
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {cardCampaign(card)} <span className="text-neutral-300">·</span> {cardAdset(card)}
          </div>
          <div className="text-[11.5px] text-neutral-600 mt-1 leading-snug">
            {card.reason || "No engine reason supplied."}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-neutral-500">
            <span className="font-mono tabular-nums">{formatOptionalCurrency(card.spend, card.currency)}</span>
            <span className="text-neutral-300">·</span>
            <span className="font-mono tabular-nums">{formatOptionalRoas(card.roas)}</span>
            <span className="text-neutral-300">·</span>
            <span className="font-mono tabular-nums">CTR {formatOptionalFixed(card.ctr, 2, "%")}</span>
            <span className="text-neutral-300">·</span>
            <span className="font-mono tabular-nums">Freq {formatOptionalFixed(card.frequency, 1)}</span>
            <Sparkline values={card.sparkline} tone="text-neutral-400" width={50} height={14} />
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <DeferTooltip>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
              data-action="defer"
              data-id={watchingCardId}
              disabled={deferred}
              onClick={(event) => {
                event.preventDefault();
                onDefer?.(scopeId);
              }}
            >
              <Clock className="inline-block shrink-0" size={11} aria-hidden="true" />
              Defer 24h
            </button>
          </DeferTooltip>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 text-[11px]"
            data-action="evidence"
            data-id={watchingCardId}
            aria-haspopup="dialog"
            aria-expanded={isEvidenceOpen}
            onClick={openEvidence}
          >
            <Eye className="inline-block shrink-0" size={11} aria-hidden="true" />
            Evidence
            <ChevronDown className="inline-block shrink-0" size={11} aria-hidden="true" />
          </button>
          {canLaunchFreshTest ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 text-[11px]"
              data-action="primary"
              data-kind="fresh_test"
              data-id={watchingCardId}
              onClick={(event) => {
                event.preventDefault();
                onLaunchpadOpen?.({ card, mode: launchpadMode });
              }}
            >
              <Plus className="inline-block shrink-0" size={11} aria-hidden="true" />
              Fresh test
              <ArrowRight className="inline-block shrink-0" size={11} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
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
