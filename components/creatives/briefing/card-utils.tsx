import type { ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Clock,
  Database,
  FileText,
  PieChart,
  SkipForward,
  Sparkles,
  Target,
  TrendingDown,
  User,
  ZapOff,
} from "lucide-react";
import {
  ConfidencePill,
  DecisionLabelChip,
  type EvidenceAccordionSection,
} from "@/components/common/briefing";
import type { DecisionLabel } from "@/components/common/briefing/types";
import {
  formatCurrency,
  formatRoas,
  initials,
  sparklinePath,
  tileFor,
} from "@/lib/briefing/utils";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

const VALID_DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "cut",
  "refresh",
  "keep",
  "test_more",
  "diagnose",
  "below_breakeven",
  "fatigue",
  "rebuild",
  "switch",
  "tune",
  "swap",
  "review_placements",
  "review_adsets",
  "out_of_scope",
]);

export function asDecisionLabel(
  value: unknown,
  fallback: DecisionLabel = "out_of_scope",
): DecisionLabel {
  return typeof value === "string" &&
    VALID_DECISION_LABELS.has(value as DecisionLabel)
    ? (value as DecisionLabel)
    : fallback;
}

export function cardId(card: Pick<BriefingCreativeCard, "id" | "creativeId">) {
  return safeCardText(card.id) || safeCardText(card.creativeId) || "creative";
}

export function cardName(
  card: Pick<BriefingCreativeCard, "name" | "creativeName">,
) {
  return (
    safeCardText(card.name) ||
    safeCardText(card.creativeName) ||
    "Untitled creative"
  );
}

export function cardCampaign(
  card: Pick<BriefingCreativeCard, "campaign" | "campaignName">,
) {
  return (
    safeCardText(card.campaign) || safeCardText(card.campaignName) || "Campaign"
  );
}

export function cardAdset(
  card: Pick<BriefingCreativeCard, "adset" | "adsetName">,
) {
  return safeCardText(card.adset) || safeCardText(card.adsetName) || "Ad set";
}

