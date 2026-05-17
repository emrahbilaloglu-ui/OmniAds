"use client";

import { useId, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Gauge,
  Info,
  RefreshCw,
  ShieldCheck,
  Target,
  type LucideIcon,
} from "lucide-react";
import { PulseStrip } from "@/components/common/briefing";
import { DECISION_LABEL_PALETTE, TONE_CLASS } from "@/components/common/briefing/decision-label-palette";
import type { MetaPulsePayload, MetaWindowKey } from "@/components/meta/redesign/types";
import {
  BRIEFING_STATUS_FILTER_LABELS,
  BRIEFING_STATUS_FILTERS,
  type BriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent, formatRoas, sparklinePath } from "@/lib/briefing/utils";

interface MetaPulseProps {
  pulse?: MetaPulsePayload | null;
  window: MetaWindowKey;
  onWindowChange: (window: MetaWindowKey) => void;
  statusFilter: BriefingStatusFilter;
  onStatusFilterChange: (filter: BriefingStatusFilter) => void;
  onManageLabels?: () => void;
}

type TextTone = "neutral" | "success" | "warning" | "danger" | "dangerStrong";
type ChipTone = "neutral" | "success" | "warning" | "danger" | "info";

const WINDOWS: MetaWindowKey[] = ["7d", "14d", "28d", "90d", "custom"];

const TEXT_TONE_CLASSES: Record<TextTone, string> = {
  neutral: "text-slate-500",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-rose-600",
  dangerStrong: "text-rose-700 font-bold",
};

const VALUE_TONE_CLASSES: Record<TextTone, string> = {
  neutral: "text-slate-900",
  success: "text-emerald-700",
  warning: "text-amber-700",
  danger: "text-rose-600",
  dangerStrong: "text-rose-700 font-bold",
};

const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: DECISION_LABEL_PALETTE.test_more.metaClassName,
  success: DECISION_LABEL_PALETTE.scale.metaClassName,
  warning: DECISION_LABEL_PALETTE.refresh.metaClassName,
  danger: DECISION_LABEL_PALETTE.cut.metaClassName,
  info: TONE_CLASS.info,
};

