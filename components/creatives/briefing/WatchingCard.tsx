"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, Clock, Eye, Plus } from "lucide-react";
import {
  ConfidencePill,
  DeferChip,
  DeferTooltip,
  DecisionLabelChip,
  EvidencePopover,
  confidenceClass,
} from "@/components/common/briefing";
import {
  BadgeChip,
  CampaignKindChip,
  Sparkline,
  Thumb,
  asDecisionLabel,
  buildEvidenceSections,
  cardAdset,
  cardCampaign,
  cardId,
  cardName,
  confidenceValue,
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
  const confidence = confidenceValue(card);
  const conf = confidenceClass(confidence);
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

  return (
    <div
      className={`rounded-xl ${conf.border} bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${deferred ? "opacity-60" : ""}`}
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
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
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
            <h4 className={`${conf.textWeight} text-slate-800 text-[13px] truncate`}>
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
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              {card.brand || "Brand"}
            </span>
            <DecisionLabelChip label={label} size="sm" />
            {badges.map((badge) => (
              <BadgeChip key={String(badge)} label={badge} />
            ))}
            <ConfidencePill confidence={confidence} size="sm" />
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {cardCampaign(card)} <span className="text-slate-300">·</span> {cardAdset(card)}
          </div>
          <div className="text-[11.5px] text-slate-600 mt-1 leading-snug">
            {card.reason || "No engine reason supplied."}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-slate-500">
            <span className="font-mono tabular-nums">{formatCurrency(card.spend)}</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono tabular-nums">{formatRoas(card.roas)}</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono tabular-nums">CTR {numberOrZero(card.ctr).toFixed(2)}%</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono tabular-nums">Freq {numberOrZero(card.frequency).toFixed(1)}</span>
            <Sparkline values={card.sparkline} tone="text-slate-400" width={50} height={14} />
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <DeferTooltip>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
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
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[11px]"
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
          {label === "test_more" ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 text-[11px]"
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
