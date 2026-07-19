"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  Layers,
  Sparkles,
} from "lucide-react";
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
  asDecisionLabel,
  buildEvidenceSections,
  briefingMediaFallbacks,
  briefingPreviewPayload,
  cardId,
  cardName,
  confidenceValue,
  formatOptionalCurrency,
  formatOptionalInteger,
  formatOptionalRoas,
  hasMetricValue,
} from "@/components/creatives/briefing/card-utils";
import { getCreativeScopeId } from "@/components/creatives/briefing/action-handlers";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import {
  mapBriefingPrimaryToLaunchpadMode,
  type LaunchpadOpenPayload,
} from "@/components/creatives/briefing/launchpad-bridge";
import type {
  BriefingCreativeCard,
  BriefingPlacement,
  BriefingRollupItem,
  CardSelectionProps,
} from "@/components/creatives/briefing/types";

interface CrossPlacementCardProps extends CardSelectionProps {
  rollup: BriefingRollupItem;
  deferred?: boolean;
  cutting?: boolean;
  onDefer?: (id: string) => void;
  onUndefer?: (id: string) => void;
  onLaunchpadOpen?: (payload: LaunchpadOpenPayload) => void;
  evidenceOpen?: boolean;
  onEvidenceOpen?: (card: BriefingCreativeCard) => void;
}

export function isCrossPlacementRollup(value: unknown): value is BriefingRollupItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BriefingRollupItem>;
  return Boolean(candidate.primaryRec && Array.isArray(candidate.placementList));
}

