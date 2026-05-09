"use client";

import { useState } from "react";
import { ChevronDown, Clock, Sparkles } from "lucide-react";
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
  CtrBar,
  FatigueDot,
  MetricDivider,
  PrimaryActionButton,
  SecondaryButton,
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
}: ActionNowCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const confidence = confidenceValue(card);
  const conf = confidenceClass(confidence);
  const label = asDecisionLabel(card.label);
  const name = cardName(card);
  const badges = Array.isArray(card.badges) ? card.badges : [];
  const actionCardId = cardId(card);
  const scopeId = getCreativeScopeId(card);
  const cutAction = isCutPrimaryAction(card);
  const primaryKind = cutAction ? card.primary?.kind || "cut" : card.primary?.kind;
  const primaryLabel = cutAction ? card.primary?.label || "Cut" : card.primary?.label;

  const cardClasses = [
    "rounded-2xl bg-white p-4 transition-all relative",
    conf.border,
    selected ? "ring-2 ring-blue-500 ring-offset-1" : "",
    deferred ? "opacity-60" : "",
    cutting ? "opacity-0 -translate-x-4 pointer-events-none" : "",
    "shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClasses} data-card={actionCardId} data-lane="action">
      <div className="flex items-start gap-3">
        <label className="flex items-start pt-1">
          <input
            type="checkbox"
            data-select={actionCardId}
            data-lane="action"
            checked={selected}
            onChange={(event) => onSelectChange?.(actionCardId, event.currentTarget.checked)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
        </label>
        <Thumb name={name} size={conf.thumb} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className={`${conf.textWeight} text-slate-900 text-[14px] truncate`}>
                  {name}
                </h3>
                <span className="text-[10.5px] uppercase tracking-wider text-slate-400 font-medium">
                  {card.brand || "Brand"}
                </span>
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5">
                {cardCampaign(card)} <span className="text-slate-300">·</span> {cardAdset(card)}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <DecisionLabelChip label={label} />
              {badges.map((badge) => (
                <BadgeChip key={String(badge)} label={badge} />
              ))}
              <ConfidencePill confidence={confidence} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 pl-[44px] grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 items-center">
        <div className="space-y-1">
          <div className="text-[12.5px] text-slate-700 leading-snug">
            {card.reason || "No engine reason supplied."}
          </div>
          {card.predictive ? (
            <div className="text-[11.5px] text-slate-500 italic flex items-center gap-1 mt-0.5">
              <Sparkles className="inline-block shrink-0 text-slate-400" size={11} aria-hidden="true" />
              <span>{card.predictive}</span>
            </div>
          ) : (
            <div className="h-4" />
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-3 flex-wrap">
            <CtrBar value={card.ctrFunnel?.value ?? card.ctr} p50={card.ctrFunnel?.p50} />
            <MetricDivider />
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] text-slate-500">28d ROAS</span>
              <Sparkline
                values={card.sparkline}
                tone={label === "scale" ? "text-emerald-500" : "text-rose-500"}
                width={60}
                height={18}
              />
              <span className="font-mono tabular-nums text-[11px] font-medium text-slate-900">
                {formatRoas(card.roas)}
              </span>
            </div>
            <MetricDivider />
            <FatigueDot active={card.fatigue} />
            <MetricDivider />
            <span className="font-mono tabular-nums text-[11px] text-slate-500">
              {formatCurrency(card.spend)} spend · {numberOrZero(card.purchases)} purch.
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mt-2 pt-2 border-t border-slate-100">
        <PrimaryActionButton
          kind={primaryKind}
          label={primaryLabel}
          primaryStyle={conf.primaryStyle}
          disabled={cutPending}
          onClick={() => {
            if (cutAction) {
              onCut?.(card);
              return;
            }
            const mode = mapBriefingPrimaryToLaunchpadMode(card);
            if (mode) onLaunchpadOpen?.({ card, mode });
          }}
        />
        <DeferTooltip>
          <SecondaryButton
            data-action="defer"
            disabled={deferred}
            icon={<Clock className="inline-block shrink-0" size={12} aria-hidden="true" />}
            onClick={() => onDefer?.(scopeId)}
          >
            Defer 24h
          </SecondaryButton>
        </DeferTooltip>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-900"
          data-action="evidence"
          data-id={actionCardId}
          aria-haspopup="dialog"
          aria-expanded={evidenceOpen}
          onClick={() => setEvidenceOpen(true)}
        >
          More evidence
          <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
        </button>
      </div>

      {deferred ? <DeferChip id={scopeId} onUndo={onUndefer} /> : null}

      <EvidencePopover
        open={evidenceOpen}
        title="Evidence"
        subtitle={name}
        sections={buildEvidenceSections(card)}
        variant="creative"
        onClose={() => setEvidenceOpen(false)}
      />
    </div>
  );
}