function kpiDeltaValue(current: number | null | undefined, prev: number | null | undefined) {
  if (current == null || prev == null || prev === 0) return null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

function revenueDeltaTone(delta: number | null): TextTone {
  if (delta == null) return "neutral";
  if (delta < -25) return "dangerStrong";
  if (delta < -10) return "danger";
  if (delta > 10) return "success";
  return "neutral";
}

function cpaDeltaTone(delta: number | null): TextTone {
  if (delta == null) return "neutral";
  if (delta > 25) return "dangerStrong";
  if (delta > 10) return "danger";
  if (delta < -10) return "success";
  return "neutral";
}

function roasTargetTone(actual: number | null | undefined, target: number | null | undefined): {
  tone: TextTone;
  chipTone: ChipTone;
  label: string;
  ratio: number | null;
} {
  if (actual == null || target == null || target === 0) {
    return { tone: "neutral", chipTone: "neutral", label: "no target", ratio: null };
  }
  const ratio = actual / target;
  if (ratio < 0.7) return { tone: "dangerStrong", chipTone: "danger", label: "below target", ratio };
  if (ratio < 0.9) return { tone: "warning", chipTone: "warning", label: "below target", ratio };
  if (ratio <= 1.05) return { tone: "neutral", chipTone: "neutral", label: "on track", ratio };
  return { tone: "success", chipTone: "success", label: "above target", ratio };
}

function roasBenchmarkTone(roas: MetaPulsePayload["roas"] | null | undefined): {
  tone: TextTone;
  chipTone: ChipTone;
  label: string;
  ratio: number | null;
  benchmark: number | null;
  benchmarkLabel: "target" | "account median" | "benchmark";
  showChip: boolean;
} {
  if (!roas) {
    return {
      tone: "neutral",
      chipTone: "neutral",
      label: "no target",
      ratio: null,
      benchmark: null,
      benchmarkLabel: "benchmark",
      showChip: false,
    };
  }

  if (roas.target_source === "commercial_truth" && roas.target != null) {
    return {
      ...roasTargetTone(roas.d28, roas.target),
      benchmark: roas.target,
      benchmarkLabel: "target",
      showChip: true,
    };
  }

  if (roas.target_source === "account_median" && roas.median != null && roas.median > 0) {
    return {
      tone: "neutral",
      chipTone: "neutral",
      label: "account median",
      ratio: roas.d28 / roas.median,
      benchmark: roas.median,
      benchmarkLabel: "account median",
      showChip: false,
    };
  }

  return {
    tone: "neutral",
    chipTone: "neutral",
    label: "no benchmark",
    ratio: null,
    benchmark: null,
    benchmarkLabel: "benchmark",
    showChip: false,
  };
}

function roasWindowTone(value: number | null | undefined, target: number | null | undefined): TextTone {
  if (value == null) return "neutral";
  if (value < 1) return "dangerStrong";
  if (target && value < target) return "warning";
  return "neutral";
}

function chipClassName(tone: ChipTone) {
  return cn(
    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium",
    CHIP_TONE_CLASSES[tone],
  );
}

function formatDelta(delta: number | null) {
  if (delta == null) return null;
  return formatPercent(delta, 0, { signed: true });
}

function titleCase(value: string | null | undefined) {
  if (!value) return "";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function relativeTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

function PulseTooltip({
  children,
  title,
  body,
}: {
  children: ReactNode;
  title: string;
  body: string;
}) {
  const tooltipId = useId();
  return (
    <span className="group relative inline-flex" aria-describedby={tooltipId}>
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-[280px] -translate-x-1/2 rounded-xl border border-slate-200 bg-slate-950 px-3 py-2 text-left text-white opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="block text-[12px] font-semibold leading-snug">{title}</span>
        <span className="mt-1 block text-[11.5px] leading-snug text-slate-200">{body}</span>
        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-slate-200 bg-slate-950" />
      </span>
    </span>
  );
}

function KpiTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  chip,
}: {
  label: string;
  value: ReactNode;
  delta?: string | null;
  deltaTone?: TextTone;
  chip?: ReactNode;
}) {
  return (
    <div className="px-3 py-2 border-l border-slate-100 first:border-l-0">
      <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold">{label}</div>
      <div className="font-mono tabular-nums text-[15px] font-semibold text-slate-900">{value}</div>
      {delta || chip ? (
        <div className="mt-0.5 flex items-center gap-1.5">
          {delta ? (
            <div className={cn("text-[10.5px]", TEXT_TONE_CLASSES[deltaTone])}>{delta}</div>
          ) : null}
          {chip}
        </div>
      ) : null}
    </div>
  );
}

function EngineStatusPill({ pulse }: { pulse: MetaPulsePayload }) {
  const calibratedAgo = relativeTime(pulse.engineLastRun);
  const health = pulse.snapshotHealth;
  const ageMs = pulse.engineLastRun ? Date.now() - new Date(pulse.engineLastRun).getTime() : null;
  const ageDays = ageMs == null || !Number.isFinite(ageMs) ? null : ageMs / 86_400_000;
  const tone: ChipTone = health
    ? health.status === "fresh"
      ? "success"
      : health.status === "stale" || health.status === "engine_version_mismatch"
        ? "warning"
        : "danger"
    : ageDays == null ? "neutral" : ageDays <= 7 ? "success" : ageDays <= 14 ? "warning" : "danger";
  const status = health
    ? health.status === "fresh"
      ? "Live"
      : health.status === "engine_version_mismatch"
        ? "Version stale"
        : health.status === "missing"
          ? "Missing"
          : "Stale"
    : ageDays == null ? "Syncing" : ageDays <= 7 ? "Live" : "Stale";
  const versionLabel = pulse.engineVersion?.trim() ? pulse.engineVersion : "Meta engine";

  return (
    <PulseTooltip
      title="Engine status"
      body={[
        `${pulse.engineVersion} · ${calibratedAgo ? `calibrated ${calibratedAgo}` : "calibration time unavailable"}`,
        health?.latestSnapshotDate ? `snapshot ${health.latestSnapshotDate}` : null,
        health?.staleReason ?? null,
      ].filter(Boolean).join(" · ")}
    >
      <span className={chipClassName(tone)}>
        <ShieldCheck className="inline-block shrink-0" size={11} aria-hidden="true" />
        {versionLabel} · {status}
      </span>
    </PulseTooltip>
  );
}

