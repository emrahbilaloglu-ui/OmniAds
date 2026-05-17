"use client";

import { useState } from "react";
import { ChevronDown, Clock, Sparkles } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
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
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";
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

function creativeChipClass(label: string) {
  if (label === "cut" || label === "below_breakeven" || label === "diagnose") return "chip--action";
  if (label === "scale" || label === "switch" || label === "promote") return "chip--action";
  if (label === "refresh" || label === "test_more") return "chip--watch";
  if (label === "keep") return "chip--healthy";
  return "chip--ghost";
}

function creativeChipLabel(label: string) {
  if (label === "test_more") return "Fresh test";
  if (label === "below_breakeven") return "Cut";
  return label.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function campaignKindLabel(card: BriefingCreativeCard) {
  if (card.campaignLabelStatus === "unlabeled") return "Unlabeled";
  if (card.campaignKind === "main") return "Main";
  if (card.campaignKind === "test") return "Test";
  if (card.campaignKind === "mixed") return "Mixed";
  return null;
}

function campaignKindClass(label: string | null) {
  if (label === "Test") return "chip--info";
  if (label === "Mixed" || label === "Unlabeled") return "chip--warn";
  return "";
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
  const isEvidenceOpen = evidenceOpen ?? localEvidenceOpen;
  const kindLabel = campaignKindLabel(card);
  const preview = briefingPreviewPayload(card);
  const format = getCreativeFormatPresentation({ ...card, preview });
  const mediaFallbacks = briefingMediaFallbacks(card);
  const hasMedia = mediaFallbacks.length > 0 || Boolean(preview.image_url || preview.poster_url || preview.video_url);
  const openEvidence = () => {
    if (onEvidenceOpen) {
      onEvidenceOpen(card);
      return;
    }
    setLocalEvidenceOpen(true);
  };

  const cardClasses = [
    "ccard-tile",
    selected ? "ring-2 ring-blue-500 ring-offset-1" : "",
    deferred ? "opacity-60" : "",
    cutting ? "opacity-0 -translate-x-4 pointer-events-none" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClasses} data-card={actionCardId} data-lane="action">
      <div className="tile-thumb">
        <span className="fmt">{format.tag}</span>
        <label className="corner-check-wrap">
          <input
            type="checkbox"
            data-select={actionCardId}
            data-lane="action"
            checked={selected}
            onChange={(event) => onSelectChange?.(actionCardId, event.currentTarget.checked)}
            className="sr-only"
          />
          <span className={`corner-check ${selected ? "on" : ""}`} aria-hidden="true" />
        </label>
        <button
          type="button"
          className={`ad-shape creative-evidence-trigger creative-evidence-trigger--media ${format.shape} ${hasMedia ? "ad-shape--media" : ""}`}
          data-media-shape={format.shape}
          aria-label={`Open evidence for ${name}`}
          onClick={openEvidence}
        >
          {hasMedia ? (
            <CreativeRenderSurface
              id={actionCardId}
              name={name}
              preview={preview}
              mode="asset"
              size="card"
              assetFallbacks={mediaFallbacks}
              className="h-full w-full rounded-[var(--r-sm)]"
            />
          ) : format.shape === "portrait" ? <div className="play-c">▶</div> : <span>{format.icon}</span>}
          <span className="ratio-tag">{format.ratio}</span>
        </button>
      </div>
      <div className="tile-body">
        <div className="tile-chips">
          <span className={`chip ${creativeChipClass(label)}`}><span className="dot" />{creativeChipLabel(label)}</span>
          {kindLabel ? <span className={`chip ${campaignKindClass(kindLabel)}`}><span className="dot" />{kindLabel}</span> : null}
          {card.fatigue ? <span className="chip chip--warn"><span className="dot" />Fatigue {numberOrZero(card.frequency).toFixed(1)}</span> : null}
          {badges.slice(0, 1).map((badge) => (
            <span key={String(badge)} className="chip chip--ghost"><span className="dot" />{String(badge).replace(/_/g, " ")}</span>
          ))}
        </div>
        <button
          type="button"
          className="tile-name creative-evidence-trigger creative-evidence-trigger--name"
          aria-label={`Open evidence for ${name}`}
          onClick={openEvidence}
        >
          {name}
        </button>
        <div className="tile-meta">
          {cardCampaign(card)} / {cardAdset(card)} · {numberOrZero(card.ageDays)}d · {card.bestPlacement ?? card.status ?? "active"}
        </div>
        <div className="tile-why">
          <b>{card.reason ? card.reason.split("·")[0] : "Engine reason"}</b>
          {card.reason?.includes("·") ? ` · ${card.reason.split("·").slice(1).join("·").trim()}` : card.reason ? "" : " · No engine reason supplied."}
        </div>
        <div className="tile-metrics">
          <div className="m"><span className="k">ROAS</span><span className={`v ${numberOrZero(card.roas) < 1 ? "warn" : numberOrZero(card.roas) >= 2 ? "good" : ""}`}>{formatRoas(card.roas)}</span></div>
          <div className="m"><span className="k">Spend</span><span className="v">{formatCurrency(card.spend)}</span></div>
          <div className="m"><span className="k">{card.fatigue ? "Freq" : "Purch"}</span><span className={`v ${card.fatigue ? "warn" : ""}`}>{card.fatigue ? numberOrZero(card.frequency).toFixed(1) : numberOrZero(card.purchases)}</span></div>
        </div>
        <div className="tile-foot">
          <button
            type="button"
            className={`btn ${cutAction ? "btn--danger" : conf.primaryStyle === "filled" ? "btn--primary" : ""}`}
            data-kind={primaryKind}
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
          >
            {primaryLabel || "Open detail"}{cutAction ? "" : " ↗"}
          </button>
          <div className="actions">
            <DeferTooltip>
              <button type="button" className="btn btn--ghost btn--sm" disabled={deferred} onClick={() => onDefer?.(scopeId)}>
                Defer
              </button>
            </DeferTooltip>
            <button type="button" className="btn btn--ghost btn--sm" aria-haspopup="dialog" aria-expanded={isEvidenceOpen} onClick={openEvidence}>▾</button>
          </div>
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