function safeCardText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function numberOrZero(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function hasMetricValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatOptionalFixed(
  value: number | null | undefined,
  digits: number,
  suffix = "",
) {
  return hasMetricValue(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

export function formatOptionalInteger(value: number | null | undefined) {
  return hasMetricValue(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

export function formatOptionalCurrency(value: number | null | undefined) {
  return hasMetricValue(value) ? formatCurrency(value) : "—";
}

export function formatOptionalRoas(value: number | null | undefined) {
  return hasMetricValue(value) ? formatRoas(value) : "—";
}

function mediaUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function briefingPreviewPayload(card: BriefingCreativeCard) {
  const preview = card.preview;
  if (preview) {
    return {
      render_mode: preview.render_mode,
      image_url: mediaUrl(preview.image_url),
      video_url: mediaUrl(preview.video_url),
      poster_url: mediaUrl(preview.poster_url),
      source: preview.source,
      is_catalog: Boolean(preview.is_catalog),
    };
  }
  const image = mediaUrl(card.mediaPreviewUrl) ?? mediaUrl(card.cardPreviewUrl) ?? mediaUrl(card.imageUrl) ?? mediaUrl(card.previewUrl) ?? mediaUrl(card.thumbnailUrl);
  return {
    render_mode: image ? "image" as const : "unavailable" as const,
    image_url: image,
    video_url: null,
    poster_url: mediaUrl(card.tableThumbnailUrl) ?? mediaUrl(card.cachedThumbnailUrl) ?? image,
    source: image ? "briefing_media" : null,
    is_catalog: Boolean(card.isCatalog),
  };
}

export function briefingMediaFallbacks(card: BriefingCreativeCard, mode: "card" | "thumb" = "card") {
  const candidates =
    mode === "thumb"
      ? [
          card.tableThumbnailUrl,
          card.cachedThumbnailUrl,
          card.thumbnailUrl,
          card.mediaPreviewUrl,
          card.cardPreviewUrl,
          card.imageUrl,
          card.previewUrl,
          card.preview?.poster_url,
          card.preview?.image_url,
        ]
      : [
          card.mediaPreviewUrl,
          card.cardPreviewUrl,
          card.imageUrl,
          card.preview?.image_url,
          card.preview?.poster_url,
          card.previewUrl,
          card.cachedThumbnailUrl,
          card.thumbnailUrl,
          card.tableThumbnailUrl,
        ];
  return candidates.map(mediaUrl).filter((value): value is string => Boolean(value));
}

export function confidenceValue(
  card: Pick<BriefingCreativeCard, "confidence">,
) {
  return hasMetricValue(card.confidence)
    ? Math.max(0, Math.min(100, Math.round(card.confidence)))
    : null;
}

export function Thumb({
  name,
  size,
  className,
}: {
  name: string;
  size: "lg" | "md" | "sm" | "xs";
  className?: string;
}) {
  const [bg, fg] = tileFor(name);
  const dim = size === "lg" ? 88 : size === "md" ? 72 : size === "sm" ? 64 : 28;
  const fontSize =
    size === "lg" ? 22 : size === "md" ? 18 : size === "sm" ? 15 : 10;

  return (
    <div
      className={[
        bg,
        fg,
        size === "xs" ? "rounded-md" : "rounded-xl",
        size === "xs" ? "w-7 h-7 text-[12px]" : "",
        "grid place-items-center font-semibold tracking-tight shrink-0 select-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: dim, height: dim, fontSize }}
    >
      {initials(name)}
    </div>
  );
}

export function BadgeChip({ label }: { label: DecisionLabel | string }) {
  if (label === "unlabeled_campaign_context") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[12px] font-medium text-amber-800"
        title="Campaign label missing. Mark this campaign as Main, Test, or Mixed before hard actions."
      >
        <AlertTriangle
          className="inline-block shrink-0"
          size={11}
          aria-hidden="true"
        />
        campaign label
      </span>
    );
  }

  if (label === "scale_readiness_blocked") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[12px] font-medium text-blue-700"
        title="This is a scale-zone creative, but the engine withheld hard scale until all scale readiness gates are met."
      >
        <Target
          className="inline-block shrink-0"
          size={11}
          aria-hidden="true"
        />
        near scale
      </span>
    );
  }

  if (label === "scale_calibration_thin") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[12px] font-medium text-amber-800"
        title="Hard scale is blocked because the account winner benchmark is missing or the calibration sample is too thin."
      >
        <Database
          className="inline-block shrink-0"
          size={11}
          aria-hidden="true"
        />
        scale sample
      </span>
    );
  }

  const safeLabel = asDecisionLabel(label);
  const Icon = safeLabel === "below_breakeven" ? TrendingDown : ZapOff;

  return (
    <DecisionLabelChip label={safeLabel} size="sm">
      <Icon className="inline-block shrink-0" size={11} aria-hidden="true" />
      {safeLabel.replace(/_/g, " ")}
    </DecisionLabelChip>
  );
}

export function CampaignKindChip({
  card,
}: {
  card: Pick<
    BriefingCreativeCard,
    | "campaignKind"
    | "campaignLabelStatus"
    | "campaignTestDimension"
    | "blockedActionType"
  >;
}) {
  if (card.campaignLabelStatus === "no_campaign") return null;

  if (card.campaignLabelStatus === "unlabeled") {
    const detail = card.blockedActionType
      ? `Engine wanted ${card.blockedActionType}, blocked until Main/Test/Mixed is labeled.`
      : "Campaign label missing.";
    return (
      <span
        className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[12px] font-semibold text-amber-800"
        title={detail}
      >
        Unlabeled
      </span>
    );
  }

  if (!card.campaignKind) return null;

  const label =
    card.campaignKind === "main"
      ? "Main"
      : card.campaignKind === "test"
        ? "Test"
        : "Mixed";
  const tone =
    card.campaignKind === "main"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : card.campaignKind === "test"
        ? "border-blue-200 bg-blue-50 text-blue-700"
        : "border-neutral-200 bg-neutral-50 text-neutral-700";
  const detail = card.campaignTestDimension
    ? `${label}: ${card.campaignTestDimension}`
    : label;

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[12px] font-semibold ${tone}`}
      title={detail}
    >
      {label}
    </span>
  );
}

// Triple-Whale-calm sparkline signature: a thin blue->emerald gradient line,
// no area fill, rounded caps. Every gradient is identical so one shared id is
// safe and SSR-stable. Callers may still pass a semantic tone (emerald/rose)
// to encode direction; that renders as a solid currentColor stroke instead.
const SPARK_GRADIENT_ID = "adsecute-spark-gradient";

export function Sparkline({
  values,
  tone = "text-neutral-400",
  width = 80,
  height = 22,
}: {
  values?: number[] | null;
  tone?: string;
  width?: number;
  height?: number;
}) {
  const normalizedValues =
    Array.isArray(values) && values.length > 0 ? values : [0, 0];
  const useGradient = !tone || tone === "text-neutral-400";

  return (
    <svg
      viewBox="0 0 60 16"
      width={width}
      height={height}
      className={useGradient ? undefined : tone}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {useGradient ? (
        <defs>
          <linearGradient id={SPARK_GRADIENT_ID} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--brand, #2f6bff)" />
            <stop offset="100%" stopColor="var(--ok, #0e9f6e)" />
          </linearGradient>
        </defs>
      ) : null}
      <path
        d={sparklinePath(normalizedValues)}
        fill="none"
        stroke={useGradient ? `url(#${SPARK_GRADIENT_ID})` : "currentColor"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CtrBar({
  value,
  p50,
}: {
  value?: number | null;
  p50?: number | null;
}) {
  const hasCtr = hasMetricValue(value);
  const hasP50 = hasMetricValue(p50) && p50 > 0;
  const ctr = hasCtr ? value : 0;
  const midpoint = hasP50 ? p50 : 1.1;
  const pct = Math.min(100, (ctr / (midpoint * 2)) * 100);
  const isAbove = hasCtr && ctr >= midpoint;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] text-neutral-500">CTR</span>
      <div className="relative w-20 h-1.5 bg-neutral-100 rounded-full overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 ${
            hasCtr ? (isAbove ? "bg-emerald-500" : "bg-rose-500") : "bg-neutral-300"
          }`}
          style={{ width: hasCtr ? `${pct}%` : "0%" }}
        />
        <div
          className="absolute inset-y-0 w-px bg-neutral-400"
          style={{ left: "50%" }}
        />
      </div>
      <span
        className={`font-mono tabular-nums text-[12px] font-medium ${
          hasCtr ? (isAbove ? "text-emerald-700" : "text-rose-700") : "text-neutral-500"
        }`}
      >
        {hasCtr ? `${ctr.toFixed(2)}%` : "—"}
      </span>
      <span className="font-mono tabular-nums text-[12px] text-neutral-400">
        P50 {hasP50 ? `${midpoint.toFixed(2)}%` : "—"}
      </span>
    </div>
  );
}

export function FatigueDot({ active }: { active?: boolean | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[12px] ${
        active ? "text-amber-700" : "text-neutral-400"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${active ? "bg-amber-500" : "bg-neutral-300"}`}
      />
      {active ? "Fatigued" : "Stable"}
    </span>
  );
}