export function CrossPlacementCard({
  rollup,
  selected = false,
  onSelectChange,
  deferred = false,
  cutting = false,
  onDefer,
  onUndefer,
  onLaunchpadOpen,
  evidenceOpen,
  onEvidenceOpen,
}: CrossPlacementCardProps) {
  const [localEvidenceOpen, setLocalEvidenceOpen] = useState(false);
  const [placementsExpanded, setPlacementsExpanded] = useState(true);
  const placementList = Array.isArray(rollup.placementList) ? rollup.placementList : [];
  const mixed =
    Boolean(rollup.mixed) ||
    new Set(placementList.map((placement) => asDecisionLabel(placement.label))).size > 1;
  const card = useMemo(
    () => ({
      ...rollup.primaryRec,
      id: rollup.primaryRec.id || rollup.id || "rollup",
      placements: placementList.length,
      placementList,
      mixed,
      primary: mixed
        ? { kind: "review_placements", label: "Review placements" }
        : rollup.primaryRec.primary,
    }),
    [mixed, placementList, rollup.id, rollup.primaryRec],
  );
  const confidence = confidenceValue(card);
  const conf = confidenceClass(confidence);
  const label = asDecisionLabel(card.label);
  const name = cardName(card);
  const badges = Array.isArray(card.badges) ? card.badges : [];
  const bestPlacement = card.bestPlacement || placementList[0]?.adset || placementList[0]?.adsetName || "Placement";
  const actionCardId = cardId(card);
  const scopeId = getCreativeScopeId(card);
  const isEvidenceOpen = evidenceOpen ?? localEvidenceOpen;
  const openEvidence = () => {
    if (onEvidenceOpen) {
      onEvidenceOpen(card);
      return;
    }
    setLocalEvidenceOpen(true);
  };

  const cardClasses = [
    "relative rounded-xl bg-white p-4 transition-all",
    conf.border,
    selected ? "ring-2 ring-blue-500 ring-offset-1" : "",
    deferred ? "opacity-60" : "",
    cutting ? "opacity-0 -translate-x-4 pointer-events-none" : "",
    "shadow-[0_1px_2px_rgba(16,21,28,0.04)]",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClasses} data-card={actionCardId} data-lane="action" data-rollup="cross-placement">
      <div className="absolute -bottom-1 left-3 right-3 h-2 rounded-b-2xl bg-white border-x border-b border-neutral-200" />
      <div className="absolute -bottom-2 left-5 right-5 h-2 rounded-b-2xl bg-white border-x border-b border-neutral-200" />

      <div className="flex items-start gap-3">
        <label className="flex items-start pt-1">
          <input
            type="checkbox"
            data-select={actionCardId}
            data-lane="action"
            checked={selected}
            onChange={(event) => onSelectChange?.(actionCardId, event.currentTarget.checked)}
            className="w-4 h-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
        </label>
        <button
          type="button"
          className="cross-thumb creative-evidence-trigger creative-evidence-trigger--thumb"
          aria-label={`Open evidence for ${name}`}
          onClick={openEvidence}
        >
          <CreativeRenderSurface
            id={actionCardId}
            name={name}
            preview={briefingPreviewPayload(card)}
            mode="asset"
            size="thumb"
            assetFallbacks={briefingMediaFallbacks(card, "thumb")}
            className="h-full w-full rounded-[var(--r-xs)]"
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className={`${conf.textWeight} text-neutral-900 text-[14px] truncate`}>
                  <button
                    type="button"
                    className="creative-evidence-trigger creative-evidence-trigger--inline-name"
                    aria-label={`Open evidence for ${name}`}
                    onClick={openEvidence}
                  >
                    {name}
                  </button>
                </h3>
                <span className="text-[10.5px] uppercase tracking-wider text-neutral-400 font-medium">
                  {card.brand || "Brand"}
                </span>
              </div>
              <div className="text-[11.5px] text-neutral-500 truncate mt-0.5">
                In {placementList.length} placements · best in{" "}
                <span className="font-medium text-neutral-700">{bestPlacement}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-neutral-200 bg-neutral-50 text-neutral-600 text-[10.5px] font-medium">
                <Layers className="inline-block shrink-0" size={11} aria-hidden="true" />
                {placementList.length} placements
              </span>
              {mixed ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-neutral-300 bg-neutral-100 text-neutral-700 text-[10.5px] font-medium">
                  <AlertTriangle className="inline-block shrink-0" size={11} aria-hidden="true" />
                  mixed
                </span>
              ) : null}
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
          <div className="text-[12.5px] text-neutral-700 leading-snug">
            {card.reason || "No engine reason supplied."}
          </div>
          {card.predictive ? (
            <div className="text-[11.5px] text-neutral-500 italic flex items-center gap-1 mt-0.5">
              <Sparkles className="inline-block shrink-0 text-neutral-400" size={11} aria-hidden="true" />
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
              <span className="text-[10.5px] text-neutral-500">28d ROAS</span>
              <Sparkline
                values={card.sparkline}
                tone={label === "scale" ? "text-emerald-500" : "text-rose-500"}
                width={60}
                height={18}
              />
              <span className="font-mono tabular-nums text-[11px] font-medium text-neutral-900">
                {formatOptionalRoas(card.roas)}
              </span>
            </div>
            <MetricDivider />
            <FatigueDot active={card.fatigue} />
            <MetricDivider />
            <span className="font-mono tabular-nums text-[11px] text-neutral-500">
              {formatOptionalCurrency(card.spend, card.currency)} spend · {formatOptionalInteger(card.purchases)} purch.
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mt-2 pt-2 border-t border-neutral-100">
        <PrimaryActionButton
          kind={card.primary?.kind}
          label={card.primary?.label}
          primaryStyle={conf.primaryStyle}
          onClick={() => {
            if (mixed) {
              setPlacementsExpanded(true);
              return;
            }
            const mode = mapBriefingPrimaryToLaunchpadMode(card);
            if (mode) onLaunchpadOpen?.({ card, mode });
            else openEvidence();
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
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-neutral-500 hover:text-neutral-900"
          data-action="evidence"
          data-id={actionCardId}
          aria-haspopup="dialog"
          aria-expanded={isEvidenceOpen}
          onClick={openEvidence}
        >
          More evidence
          <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
        </button>
      </div>

      {placementsExpanded ? (
        <PlacementStrip placements={placementList} currency={card.currency} />
      ) : null}

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

function PlacementStrip({
  placements,
  currency,
}: {
  placements: BriefingPlacement[];
  currency: string | null | undefined;
}) {
  return (
    <div className="mt-3 pl-[44px]">
      <div className="text-[10.5px] uppercase tracking-wider text-neutral-400 font-semibold mb-1 flex items-center gap-1">
        <Layers className="inline-block shrink-0 text-neutral-400" size={11} aria-hidden="true" />
        Placements ({placements.length})
      </div>
      <div className="rounded-lg border border-neutral-200 bg-neutral-50/50 divide-y divide-neutral-100">
        {placements.map((placement, index) => {
          const label = placement.label ? asDecisionLabel(placement.label) : null;
          const roas = hasMetricValue(placement.roas) ? placement.roas : null;
          const key = placement.id || `${placement.campaign ?? "campaign"}-${placement.adset ?? index}`;

          return (
            <div
              key={key}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white cursor-pointer text-[11.5px]"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  placement.status === "ACTIVE" ? "bg-emerald-500" : "bg-neutral-300"
                }`}
              />
              <span className="text-neutral-700 truncate flex-1 min-w-0">
                {placement.adset || placement.adsetName || "Ad set"}
              </span>
              <span className="text-neutral-400 truncate hidden lg:block">
                {placement.campaign || placement.campaignName || "Campaign"}
              </span>
              <span className="font-mono tabular-nums text-neutral-500">
                {formatOptionalCurrency(placement.spend, currency)}
              </span>
              <span
                className={`font-mono tabular-nums font-medium ${
                  roas !== null
                    ? roas >= 2
                      ? "text-emerald-700"
                      : roas >= 1
                        ? "text-neutral-700"
                        : "text-rose-700"
                    : "text-neutral-500"
                }`}
              >
                {formatOptionalRoas(placement.roas)}
              </span>
              {label ? <DecisionLabelChip label={label} size="sm" /> : null}
              {placement.confidence != null ? <ConfidencePill confidence={placement.confidence} size="sm" /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