function LabelCoveragePill({
  pulse,
  onManageLabels,
}: {
  pulse: MetaPulsePayload;
  onManageLabels?: () => void;
}) {
  const coverage = pulse.labelCoverage;
  if (!coverage || coverage.activeCampaigns === 0) return null;
  const complete = coverage.unlabeledCampaigns === 0;
  const className = chipClassName(complete ? "success" : "warning");
  const content = (
    <>
      <Info className="inline-block shrink-0" size={10} aria-hidden="true" />
      Labels {coverage.labeledCampaigns}/{coverage.activeCampaigns}
    </>
  );
  return (
    <PulseTooltip
      title="Campaign label coverage"
      body={`${coverage.labeledCampaigns}/${coverage.activeCampaigns} active campaigns have Main/Test/Mixed context.${coverage.latestUpdatedAt ? ` Last label update ${relativeTime(coverage.latestUpdatedAt) ?? coverage.latestUpdatedAt}.` : ""}`}
    >
      {onManageLabels ? (
        <button type="button" className={className} onClick={onManageLabels}>
          {content}
        </button>
      ) : (
        <span className={className}>{content}</span>
      )}
    </PulseTooltip>
  );
}

function TargetAnchorPill({ pulse }: { pulse: MetaPulsePayload }) {
  const target = pulse.targetAnchor;
  const configured = target?.configured === true || pulse.roas.target_source === "commercial_truth";
  return (
    <PulseTooltip
      title="Commercial target anchor"
      body={
        configured
          ? "Commercial target or break-even anchor is configured for hard scale and cut calibration."
          : "No target pack anchor is configured. Hard commercial actions remain capped or review-bound."
      }
    >
      <a href="/commercial-truth" className={chipClassName(configured ? "success" : "warning")}>
        <Target className="inline-block shrink-0" size={10} aria-hidden="true" />
        {configured ? "Targets set" : "Targets missing"}
      </a>
    </PulseTooltip>
  );
}