export function MetricDivider() {
  return <span className="text-neutral-200">·</span>;
}

export function PrimaryActionButton({
  kind,
  label,
  primaryStyle,
  onClick,
  disabled = false,
}: {
  kind?: string | null;
  label?: string | null;
  primaryStyle: "filled" | "outline";
  onClick?: () => void;
  disabled?: boolean;
}) {
  const actionKind = kind || "review";
  const actionLabel = label || "Review";
  const teleports =
    actionKind === "promote" ||
    actionKind === "demote" ||
    actionKind === "fresh_test";
  const isCut = actionKind === "cut" || actionKind === "pause";
  const isFilled = primaryStyle === "filled";
  let toneClass: string;

  if (isCut) {
    toneClass = isFilled
      ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
      : "border-rose-300 text-rose-700 hover:bg-rose-50";
  } else if (
    actionKind === "promote" ||
    actionKind === "scale" ||
    actionKind === "scale_budget" ||
    actionKind === "controlled_scale"
  ) {
    toneClass = isFilled
      ? "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
      : "border-emerald-300 text-emerald-700 hover:bg-emerald-50";
  } else if (actionKind === "review_placements") {
    toneClass = isFilled
      ? "bg-neutral-800 text-white border-neutral-800 hover:bg-neutral-900"
      : "border-neutral-300 text-neutral-700 hover:bg-neutral-50";
  } else {
    toneClass = isFilled
      ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
      : "border-blue-300 text-blue-700 hover:bg-blue-50";
  }

  return (
    <button
      type="button"
      data-action="primary"
      data-kind={actionKind}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-60 ${toneClass}`}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {actionLabel}
      {teleports ? (
        <ArrowRight
          className="ml-1 -mr-0.5 inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}

export function SecondaryButton({
  children,
  icon,
  onClick,
  disabled = false,
  "data-action": dataAction,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  "data-action"?: string;
}) {
  return (
    <button
      type="button"
      data-action={dataAction}
      disabled={disabled}
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50 text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold">
        {label}
      </div>
      <div className="font-mono tabular-nums text-neutral-900 text-[12.5px] font-medium">
        {children}
      </div>
    </div>
  );
}

function formatBlockerValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatMaybeNumber(value: number | null | undefined, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function formatMaybeCurrency(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatCurrency(value)
    : "—";
}

function BlockersBody({ card }: { card: BriefingCreativeCard }) {
  const blockers = card.blockers ?? [];
  if (blockers.length === 0) {
    return (
      <p className="text-[12px] text-neutral-500">
        No structured blocker predicates supplied.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200">
      <div className="grid grid-cols-[1.35fr_1fr_1fr_0.8fr] gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
        <span>Predicate</span>
        <span>Observed</span>
        <span>Threshold</span>
        <span>Status</span>
      </div>
      {blockers.map((blocker, index) => (
        <div
          key={`${blocker.predicate}-${index}`}
          className="grid grid-cols-[1.35fr_1fr_1fr_0.8fr] gap-2 border-b border-neutral-100 px-2 py-1.5 text-[12px] last:border-b-0"
        >
          <div>
            <div className="font-mono text-[11.5px] text-neutral-900">
              {blocker.predicate}
            </div>
            {blocker.reason ? (
              <div className="mt-0.5 text-[11px] leading-snug text-neutral-500">
                {blocker.reason}
              </div>
            ) : null}
          </div>
          <span className="font-mono tabular-nums text-neutral-700">
            {formatBlockerValue(blocker.observed)}
          </span>
          <span className="font-mono tabular-nums text-neutral-700">
            {formatBlockerValue(blocker.threshold)}
          </span>
          <span className="font-medium text-neutral-700">
            {blocker.status ?? "failed"}
          </span>
        </div>
      ))}
    </div>
  );
}

// Mirrors the server-side reliable-sample default (minSegmentSampleSize in
// lib/creative-decision-engine/backtest.ts). The sample size itself is a
// server field; this constant only phrases the honesty copy.
const MIN_RELIABLE_CALIBRATION_SAMPLE = 30;

function ExplainabilityBody({ card }: { card: BriefingCreativeCard }) {
  const proof = card.explainability;
  const priority = card.priorityScore;
  const missingEvidence = proof?.missingEvidence ?? [];
  const nearMisses = proof?.nearMisses ?? [];
  const thresholdProvenance = proof?.thresholdProvenance ?? null;

  return (
    <div className="space-y-3">
      {thresholdProvenance ? (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-neutral-600">
          <span className="inline-flex items-center rounded border border-neutral-200 bg-white px-2 py-1 font-medium">
            Calibration{" "}
            {thresholdProvenance.calibrationComputedAt
              ? thresholdProvenance.calibrationComputedAt.slice(0, 10)
              : "unknown"}
          </span>
          <span className="inline-flex items-center rounded border border-neutral-200 bg-white px-2 py-1 font-medium">
            Refit due{" "}
            {thresholdProvenance.refitDueAt
              ? thresholdProvenance.refitDueAt.slice(0, 10)
              : "unknown"}
          </span>
          <span className="inline-flex items-center rounded border border-neutral-200 bg-white px-2 py-1 font-medium">
            {thresholdProvenance.source.replace(/_/g, " ")}
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-4 gap-3 text-[12px]">
        <Kv label="Target ROAS">
          {typeof proof?.targetRoas === "number"
            ? formatRoas(proof.targetRoas)
            : "—"}
        </Kv>
        <Kv label="Ratio to target">
          {formatMaybeNumber(proof?.ratioToTarget, 2)}
        </Kv>
        <Kv label="Threshold source">
          {proof?.thresholdSource?.replace(/_/g, " ") ?? "—"}
        </Kv>
        <Kv label="Threshold quality">
          {proof?.thresholdQuality ?? "—"}
        </Kv>
        <Kv label="Spend unit">
          {formatMaybeCurrency(proof?.spendUnit)}
        </Kv>
        <Kv label="Maturity spend">
          {formatMaybeCurrency(proof?.commercialMaturitySpend)}
        </Kv>
        <Kv label="Hard cut spend">
          {formatMaybeCurrency(proof?.hardCutSpend)}
        </Kv>
        <Kv label="Scale purchases">
          {typeof proof?.scaleMinPurchases === "number"
            ? proof.scaleMinPurchases
            : "—"}
        </Kv>
        <Kv label="Hist. precision">
          {formatMaybeNumber(proof?.historicalPrecision, 2)}
        </Kv>
        <Kv label="Hist. recall">
          {formatMaybeNumber(proof?.historicalRecall, 2)}
        </Kv>
        <Kv label="ECE">
          {formatMaybeNumber(proof?.expectedCalibrationError, 3)}
        </Kv>
        <Kv label="Sample">
          {typeof proof?.empiricalSampleSize === "number"
            ? proof.empiricalSampleSize.toLocaleString("en-US")
            : "—"}
        </Kv>
        <Kv label="Obs. @ conf">
          {typeof proof?.bucketObservedRate === "number"
            ? `${Math.round(proof.bucketObservedRate * 100)}% (n=${proof.bucketObservedSampleSize ?? 0}${(proof.bucketObservedSampleSize ?? 0) < MIN_RELIABLE_CALIBRATION_SAMPLE ? ", thin" : ""})`
            : "—"}
        </Kv>
      </div>
      {proof &&
      (typeof proof.empiricalSampleSize !== "number" ||
        proof.empiricalSampleSize < MIN_RELIABLE_CALIBRATION_SAMPLE) ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-800">
          Calibration not proven:{" "}
          {typeof proof.empiricalSampleSize === "number"
            ? `only ${proof.empiricalSampleSize.toLocaleString("en-US")} hard-action outcome${proof.empiricalSampleSize === 1 ? "" : "s"}`
            : "no realized-outcome window"}{" "}
          for this engine version (needs {MIN_RELIABLE_CALIBRATION_SAMPLE}).
          Precision, recall, and ECE above are directional, not proof.
        </div>
      ) : null}
      {priority ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-[12px] text-neutral-700">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-neutral-900">
              Priority {priority.band}
            </span>
            <span className="font-mono tabular-nums">
              {priority.score.toLocaleString("en-US")}
            </span>
            <span className="text-neutral-400">·</span>
            <span>{priority.reason}</span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">
            spend at risk {formatCurrency(priority.inputs.spendAtRisk)} ·
            opportunity {formatCurrency(priority.inputs.opportunityValue)} ·
            confidence factor {priority.inputs.confidenceFactor.toFixed(2)}
          </div>
        </div>
      ) : null}
      {nearMisses.length > 0 ? (
        <div className="rounded-md border border-blue-100 bg-blue-50/70 px-2.5 py-2 text-[12px] text-neutral-700">
          <div className="font-semibold text-neutral-900">
            What would flip this decision?
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {nearMisses.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {missingEvidence.length > 0 ? (
        <div className="text-[11.5px] text-neutral-500">
          Missing proof: {missingEvidence.join(", ").replace(/_/g, " ")}
        </div>
      ) : null}
    </div>
  );
}

function TrailItem({
  version,
  date,
  label,
  why,
}: {
  version: string;
  date: string;
  label: string;
  why: string;
}) {
  return (
    <li className="relative">
      <span className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-white border-2 border-neutral-300" />
      <div className="flex items-center gap-2 text-neutral-900 font-medium text-[12px]">
        {label}
      </div>
      <div className="text-[11px] text-neutral-500 flex items-center gap-2">
        <span className="font-mono tabular-nums">{date}</span>
        <span className="text-neutral-300">·</span>
        <span>{version}</span>
        <span className="text-neutral-300">·</span>
        <span className="italic">{why}</span>
      </div>
    </li>
  );
}

function wholeNumberOrZero(value: number | null | undefined) {
  return Math.max(0, Math.round(numberOrZero(value)));
}

function funnelBarPct(value: number, denominator: number) {
  if (value <= 0 || denominator <= 0) return 0;
  return Math.min(100, Math.max(2, (value / denominator) * 100));
}

function FunnelBody({ card }: { card: BriefingCreativeCard }) {
  const impressions = wholeNumberOrZero(card.impressions);
  const linkClicks = wholeNumberOrZero(card.linkClicks);
  const addToCart = wholeNumberOrZero(card.addToCart);
  const purchases = wholeNumberOrZero(card.purchases);
  const denominator =
    impressions > 0 ? impressions : Math.max(linkClicks, addToCart, purchases);

  if (denominator <= 0) {
    return (
      <p className="text-[12px] text-neutral-500">Funnel counts unavailable.</p>
    );
  }

  const stages = [
    {
      name: "Impressions",
      value: impressions,
      pct: funnelBarPct(impressions, denominator),
    },
    {
      name: "Link clicks",
      value: linkClicks,
      pct: funnelBarPct(linkClicks, denominator),
    },
    {
      name: "Add to cart",
      value: addToCart,
      pct: funnelBarPct(addToCart, denominator),
    },
    {
      name: "Purchases",
      value: purchases,
      pct: funnelBarPct(purchases, denominator),
    },
  ];

  return (
    <div className="space-y-1.5">
      {stages.map((stage) => (
        <div key={stage.name} className="flex items-center gap-2 text-[12px]">
          <span className="w-24 text-neutral-500">{stage.name}</span>
          <div className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500"
              style={{ width: `${stage.pct}%` }}
            />
          </div>
          <span className="font-mono tabular-nums text-neutral-900 w-20 text-right">
            {stage.value.toLocaleString("en-US")}
          </span>
        </div>
      ))}
    </div>
  );
}

export function buildEvidenceSections(
  card: BriefingCreativeCard,
): EvidenceAccordionSection[] {
  const label = asDecisionLabel(card.label);
  const confidence = confidenceValue(card);
  const reason = card.reason || "No engine reason supplied.";
  const predictive = card.predictive;
  const primaryLabel = card.primary?.label || "—";
  const engineVersion = safeCardText(card.engineVersion) || "Engine v3";
  const sourceAsOf = safeCardText(card.sourceAsOf) || "Current request";
  const sourceDataSource = safeCardText(card.sourceDataSource) || "Briefing API";
  const profileScope = safeCardText(card.profileScope) || "Account profile";
  const truthSource = safeCardText(card.truthSource) || "—";
  const spendUnitSource = safeCardText(card.spendUnitSource) || "—";
  const spendUnitConfidence = safeCardText(card.spendUnitConfidence) || "—";
  const metaAovQuality = safeCardText(card.metaAovQuality) || "—";
  const thresholdQuality = safeCardText(card.thresholdQuality) || "—";
  const hasBlockers = Boolean(card.blockers?.length);
  const priority = card.priorityScore;

  return [
    {
      key: "decision",
      title: "Decision",
      icon: (
        <Target
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      defaultOpen: true,
      content: (
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <div>
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
              Engine label
            </div>
            <div className="flex items-center gap-2">
              <DecisionLabelChip label={label} />
              <ConfidencePill confidence={confidence} />
            </div>
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
              Recommended action
            </div>
            <div className="text-neutral-900 font-medium">{primaryLabel}</div>
          </div>
          {priority ? (
            <div className="col-span-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5">
              <div className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold">
                Priority model
              </div>
              <div className="mt-0.5 text-neutral-700">
                <span className="font-semibold text-neutral-900">
                  {priority.band}
                </span>{" "}
                <span className="font-mono tabular-nums">
                  {priority.score.toLocaleString("en-US")}
                </span>{" "}
                <span>{priority.reason}</span>
              </div>
            </div>
          ) : null}
          <div className="col-span-2">
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
              Reason
            </div>
            <div className="text-neutral-700 leading-snug">{reason}</div>
            {card.labelTransform ? (
              <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[12px] font-medium text-amber-800">
                <SkipForward
                  className="inline-block shrink-0"
                  size={11}
                  aria-hidden="true"
                />
                Test campaign refresh was transformed to cut
              </div>
            ) : null}
            {predictive ? (
              <div className="text-neutral-500 italic mt-1 flex items-center gap-1">
                <Sparkles
                  className="inline-block shrink-0"
                  size={11}
                  aria-hidden="true"
                />
                {predictive}
              </div>
            ) : null}
          </div>
        </div>
      ),
    },
    ...(hasBlockers
      ? [
          {
            key: "blockers",
            title: "Decision blockers",
            icon: (
              <AlertTriangle
                className="inline-block shrink-0"
                size={13}
                aria-hidden="true"
              />
            ),
            content: <BlockersBody card={card} />,
          },
        ]
      : []),
    {
      key: "explainability",
      title: "Math and proof",
      icon: (
        <Target
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      content: <ExplainabilityBody card={card} />,
    },
    {
      key: "inputs",
      title: "Inputs",
      icon: (
        <Database
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      content: (
        <div className="grid grid-cols-4 gap-3 text-[12px]">
          <Kv label="28d Spend">{formatOptionalCurrency(card.spend)}</Kv>
          <Kv label="28d ROAS">{formatOptionalRoas(card.roas)}</Kv>
          <Kv label="Purchases">{formatOptionalInteger(card.purchases)}</Kv>
          <Kv label="CPA">{formatOptionalCurrency(card.cpa)}</Kv>
          <Kv label="CTR">{formatOptionalFixed(card.ctr, 2, "%")}</Kv>
          <Kv label="Frequency">{formatOptionalFixed(card.frequency, 1)}</Kv>
          <Kv label="Age">{hasMetricValue(card.ageDays) ? `${numberOrZero(card.ageDays)}d` : "—"}</Kv>
          <Kv label="Status">{card.status || "ACTIVE"}</Kv>
          <Kv label="24h Spend">
            {typeof card.spend24h === "number" ? formatCurrency(card.spend24h) : "—"}
          </Kv>
          <Kv label="24h Impr.">
            {typeof card.impressions24h === "number"
              ? numberOrZero(card.impressions24h).toLocaleString()
              : "—"}
          </Kv>
          <Kv label="First seen">{card.firstSeenAt || "—"}</Kv>
          <Kv label="First spend">{card.firstSpendAt || "—"}</Kv>
        </div>
      ),
    },
    {
      key: "funnel",
      title: "Funnel",
      icon: (
        <PieChart
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      content: <FunnelBody card={card} />,
    },
    {
      key: "engine",
      title: "Engine snapshot",
      icon: (
        <Activity
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      content: (
        <ol className="space-y-1.5 text-[12px] text-neutral-600 relative pl-4 border-l border-neutral-200">
          <TrailItem
            version={engineVersion}
            date={sourceAsOf}
            label={`Current label: ${label}`}
            why={`Confidence ${formatOptionalFixed(card.confidence, 0, "%")}`}
          />
        </ol>
      ),
    },
    {
      key: "operator",
      title: "Operator response",
      icon: (
        <User className="inline-block shrink-0" size={13} aria-hidden="true" />
      ),
      content: (
        <div className="text-[12px] text-neutral-600 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-neutral-400">
              <Clock
                className="inline-block shrink-0"
                size={11}
                aria-hidden="true"
              />
            </span>
            No operator response recorded in this briefing view.
          </div>
        </div>
      ),
    },
    {
      key: "provenance",
      title: "Provenance",
      icon: (
        <FileText
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      ),
      content: (
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <Kv label="Creative ID">
            <span className="font-mono">{cardId(card)}</span>
          </Kv>
          <Kv label="Engine version">{engineVersion}</Kv>
          <Kv label="Decision as of">{sourceAsOf}</Kv>
          <Kv label="Profile scope">{profileScope}</Kv>
          <Kv label="Data source">{sourceDataSource}</Kv>
          <Kv label="Truth source">{truthSource}</Kv>
          <Kv label="Spend unit">{spendUnitSource}</Kv>
          <Kv label="Spend confidence">{spendUnitConfidence}</Kv>
          <Kv label="Meta AOV quality">{metaAovQuality}</Kv>
          <Kv label="Threshold quality">{thresholdQuality}</Kv>
          <Kv label="Review status">{card.reviewStatus || "—"}</Kv>
          <Kv label="Policy reason">
            {card.disapprovalReason || card.limitedReason || "—"}
          </Kv>
          <Kv label="Campaign">{cardCampaign(card)}</Kv>
        </div>
      ),
    },
  ];
}
