"use client";

import {
  ArrowRight,
  Copy,
  GitCompare,
  Plus,
  RefreshCw,
  Rocket,
  Sliders,
  TrendingDown,
  X,
} from "lucide-react";
import { useState } from "react";
import { TrackingConfirmModal } from "@/components/common/briefing/TrackingConfirmModal";

export type BulkAction =
  | "cut"
  | "demote"
  | "launch_new"
  | "add_existing"
  | "compare"
  | "clear"
  | "rebuild"
  | "apply_bid"
  | "duplicate";

type BulkToolbarVariant = "creative" | "meta";

interface BulkToolbarProps {
  selectedCount: number;
  scope?: string;
  variant?: BulkToolbarVariant;
  actions?: BulkAction[];
  trackingBlocked?: boolean;
  trackingConfirmBehavior?: "inline" | "consumer";
  stickyTop?: string;
  onAction?: (action: BulkAction) => void;
  onClear?: () => void;
}

const TRACKING_CONFIRM_ACTIONS = new Set<BulkAction>(["cut", "rebuild"]);

export function shouldConfirmBulkAction(action: BulkAction, trackingBlocked: boolean): boolean {
  return trackingBlocked && TRACKING_CONFIRM_ACTIONS.has(action);
}

export function BulkToolbar({
  selectedCount,
  scope = "action",
  variant = "creative",
  actions,
  trackingBlocked = false,
  trackingConfirmBehavior = "inline",
  stickyTop = "126px",
  onAction,
  onClear,
}: BulkToolbarProps) {
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const visibleActions = new Set(
    actions ??
      (variant === "meta"
        ? (["cut", "rebuild", "apply_bid", "duplicate", "compare", "clear"] as BulkAction[])
        : (["cut", "demote", "launch_new", "add_existing", "compare", "clear"] as BulkAction[])),
  );

  if (selectedCount === 0) return null;

  const handleAction = (action: BulkAction) => {
    if (action === "clear") {
      onClear?.();
      onAction?.(action);
      return;
    }
    if (
      trackingConfirmBehavior === "inline" &&
      shouldConfirmBulkAction(action, trackingBlocked)
    ) {
      setPendingAction(action);
      return;
    }
    onAction?.(action);
  };

  const modalLabel = pendingAction === "rebuild" ? "Rebuild anyway" : "Cut anyway";

  if (variant === "meta") {
    return (
      <>
        <div className="sticky z-20 transition-all opacity-100" id="bulk-toolbar" style={{ top: stickyTop }}>
          <div className="max-w-[1440px] mx-auto px-6 py-2">
            <div className="rounded-lg border border-neutral-300 bg-white shadow-[0_2px_6px_rgba(16,21,28,0.06)] px-3 py-2 flex items-center gap-2 flex-wrap">
              <span className="font-mono tabular-nums text-[12px] text-neutral-700">
                <span className="font-semibold text-neutral-900">{selectedCount}</span> selected
              </span>
              <span className="text-neutral-200">|</span>
              {visibleActions.has("cut") ? (
                <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--adc-danger-bd)] text-[var(--adc-danger-fg)] hover:bg-[var(--adc-danger-bg)] text-[11.5px]" data-bulk="cut" onClick={() => handleAction("cut")}>
                  <X className="inline-block shrink-0" size={12} aria-hidden="true" /> Cut all
                </button>
              ) : null}
              {visibleActions.has("rebuild") ? (
                <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--adc-caution-bd)] text-[var(--adc-caution-fg)] hover:bg-[var(--adc-caution-bg)] text-[11.5px]" data-bulk="rebuild" onClick={() => handleAction("rebuild")}>
                  <RefreshCw className="inline-block shrink-0" size={12} aria-hidden="true" /> Rebuild
                </button>
              ) : null}
              {visibleActions.has("apply_bid") ? (
                <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-50 text-[11.5px]" data-bulk="apply_bid" onClick={() => handleAction("apply_bid")}>
                  <Sliders className="inline-block shrink-0" size={12} aria-hidden="true" /> Apply bid changes
                </button>
              ) : null}
              {visibleActions.has("duplicate") ? (
                <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--adc-info-bd)] text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)] text-[11.5px]" data-bulk="duplicate" onClick={() => handleAction("duplicate")}>
                  <Copy className="inline-block shrink-0" size={12} aria-hidden="true" /> Duplicate to test <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
                </button>
              ) : null}
              {visibleActions.has("compare") ? (
                <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-50 text-[11.5px]" data-bulk="compare" onClick={() => handleAction("compare")}>
                  <GitCompare className="inline-block shrink-0" size={12} aria-hidden="true" /> Compare
                </button>
              ) : null}
              {visibleActions.has("clear") ? (
                <span className="ml-auto text-[11px] text-neutral-500">
                  <button type="button" className="hover:text-neutral-900" data-bulk="clear" onClick={() => handleAction("clear")}>Clear</button>
                </span>
              ) : null}
              {trackingBlocked ? (
                <span className="basis-full text-[10.5px] text-[var(--adc-danger-fg)] flex items-center gap-1 mt-0.5">
                  Tracking degraded — Cut requires confirmation.
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <TrackingConfirmModal
          open={pendingAction != null}
          primaryLabel={modalLabel}
          onClose={() => setPendingAction(null)}
          onConfirm={() => {
            if (pendingAction) onAction?.(pendingAction);
            setPendingAction(null);
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="sticky z-20 rounded-xl border border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)]/60 px-3 py-2 mb-3 flex items-center gap-1.5 flex-wrap" data-bulk={scope} style={{ top: stickyTop }}>
        <span className="text-[12.5px] font-medium text-neutral-900 mr-2">{selectedCount} selected</span>
        {visibleActions.has("cut") ? (
          <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-[var(--adc-danger-fg)] text-white border border-[var(--adc-danger-bd)] hover:bg-[var(--adc-danger-fg)] text-[12px] font-medium" data-bulk-action="cut" data-scope={scope} onClick={() => handleAction("cut")}>
            <X className="inline-block shrink-0" size={12} aria-hidden="true" /> Cut all
          </button>
        ) : null}
        {visibleActions.has("demote") ? (
          <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 text-[12px]" data-bulk-action="demote" data-scope={scope} onClick={() => handleAction("demote")}>
            <TrendingDown className="inline-block shrink-0" size={12} aria-hidden="true" /> Demote all <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
        {visibleActions.has("launch_new") ? (
          <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--adc-info-bd)] bg-white text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)] text-[12px] font-medium" data-bulk-action="launch_new" data-scope={scope} onClick={() => handleAction("launch_new")}>
            <Rocket className="inline-block shrink-0" size={12} aria-hidden="true" /> Launch new test <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
        {visibleActions.has("add_existing") ? (
          <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[var(--adc-info-bd)] bg-white text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)] text-[12px]" data-bulk-action="add_existing" data-scope={scope} onClick={() => handleAction("add_existing")}>
            <Plus className="inline-block shrink-0" size={12} aria-hidden="true" /> Add to existing <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
        {visibleActions.has("compare") ? (
          <button type="button" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 text-[12px]" data-bulk-action="compare" data-scope={scope} onClick={() => handleAction("compare")}>
            <GitCompare className="inline-block shrink-0" size={12} aria-hidden="true" /> Compare side-by-side
          </button>
        ) : null}
        {visibleActions.has("clear") ? (
          <button type="button" className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-neutral-500 hover:bg-white hover:text-neutral-900 text-[12px]" data-bulk-action="clear" data-scope={scope} onClick={() => handleAction("clear")}>
            <X className="inline-block shrink-0" size={12} aria-hidden="true" /> Clear
          </button>
        ) : null}
      </div>
      <TrackingConfirmModal
        open={pendingAction != null}
        primaryLabel={modalLabel}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction) onAction?.(pendingAction);
          setPendingAction(null);
        }}
      />
    </>
  );
}