function TrackingHealthPill({ pulse }: { pulse: MetaPulsePayload }) {
  const status = pulse.trackingHealth?.status;
  if (!status || status === "unknown") return null;

  let tone: ChipTone = "neutral";
  let Icon: LucideIcon = RefreshCw;
  let label = "Tracking syncing";

  if (status === "healthy") {
    tone = "success";
    Icon = ShieldCheck;
    label = "Tracking healthy";
  } else if (status === "degraded" || status === "blocked") {
    tone = "danger";
    Icon = AlertTriangle;
    label = "Tracking degraded";
  }

  return (
    <span className={chipClassName(tone)}>
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

function modeTone(mode: string | null | undefined): ChipTone {
  const normalized = (mode ?? "").toLowerCase();
  if (normalized.includes("aggressive") || normalized.includes("exploit") || normalized.includes("scale")) {
    return "success";
  }
  if (normalized.includes("defensive") || normalized.includes("stabilize")) return "warning";
  if (normalized.includes("recovery") || normalized.includes("unstable")) return "danger";
  return "neutral";
}

function regimeTone(regime: string | null | undefined): ChipTone {
  const normalized = (regime ?? "").toLowerCase();
  if (normalized === "peak") return "success";
  if (normalized === "post_peak" || normalized === "post peak") return "warning";
  if (normalized === "unstable") return "danger";
  return "neutral";
}

function RoasSparkline({
  values,
  target,
}: {
  values: number[] | null | undefined;
  target: number | null | undefined;
}) {
  if (!values?.length) return null;
  const path = sparklinePath(values.slice(-28));
  const recent = values.slice(-7);
  const tone =
    recent.some((value) => value < 1)
      ? "text-rose-700"
      : target && recent.some((value) => value < target)
        ? "text-amber-700"
        : "text-slate-400";
  return (
    <svg
      width="80"
      height="16"
      viewBox="0 0 60 16"
      className={cn("inline-block shrink-0", tone)}
      aria-label="28 day ROAS sparkline"
      data-roas-sparkline="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MultiWindowRoas({ pulse }: { pulse?: MetaPulsePayload | null }) {
  if (!pulse) {
    return <span className="font-mono text-slate-700">7d — / 14d — / 28d —</span>;
  }
  const target = pulse.roas.target_source === "commercial_truth" ? pulse.roas.target : null;

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono tabular-nums">
        {([
          ["7d", pulse.roas.d7],
          ["14d", pulse.roas.d14],
          ["28d", pulse.roas.d28],
        ] as const).map(([label, value], index) => (
          <span key={label}>
            {index > 0 ? <span className="mx-1.5 text-slate-400">/</span> : null}
            <span className="text-slate-500">{label} </span>
            <span
              className={cn(TEXT_TONE_CLASSES[roasWindowTone(value, target)])}
              data-roas-window={label}
            >
              {formatRoas(value)}
            </span>
          </span>
        ))}
      </span>
      <RoasSparkline values={pulse.roasHistory} target={target} />
    </span>
  );
}

function PaceMeter({ pulse }: { pulse?: MetaPulsePayload | null }) {
  if (!pulse) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-600">
        <Gauge className="inline-block shrink-0 text-slate-400" size={13} aria-hidden="true" />
        Daily pace · —
      </span>
    );
  }

  const pace = `${Math.round(pulse.pacing.dayPace * 100)}%`;
  const spendToday = pulse.pacing.spendToday;
  const dailyTarget = pulse.pacing.dailyTarget;
  const hasDaily = spendToday != null && dailyTarget != null;
  const hasMtd = pulse.pacing.mtdSpend != null && pulse.pacing.mtdTarget != null;

  if (hasDaily) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-600">
        <Gauge className="inline-block shrink-0 text-slate-400" size={13} aria-hidden="true" />
        Daily pace ·{" "}
        <span className="font-mono text-slate-900">
          {formatCurrency(spendToday)} of {formatCurrency(dailyTarget)}
        </span>{" "}
        · <span className="font-mono text-slate-900">{pace}</span>
      </span>
    );
  }

  if (hasMtd) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-600">
        <Gauge className="inline-block shrink-0 text-slate-400" size={13} aria-hidden="true" />
        Spend pace ·{" "}
        <span className="font-mono text-slate-900">
          {formatCurrency(pulse.pacing.mtdSpend)} of {formatCurrency(pulse.pacing.mtdTarget)}
        </span>{" "}
        · <span className="font-mono text-slate-900">{pace}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-slate-600">
      <Gauge className="inline-block shrink-0 text-slate-400" size={13} aria-hidden="true" />
      Daily pace · <span className="font-mono text-slate-900">{pace}</span>
    </span>
  );
}

function SyncIndicator({ pulse }: { pulse?: MetaPulsePayload | null }) {
  const syncedAgo = relativeTime(pulse?.lastSyncAt);
  if (!syncedAgo) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-slate-500">
      <RefreshCw className="inline-block shrink-0" size={11} aria-hidden="true" />
      Synced {syncedAgo}
    </span>
  );
}

function Divider() {
  return <span className="h-5 w-px bg-slate-200" data-pulse-divider="true" aria-hidden="true" />;
}

