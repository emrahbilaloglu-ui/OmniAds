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
  /** Account currency for bid-cap display. Missing → values render without a
   *  currency symbol rather than a fabricated "$". */
  currencyCode?: string;
}

/** Honest bid-cap formatter: a missing value renders "—" (never a placeholder),
 *  and money uses the account currency instead of a hardcoded "$". */
function formatBidCap(value: number | undefined, currency: string | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return value.toLocaleString();
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
      className={`ad-final ${
        presentation === "modal"
          ? "fixed inset-0 z-50 bg-[rgba(16,18,22,0.4)] backdrop-blur-sm grid place-items-center p-6"
          : "relative grid place-items-stretch"
      }`}
      data-modal="launchpad"
      role={presentation === "modal" ? "dialog" : undefined}
      aria-modal={presentation === "modal" ? "true" : undefined}
      aria-labelledby="launchpad-overlay-title"
    >
      <div
        className="w-full max-w-[480px] rounded-2xl bg-[var(--adc-s2,#fff)] overflow-hidden"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <div className="px-5 py-4 border-b border-[var(--adc-b1,#e4e4e0)] flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full ${config.iconBg} grid place-items-center ${config.iconText} shrink-0`}>
            <Icon className="inline-block shrink-0" size={18} aria-hidden="true" />
          </div>
          <div className="flex-1">
            <div id="launchpad-overlay-title" className="text-[15px] font-semibold text-[var(--adc-ink,#1a1c1f)]">
              {config.title}
            </div>
            <div className="text-[12.5px] text-[var(--adc-ink3,#7d838c)] mt-0.5">{config.subtitle}</div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] p-3">
            <div className={`${bg} ${fg} rounded-md grid place-items-center font-semibold shrink-0`} style={{ width: 48, height: 48, fontSize: 14 }}>
              {initials(name)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-[var(--adc-ink,#1a1c1f)] truncate">{name}</div>
              <div className="text-[12px] text-[var(--adc-ink3,#7d838c)] truncate">
                {[item.brand, item.campaign].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="flex items-center gap-1 mt-1">
                <DecisionLabelChip label={label} size="sm" />
              </div>
            </div>
          </div>

          <div className="text-[12px] text-[var(--adc-ink2,#4a4f56)] space-y-1.5">{config.body}</div>
          {mode !== "apply_bid" ? (
            <div className="rounded-lg border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-3 py-2" data-testid="launchpad-handoff-unavailable">
              <div className="text-[12px] font-semibold text-[var(--adc-caution-fg)]">Stored LaunchIntent unavailable</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--adc-ink3,#7d838c)]">
                Current navigation passes legacy URL prefill only. Opening Launchpad starts manual setup and does not claim durable decision or brief lineage.
              </div>
            </div>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-md text-[var(--adc-ink2,#4a4f56)] hover:bg-[var(--adc-s2,#fff)] text-[12.5px]"
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
  const proposedBidText = formatBidCap(item.proposedBidCap, item.currencyCode);
  const currentBidText = formatBidCap(item.currentBidCap, item.currencyCode);

  if (mode === "rebuild") {
    return {
      title: "Rebuild in Launchpad",
      subtitle: "Open Launchpad with this campaign pre-loaded?",
      icon: RefreshCw,
      iconBg: "bg-[var(--adc-caution-bg)]",
      iconText: "text-[var(--adc-caution-fg)]",
      primaryClassName: "bg-[var(--adc-caution-fg)]",
      primaryLabel: "Open manual setup",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><RefreshCw className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Rebuild parameters and account-bound lineage are unavailable in the current handoff contract.</span></div>
        </>
      ),
    };
  }

  if (mode === "duplicate") {
    return {
      title: "Duplicate to test",
      subtitle: "Open Launchpad with this campaign duplicated to test environment?",
      icon: Copy,
      iconBg: "bg-[var(--adc-info-bg)]",
      iconText: "text-[var(--adc-info-fg)]",
      primaryClassName: "bg-[var(--adc-focus)]",
      primaryLabel: "Open manual setup",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Plus className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Target structure, test budget, and learning window are unavailable in the current handoff contract.</span></div>
        </>
      ),
    };
  }

  if (mode === "apply_bid") {
    return {
      title: item.proposedBidCap != null ? `Apply bid cap ${proposedBidText}` : "Apply bid cap",
      subtitle: "Inline application — no Launchpad teleport.",
      icon: Sliders,
      iconBg: "bg-[var(--adc-info-bg)]",
      iconText: "text-[var(--adc-info-fg)]",
      primaryClassName: "bg-[var(--adc-focus)]",
      primaryLabel: "Apply",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Sliders className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Current cap {currentBidText} → proposed {proposedBidText}. Re-enters learning briefly.</span></div>
        </>
      ),
    };
  }

  if (mode === "promote") {
    return {
      title: "Promote to main",
      subtitle: "Open Launchpad with this creative pre-selected?",
      icon: Rocket,
      iconBg: "bg-[var(--adc-info-bg)]",
      iconText: "text-[var(--adc-info-fg)]",
      primaryClassName: "bg-[var(--adc-focus)]",
      primaryLabel: "Open manual setup",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Suggested target and persisted promotion basis are unavailable in the current handoff contract.</span></div>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><TrendingUp className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>No budget change is prefilled or implied.</span></div>
        </>
      ),
    };
  }

  if (mode === "demote") {
    return {
      title: "Demote to test (Mode B)",
      subtitle: "Open Launchpad with this creative pre-selected?",
      icon: Rocket,
      iconBg: "bg-[var(--adc-info-bg)]",
      iconText: "text-[var(--adc-info-fg)]",
      primaryClassName: "bg-[var(--adc-focus)]",
      primaryLabel: "Open manual setup",
      body: (
        <>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Test target and evaluation scope are unavailable in the current handoff contract.</span></div>
          <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><TrendingDown className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>No re-evaluation threshold is prefilled or implied.</span></div>
        </>
      ),
    };
  }

  return {
    title: "Launch fresh test (Mode A)",
    subtitle: "Open Launchpad with this creative pre-selected?",
    icon: Rocket,
    iconBg: "bg-[var(--adc-info-bg)]",
    iconText: "text-[var(--adc-info-fg)]",
    primaryClassName: "bg-[var(--adc-focus)]",
    primaryLabel: "Open manual setup",
    body: (
      <>
        <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Plus className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>Stored test template and account-bound launch lineage are unavailable.</span></div>
        <div className="flex items-start gap-2"><span className="text-[var(--adc-ink3,#7d838c)] mt-0.5"><Target className="inline-block shrink-0" size={12} aria-hidden="true" /></span><span>No default budget or target is prefilled or implied.</span></div>
      </>
    ),
  };
}
