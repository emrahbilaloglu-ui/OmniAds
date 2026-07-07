import { ArrowRight, Copy, RefreshCw, Rocket, Sliders, Target, TrendingDown, TrendingUp, Plus } from "lucide-react";
import type { DecisionLabel } from "@/components/common/briefing/types";
import { DecisionLabelChip } from "@/components/common/briefing/DecisionLabelChip";
import { initials, tileFor } from "@/lib/briefing/utils";

export type LaunchpadOverlayMode =
  | "promote"
  | "demote"
  | "fresh_test"
  | "rebuild"
  | "duplicate"
  | "apply_bid";

export interface LaunchpadOverlayItem {
  id: string;
  name?: string;
  scopeName?: string;
  brand?: string;
  campaign?: string;
  label?: DecisionLabel;
  currentBidCap?: number;
  proposedBidCap?: number;
}

interface LaunchpadOverlayProps {
  open: boolean;
  mode: LaunchpadOverlayMode;
  item: LaunchpadOverlayItem;
  onClose: () => void;
  onConfirm: () => void;
  presentation?: "modal" | "panel";
}

export function LaunchpadOverlay({
  open,
  mode,
  item,
  onClose,
  onConfirm,
  presentation = "modal",
}: LaunchpadOverlayProps) {
  if (!open) return null;

  const config = getLaunchpadModeConfig(mode, item);
  const label = item.label ?? "keep";
  const name = item.name ?? item.scopeName ?? item.id;
  const [bg, fg] = tileFor(name);
  const Icon = config.icon;

  return (
    <div
      className={
        presentation === "modal"
          ? "fixed inset-0 z-50 bg-neutral-900/40 backdrop-blur-sm grid place-items-center p-6"
          : "relative grid place-items-stretch"
      }
      data-modal="launchpad"
      role={presentation === "modal" ? "dialog" : undefined}
      aria-modal={presentation === "modal" ? "true" : undefined}
      aria-labelledby="launchpad-overlay-title"
    >
      <div className="w-full max-w-[480px] rounded-2xl bg-white shadow-[0_8px_32px_rgba(16,21,28,0.18)] overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-200 flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full ${config.iconBg} grid place-items-center ${config.iconText} shrink-0`}>
            <Icon className="inline-block shrink-0" size={18} aria-hidden="true" />
          </div>
          <div className="flex-1">
            <div id="launchpad-overlay-title" className="text-[15px] font-semibold text-neutral-900">
              {config.title}
            </div>
            <div className="text-[12.5px] text-neutral-500 mt-0.5">{config.subtitle}</div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <div className={`${bg} ${fg} rounded-md grid place-items-center font-semibold shrink-0`} style={{ width: 48, height: 48, fontSize: 14 }}>
              {initials(name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-neutral-900 truncate">{name}</div>
              <div className="text-[11.5px] text-neutral-500 truncate">
                {[item.brand, item.campaign].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="flex items-center gap-1 mt-1">
                <DecisionLabelChip label={label} size="sm" />
              </div>
            </div>
          </div>

          <div className="text-[12px] text-neutral-600 space-y-1.5">{config.body}</div>
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 bg-neutral-50 flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-md text-neutral-700 hover:bg-white text-[12.5px]"
            data-modal-close
            onClick={onClose}
          >
            {mode === "apply_bid" ? "Cancel" : "Stay here"}
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 rounded-md ${config.primaryClassName} text-white text-[12.5px] font-medium inline-flex items-center gap-1`}
            data-confirm-launchpad
            onClick={onConfirm}
          >
            {config.primaryLabel}
            {mode === "apply_bid" ? null : <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function getLaunchpadModeConfig(mode: LaunchpadOverlayMode, item: LaunchpadOverlayItem) {
  const bid = item.proposedBidCap ?? 22;
  const currentBid = item.currentBidCap ?? 18;

  if (mode === "rebuild") {
    return {
      title: "Rebuild in Launchpad",
      subtitle: "Open Launchpad with this campaign pre-loaded?",
      icon: RefreshCw,
      iconBg: "bg-amber-100",
      iconText: "text-amber-700",
      primaryClassName: "bg-amber-600 hover:bg-amber-700",
      primaryLabel: "Open Launchpad",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><RefreshCw className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Engine v3 will pre-load: rebuild template · LAL-1% refresh · 7d learning budget $200/d</span></div>
        </>
      ),
    };
  }

  if (mode === "duplicate") {
    return {
      title: "Duplicate to test",
      subtitle: "Open Launchpad with this campaign duplicated to test environment?",
      icon: Copy,
      iconBg: "bg-blue-100",
      iconText: "text-blue-700",
      primaryClassName: "bg-blue-600 hover:bg-blue-700",
      primaryLabel: "Open Launchpad",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Plus className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Test campaign: $50/d · 7d window · Mode A learning gate</span></div>
        </>
      ),
    };
  }

  if (mode === "apply_bid") {
    return {
      title: `Apply bid cap $${bid}`,
      subtitle: "Inline application — no Launchpad teleport.",
      icon: Sliders,
      iconBg: "bg-blue-100",
      iconText: "text-blue-700",
      primaryClassName: "bg-blue-600 hover:bg-blue-700",
      primaryLabel: "Apply",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Sliders className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Current cap ${currentBid} → proposed ${bid}. Re-enters learning briefly.</span></div>
        </>
      ),
    };
  }

  if (mode === "promote") {
    return {
      title: "Promote to main",
      subtitle: "Open Launchpad with this creative pre-selected?",
      icon: Rocket,
      iconBg: "bg-blue-100",
      iconText: "text-blue-600",
      primaryClassName: "bg-blue-600 hover:bg-blue-700",
      primaryLabel: "Open Launchpad",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Suggested target: <span className="font-medium text-neutral-900">ASC | Worldwide | Sales</span> (highest weighted ROAS adset family)</span></div>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><TrendingUp className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Pre-fill budget bump: <span className="font-mono tabular-nums font-medium text-neutral-900">+50%</span> on the winning adset</span></div>
        </>
      ),
    };
  }

  if (mode === "demote") {
    return {
      title: "Demote to test (Mode B)",
      subtitle: "Open Launchpad with this creative pre-selected?",
      icon: Rocket,
      iconBg: "bg-blue-100",
      iconText: "text-blue-600",
      primaryClassName: "bg-blue-600 hover:bg-blue-700",
      primaryLabel: "Open Launchpad",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Target picker filtered to <span className="font-medium text-neutral-900">test campaigns</span> (3 candidates)</span></div>
          <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><TrendingDown className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Re-evaluation threshold: <span className="font-mono tabular-nums font-medium text-neutral-900">$300 spend</span> in test</span></div>
        </>
      ),
    };
  }

  return {
    title: "Launch fresh test (Mode A)",
    subtitle: "Open Launchpad with this creative pre-selected?",
    icon: Rocket,
    iconBg: "bg-blue-100",
    iconText: "text-blue-600",
    primaryClassName: "bg-blue-600 hover:bg-blue-700",
    primaryLabel: "Open Launchpad",
    body: (
      <>
        <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Plus className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Mode A: new test campaign template pre-loaded</span></div>
        <div className="flex items-start gap-2"><span className="text-neutral-400 mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Default test budget: <span className="font-mono tabular-nums font-medium text-neutral-900">$50/day · 7d</span></span></div>
      </>
    ),
  };
}
