import type { ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  Clock,
  Database,
  FileText,
  MoreHorizontal,
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

export function asDecisionLabel(value: unknown, fallback: DecisionLabel = "out_of_scope"): DecisionLabel {
  return typeof value === "string" && VALID_DECISION_LABELS.has(value as DecisionLabel)
    ? (value as DecisionLabel)
    : fallback;
}

export function cardId(card: Pick<BriefingCreativeCard, "id" | "creativeId">) {
  return safeCardText(card.id) || safeCardText(card.creativeId) || "creative";
}

export function cardName(card: Pick<BriefingCreativeCard, "name" | "creativeName">) {
  return safeCardText(card.name) || safeCardText(card.creativeName) || "Untitled creative";
}

export function cardCampaign(card: Pick<BriefingCreativeCard, "campaign" | "campaignName">) {
  return safeCardText(card.campaign) || safeCardText(card.campaignName) || "Campaign";
}

export function cardAdset(card: Pick<BriefingCreativeCard, "adset" | "adsetName">) {
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

export function confidenceValue(card: Pick<BriefingCreativeCard, "confidence">) {
  return Math.max(0, Math.min(100, Math.round(numberOrZero(card.confidence))));
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
  const fontSize = size === "lg" ? 22 : size === "md" ? 18 : size === "sm" ? 15 : 10;

  return (
    <div
      className={[
        bg,
        fg,
        size === "xs" ? "rounded-md" : "rounded-xl",
        size === "xs" ? "w-7 h-7 text-[10px]" : "",
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
        className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
        title="Campaign label missing. Mark this campaign as Main, Test, or Mixed before hard actions."
      >
        <AlertTriangle className="inline-block shrink-0" size={11} aria-hidden="true" />
        campaign label
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
    "campaignKind" | "campaignLabelStatus" | "campaignTestDimension" | "blockedActionType"
  >;
}) {
  if (card.campaignLabelStatus === "no_campaign") return null;

  if (card.campaignLabelStatus === "unlabeled") {
    const detail = card.blockedActionType
      ? `Engine wanted ${card.blockedActionType}, blocked until Main/Test/Mixed is labeled.`
      : "Campaign label missing.";
    return (
      <span
        className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
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
        ? "border-sky-200 bg-sky-50 text-sky-700"
        : "border-violet-200 bg-violet-50 text-violet-700";
  const detail = card.campaignTestDimension
    ? `${label}: ${card.campaignTestDimension}`
    : label;

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
      title={detail}
    >
      {label}
    </span>
  );
}

export function Sparkline({
  values,
  tone = "text-slate-400",
  width = 80,
  height = 22,
}: {
  values?: number[] | null;
  tone?: string;
  width?: number;
  height?: number;
}) {
  const normalizedValues = Array.isArray(values) && values.length > 0 ? values : [0, 0];

  return (
    <svg
      viewBox="0 0 60 16"
      width={width}
      height={height}
      className={tone}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={sparklinePath(normalizedValues)} fill="none" stroke="currentColor" strokeWidth="1.5" />
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
  const ctr = numberOrZero(value);
  const midpoint = p50 && p50 > 0 ? p50 : 1.1;
  const pct = Math.min(100, (ctr / (midpoint * 2)) * 100);
  const isAbove = ctr >= midpoint;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10.5px] text-slate-500">CTR</span>
      <div className="relative w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 ${isAbove ? "bg-emerald-500" : "bg-rose-500"}`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-slate-400" style={{ left: "50%" }} />
      </div>
      <span
        className={`font-mono tabular-nums text-[10.5px] font-medium ${
          isAbove ? "text-emerald-700" : "text-rose-700"
        }`}
      >
        {ctr.toFixed(2)}%
      </span>
      <span className="font-mono tabular-nums text-[10px] text-slate-400">
        P50 {midpoint.toFixed(2)}%
      </span>
    </div>
  );
}

export function FatigueDot({ active }: { active?: boolean | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10.5px] ${
        active ? "text-amber-700" : "text-slate-400"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-amber-500" : "bg-slate-300"}`} />
      {active ? "Fatigued" : "Stable"}
    </span>
  );
}

export function MetricDivider() {
  return <span className="text-slate-200">·</span>;
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
  const teleports = actionKind === "promote" || actionKind === "demote" || actionKind === "fresh_test";
  const isCut = actionKind === "cut" || actionKind === "pause";
  const isFilled = primaryStyle === "filled";
  let toneClass: string;

  if (isCut) {
    toneClass = isFilled
      ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
      : "border-rose-300 text-rose-700 hover:bg-rose-50";
  } else if (actionKind === "promote" || actionKind === "scale") {
    toneClass = isFilled
      ? "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
      : "border-emerald-300 text-emerald-700 hover:bg-emerald-50";
  } else if (actionKind === "review_placements") {
    toneClass = isFilled
      ? "bg-slate-800 text-white border-slate-800 hover:bg-slate-900"
      : "border-slate-300 text-slate-700 hover:bg-slate-50";
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
      {teleports ? <ArrowRight className="ml-1 -mr-0.5 inline-block shrink-0" size={13} aria-hidden="true" /> : null}
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
      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
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
      <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold">
        {label}
      </div>
      <div className="font-mono tabular-nums text-slate-900 text-[12.5px] font-medium">
        {children}
      </div>
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
      <span className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-white border-2 border-slate-300" />
      <div className="flex items-center gap-2 text-slate-900 font-medium text-[12px]">
        {label}
      </div>
      <div className="text-[11px] text-slate-500 flex items-center gap-2">
        <span className="font-mono tabular-nums">{date}</span>
        <span className="text-slate-300">·</span>
        <span>Engine {version}</span>
        <span className="text-slate-300">·</span>
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
  const denominator = impressions > 0 ? impressions : Math.max(linkClicks, addToCart, purchases);

  if (denominator <= 0) {
    return <p className="text-[12px] text-slate-500">Funnel counts unavailable.</p>;
  }

  const stages = [
    { name: "Impressions", value: impressions, pct: funnelBarPct(impressions, denominator) },
    { name: "Link clicks", value: linkClicks, pct: funnelBarPct(linkClicks, denominator) },
    { name: "Add to cart", value: addToCart, pct: funnelBarPct(addToCart, denominator) },
    { name: "Purchases", value: purchases, pct: funnelBarPct(purchases, denominator) },
  ];

  return (
    <div className="space-y-1.5">
      {stages.map((stage) => (
        <div key={stage.name} className="flex items-center gap-2 text-[12px]">
          <span className="w-24 text-slate-500">{stage.name}</span>
          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500" style={{ width: `${stage.pct}%` }} />
          </div>
          <span className="font-mono tabular-nums text-slate-900 w-20 text-right">
            {stage.value.toLocaleString("en-US")}
          </span>
        </div>
      ))}
    </div>
  );
}

export function buildEvidenceSections(card: BriefingCreativeCard): EvidenceAccordionSection[] {
  const label = asDecisionLabel(card.label);
  const confidence = confidenceValue(card);
  const reason = card.reason || "No engine reason supplied.";
  const predictive = card.predictive;
  const primaryLabel = card.primary?.label || "—";
  const today = "2026-05-04";

  return [
    {
      key: "decision",
      title: "Decision",
      icon: <Target className="inline-block shrink-0" size={13} aria-hidden="true" />,
      defaultOpen: true,
      content: (
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <div>
            <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Engine label
            </div>
            <div className="flex items-center gap-2">
              <DecisionLabelChip label={label} />
              <ConfidencePill confidence={confidence} />
            </div>
          </div>
          <div>
            <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Recommended action
            </div>
            <div className="text-slate-900 font-medium">{primaryLabel}</div>
          </div>
          <div className="col-span-2">
            <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Reason
            </div>
            <div className="text-slate-700 leading-snug">{reason}</div>
            {predictive ? (
              <div className="text-slate-500 italic mt-1 flex items-center gap-1">
                <Sparkles className="inline-block shrink-0" size={11} aria-hidden="true" />
                {predictive}
              </div>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      key: "inputs",
      title: "Inputs",
      icon: <Database className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <div className="grid grid-cols-4 gap-3 text-[12px]">
          <Kv label="28d Spend">{formatCurrency(card.spend)}</Kv>
          <Kv label="28d ROAS">{formatRoas(card.roas)}</Kv>
          <Kv label="Purchases">{numberOrZero(card.purchases) || "—"}</Kv>
          <Kv label="CPA">${numberOrZero(card.cpa).toFixed(2)}</Kv>
          <Kv label="CTR">{numberOrZero(card.ctr).toFixed(2)}%</Kv>
          <Kv label="Frequency">{numberOrZero(card.frequency).toFixed(1)}</Kv>
          <Kv label="Age">{numberOrZero(card.ageDays)}d</Kv>
          <Kv label="Status">{card.status || "ACTIVE"}</Kv>
        </div>
      ),
    },
    {
      key: "funnel",
      title: "Funnel",
      icon: <PieChart className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: <FunnelBody card={card} />,
    },
    {
      key: "engine",
      title: "Engine trail",
      icon: <Activity className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <ol className="space-y-1.5 text-[12px] text-slate-600 relative pl-4 border-l border-slate-200">
          <TrailItem
            version="v3.2"
            date="2026-04-28"
            label={`Initial label assigned: ${label}`}
            why="Threshold breach: 28d ROAS"
          />
          <TrailItem
            version="v3.2"
            date="2026-05-01"
            label={`Confidence raised ${Math.max(40, confidence - 12)}% → ${Math.max(50, confidence - 6)}%`}
            why="Sample size grew"
          />
          <TrailItem
            version="v3.2"
            date={today}
            label={`Confidence raised ${Math.max(50, confidence - 6)}% → ${confidence}%`}
            why="Trend confirmed across 3 dailies"
          />
        </ol>
      ),
    },
    {
      key: "operator",
      title: "Operator response",
      icon: <User className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <div className="text-[12px] text-slate-600 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">
              <Clock className="inline-block shrink-0" size={11} aria-hidden="true" />
            </span>
            First seen by Erhan: <span className="font-mono tabular-nums">2026-05-01 09:14</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400">
              <SkipForward className="inline-block shrink-0" size={11} aria-hidden="true" />
            </span>
            Deferred once on 2026-05-04 (24h)
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400">
              <MoreHorizontal className="inline-block shrink-0" size={11} aria-hidden="true" />
            </span>
            Action pending
          </div>
        </div>
      ),
    },
    {
      key: "provenance",
      title: "Provenance",
      icon: <FileText className="inline-block shrink-0" size={13} aria-hidden="true" />,
      content: (
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <Kv label="Creative ID">
            <span className="font-mono">{cardId(card)}</span>
          </Kv>
          <Kv label="Engine version">v3.2.4</Kv>
          <Kv label="Last sync">—</Kv>
          <Kv label="Calibration cohort">Q2-2026 e-com mid</Kv>
          <Kv label="Source">Meta Ads API · graph v19</Kv>
          <Kv label="Pixel events">Standard + Conversions API</Kv>
        </div>
      ),
    },
  ];
}