export function MetaPulse({
  pulse,
  window,
  onWindowChange,
  statusFilter,
  onStatusFilterChange,
  onManageLabels,
}: MetaPulseProps) {
  const selectedWindowLabel = window === "custom" ? "Custom" : window;
  const revenueDelta = pulse ? kpiDeltaValue(pulse.revenue.current, pulse.revenue.prev) : null;
  const cpaDelta = pulse ? kpiDeltaValue(pulse.cpa.current, pulse.cpa.prev) : null;
  const spendDelta = pulse ? kpiDeltaValue(pulse.spend.current, pulse.spend.prev) : null;
  const roasTone = pulse ? roasBenchmarkTone(pulse.roas) : null;
  const roasPercent = roasTone?.ratio == null ? null : Math.floor(roasTone.ratio * 100);

  return (
    <PulseStrip
      variant="meta"
      sticky={false}
      left={
        <div className="flex items-center gap-2" data-pulse-band="controls">
          <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700">
            Scope: Account
            <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
          </label>
          <label className="relative inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700">
            <span>Date: {selectedWindowLabel}</span>
            <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
            <select
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              value={window}
              aria-label="Meta briefing date range"
              onChange={(event) => onWindowChange(event.currentTarget.value as MetaWindowKey)}
            >
              {WINDOWS.map((item) => (
                <option key={item} value={item}>
                  {item === "custom" ? "Custom" : item}
                </option>
              ))}
            </select>
          </label>
          <div
            className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5"
            data-meta-status-filter
            role="group"
            aria-label="Meta briefing status scope"
          >
            {BRIEFING_STATUS_FILTERS.map((item) => (
              <button
                key={item}
                type="button"
                className={cn(
                  "rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors",
                  item === statusFilter
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
                )}
                data-status-filter-option={item}
                aria-pressed={item === statusFilter}
                onClick={() => onStatusFilterChange(item)}
              >
                {BRIEFING_STATUS_FILTER_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
      }
      center={
        <div className="flex items-center gap-3 flex-wrap text-[12px]" data-pulse-band="engine-context">
          <Divider />
          <PaceMeter pulse={pulse} />
          <MultiWindowRoas pulse={pulse} />
          <span className="text-slate-500">
            {pulse ? `based on ${pulse.matureCampaigns} mature campaigns` : "Loading campaigns"}
          </span>
        </div>
      }
      right={
        <div className="flex items-center gap-1.5 flex-wrap" data-pulse-band="status">
          <Divider />
          {pulse ? <EngineStatusPill pulse={pulse} /> : null}
          {pulse ? <LabelCoveragePill pulse={pulse} onManageLabels={onManageLabels} /> : null}
          {pulse ? <TargetAnchorPill pulse={pulse} /> : null}
          {pulse ? <TrackingHealthPill pulse={pulse} /> : null}
          {pulse?.operatingMode ? (
            <span className={chipClassName(modeTone(pulse.operatingMode))}>Mode: {titleCase(pulse.operatingMode)}</span>
          ) : null}
          {pulse?.seasonalRegime ? (
            <span className={chipClassName(regimeTone(pulse.seasonalRegime))}>
              Regime: {titleCase(pulse.seasonalRegime)}
            </span>
          ) : null}
          <SyncIndicator pulse={pulse} />
        </div>
      }
      jumpNav={
        <>
          <a href="#action-now" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Action Now</a>
          <a href="#watching" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Watching</a>
          <a href="#healthy" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Healthy</a>
          <a href="#non-sales" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Out of Scope</a>
          <a href="#archive" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Archive</a>
        </>
      }
      kpiBand={
        <>
          <KpiTile
            label="Spend"
            value={pulse ? formatCurrency(pulse.spend.current) : "—"}
            delta={formatDelta(spendDelta)}
            deltaTone="neutral"
          />
          <KpiTile
            label="Revenue"
            value={pulse ? formatCurrency(pulse.revenue.current) : "—"}
            delta={formatDelta(revenueDelta)}
            deltaTone={revenueDeltaTone(revenueDelta)}
          />
          <KpiTile
            label="CPA"
            value={!pulse ? "—" : pulse.cpa.current == null ? "—" : formatCurrency(pulse.cpa.current)}
            delta={formatDelta(cpaDelta)}
            deltaTone={cpaDeltaTone(cpaDelta)}
          />
          <KpiTile
            label="ROAS vs target"
            value={
              pulse && roasTone ? (
                <span className="inline-flex items-baseline gap-1.5">
                  <span className={cn("font-mono tabular-nums", VALUE_TONE_CLASSES[roasTone.tone])}>
                    {formatRoas(pulse.roas.d28)}
                  </span>
                  {roasTone.benchmark == null ? (
                    <span className="text-[11px] font-normal text-slate-400">no benchmark available</span>
                  ) : (
                    <span className="text-[11px] font-normal text-slate-400">
                      of {formatRoas(roasTone.benchmark)} {roasTone.benchmarkLabel}
                    </span>
                  )}
                  {roasTone.benchmark == null || roasPercent == null ? null : (
                    <span className={cn("font-mono tabular-nums", VALUE_TONE_CLASSES[roasTone.tone])}>
                      · {roasPercent}%
                    </span>
                  )}
                </span>
              ) : "—"
            }
            chip={
              roasTone?.showChip ? (
                <span className={chipClassName(roasTone.chipTone)}>
                  <Info className="inline-block shrink-0" size={10} aria-hidden="true" />
                  {roasTone.label}
                </span>
              ) : null
            }
          />
        </>
      }
    />
  );
}

// TODO operating-mode: render a standalone stabilize action only after the
// lib/business-operating-mode.ts runbook/action handler is wired to this strip.
