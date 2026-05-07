"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  SeoAiActionStep,
  SeoAiAnalysis,
  SeoAiBrief,
  SeoAiContextBlock,
  SeoAiDataLayer,
  SeoAiOutputCard,
  SeoAiPriorityItem,
  SeoAiRootCause,
  SeoCauseCandidate,
  SeoEntityChange,
  SeoOverviewPayload,
  SeoRecommendation,
} from "@/lib/seo/intelligence";
import type { SeoTechnicalFindingsPayload } from "@/lib/seo/findings";

export type SeoTab = "overview" | "traffic" | "queries" | "pages" | "technical" | "actions";

export const SEO_TABS: Array<{ id: SeoTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "traffic", label: "Traffic Changes" },
  { id: "queries", label: "Queries" },
  { id: "pages", label: "Pages" },
  { id: "technical", label: "Technical Findings" },
  { id: "actions", label: "AI Priorities" },
];

export type SeoOverviewResponse = SeoOverviewPayload;
export type SeoFindingsResponse = SeoTechnicalFindingsPayload;
export interface SeoMonthlyAiAnalysisResponse {
  monthKey: string;
  monthLabel: string;
  generatedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: "available" | "not_generated" | "failed";
  canGenerate: boolean;
  unavailableReason?: string;
  overviewData: SeoOverviewPayload["aiWorkspace"] | null;
  analysis: SeoAiAnalysis | null;
}

import { formatPercentFromRatioSmart } from "@/lib/metric-format";

export function formatMetric(value: number, mode: "number" | "percent" | "position") {
  if (mode === "percent") return formatPercentFromRatioSmart(value);
  if (mode === "position") return value > 0 ? value.toFixed(1) : "0.0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatDeltaPercent(value: number | null, invert = false) {
  if (value === null) return "New";
  const effective = invert ? -value : value;
  const prefix = effective > 0 ? "+" : "";
  return `${prefix}${(effective * 100).toFixed(0)}%`;
}

export function getDeltaTone(value: number | null, invert = false) {
  if (value === null) return "text-sky-600";
  const effective = invert ? -value : value;
  if (effective > 0.02) return "text-emerald-600";
  if (effective < -0.02) return "text-rose-600";
  return "text-muted-foreground";
}

export function SeoKpiCard(props: {
  label: string;
  current: number;
  previous: number;
  deltaPercent: number | null;
  mode: "number" | "percent" | "position";
  invertDelta?: boolean;
}) {
  const deltaLabel = formatDeltaPercent(props.deltaPercent, props.invertDelta);
  const deltaTone = getDeltaTone(props.deltaPercent, props.invertDelta);

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight">
            {formatMetric(props.current, props.mode)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Previous: {formatMetric(props.previous, props.mode)}
          </p>
        </div>
        <p className={cn("text-sm font-medium", deltaTone)}>{deltaLabel}</p>
      </div>
    </div>
  );
}

export function SectionIntro(props: { title: string; description: string }) {
  return (
    <div className="mb-4 space-y-1">
      <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
      <p className="text-sm text-muted-foreground">{props.description}</p>
    </div>
  );
}

function formatCoverageDate(value: string | null) {
  if (!value) return "Unknown";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return year && month && day ? `${year}-${month}-${day}` : value;
}

export function SeoMonthlyAiPanel(props: {
  monthly: SeoMonthlyAiAnalysisResponse;
  isGenerating: boolean;
  onGenerate: () => void;
}) {
  const { monthly } = props;
  const generatedLabel = monthly.generatedAt
    ? new Date(monthly.generatedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
  const periodLabel =
    monthly.periodStart && monthly.periodEnd
      ? `${formatCoverageDate(monthly.periodStart)} to ${formatCoverageDate(monthly.periodEnd)}`
      : null;

  if (monthly.status === "available" && monthly.analysis && monthly.overviewData) {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-gradient-to-r from-amber-50 via-orange-50 to-rose-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Monthly AI Analysis</Badge>
                <Badge variant="outline">{monthly.monthLabel}</Badge>
                <Badge variant="outline">1 run per month</Badge>
              </div>
              <h3 className="text-xl font-semibold tracking-tight">
                This month&apos;s SEO strategy analysis is locked in
              </h3>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {`The overview below is the saved AI output for ${monthly.monthLabel}. Teams can review, share, and work from the same plan without re-running the model.`}
              </p>
            </div>
            <div className="grid gap-2 text-sm lg:min-w-[280px]">
              <StatusMeta label="Generated" value={generatedLabel ?? "Unknown"} />
              <StatusMeta label="Coverage period" value={periodLabel ?? "Current selection"} />
              <StatusMeta label="Availability" value="Saved and reusable this month" />
            </div>
          </div>
        </div>
        <SeoAiWorkspaceOverview
          dataLayers={monthly.overviewData.dataLayers}
          contextBlocks={monthly.overviewData.contextBlocks}
          requestedOutputs={monthly.overviewData.requestedOutputs}
          analysis={monthly.analysis}
        />
      </div>
    );
  }

  const title =
    monthly.status === "failed"
      ? "This month's AI run did not complete"
      : `Generate ${monthly.monthLabel} AI analysis`;
  const description =
    monthly.status === "failed"
      ? "The monthly analysis failed before a result could be saved. You can retry for this month."
      : "Run a full ecommerce SEO review once for this month. The saved output will include root causes, an impact/effort matrix, and a 30-day action plan.";
  const ctaLabel = props.isGenerating
    ? "Generating analysis..."
    : monthly.status === "failed"
      ? "Retry monthly analysis"
      : "Generate this month's analysis";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Monthly AI Analysis</Badge>
              <Badge variant="outline">{monthly.monthLabel}</Badge>
              <Badge variant="outline">1 run per month</Badge>
              {monthly.status === "failed" && <Badge variant="destructive">Needs retry</Badge>}
            </div>
            <div className="space-y-2">
              <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
            {monthly.unavailableReason && (
              <div className="max-w-3xl rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                {monthly.unavailableReason}
              </div>
            )}
          </div>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-muted/20 p-4">
            <StatusMeta label="Month" value={monthly.monthLabel} />
            <StatusMeta label="Coverage period" value={periodLabel ?? "Current selection"} />
            <StatusMeta
              label="Status"
              value={
                monthly.status === "failed"
                  ? "Failed"
                  : monthly.canGenerate
                    ? "Ready to generate"
                    : "Unavailable"
              }
            />
            <Button
              className="w-full"
              onClick={props.onGenerate}
              disabled={!monthly.canGenerate || props.isGenerating}
            >
              {ctaLabel}
            </Button>
            <p className="text-xs leading-5 text-muted-foreground">
              To keep the output stable for planning, each business can save one completed AI
              analysis per month.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SeoMonthlyAiActionsPanel(props: {
  monthly: SeoMonthlyAiAnalysisResponse;
  isGenerating: boolean;
  onGenerate: () => void;
}) {
  if (props.monthly.status === "available" && props.monthly.analysis) {
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">AI Priorities</Badge>
            <Badge variant="outline">{props.monthly.monthLabel}</Badge>
            <Badge variant="outline">Saved monthly plan</Badge>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            This tab turns the monthly AI analysis into a working priority queue. Use it as the
            operating view for what to fix first, what to sequence next, and what to park for
            deeper follow-up.
          </p>
        </div>
        <AiPriorityMatrix priorities={props.monthly.analysis.priorities} />
        <AiActionPlanTimeline steps={props.monthly.analysis.actionPlan} />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">AI Priorities</Badge>
        <Badge variant="outline">{props.monthly.monthLabel}</Badge>
      </div>
      <h3 className="mt-4 text-xl font-semibold tracking-tight">
        Generate the monthly AI analysis to unlock this workspace
      </h3>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
        This section depends on the saved monthly model output. Once generated, it will show the
        impact/effort matrix and the 30-day execution plan in a dedicated operating view.
      </p>
      {props.monthly.unavailableReason && (
        <div className="mt-4 rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {props.monthly.unavailableReason}
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={props.onGenerate} disabled={!props.monthly.canGenerate || props.isGenerating}>
          {props.isGenerating ? "Generating analysis..." : "Generate this month's analysis"}
        </Button>
        <p className="text-sm text-muted-foreground">One completed run can be saved per month.</p>
      </div>
    </div>
  );
}

function StatusMeta(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-1 text-sm font-medium">{props.value}</p>
    </div>
  );
}

export function SeoAiWorkspaceOverview(props: {
  dataLayers: SeoAiDataLayer[];
  contextBlocks: SeoAiContextBlock[];
  requestedOutputs: SeoAiOutputCard[];
  analysis: SeoAiAnalysis;
}) {
  if (props.analysis.source === "unavailable") {
    return <AiUnavailableState analysis={props.analysis} />;
  }

  return (
    <div className="space-y-5">
      <AiAnalysisSummary analysis={props.analysis} />
      <AiRootCauseGrid causes={props.analysis.rootCauses} />
      <AiPriorityMatrix priorities={props.analysis.priorities} />
      <AiActionPlanTimeline steps={props.analysis.actionPlan} />
    </div>
  );
}

function AiUnavailableState({ analysis }: { analysis: SeoAiAnalysis }) {
  return (
    <div className="rounded-2xl border bg-card p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        AI Overview
      </p>
      <h3 className="mt-3 text-xl font-semibold tracking-tight">Integrated AI analysis is unavailable</h3>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
        {analysis.summary}
      </p>
      {analysis.unavailableReason && (
        <div className="mt-4 rounded-xl border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {analysis.unavailableReason}
        </div>
      )}
      <div className="mt-5 rounded-xl border bg-slate-950 px-4 py-4 text-sm text-slate-100">
        <span className="font-medium">Commerce context:</span> {analysis.ecommerceContext}
      </div>
    </div>
  );
}

function AiAnalysisSummary({ analysis }: { analysis: SeoAiAnalysis }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              AI Summary
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight">
              What the model sees from an e-commerce SEO lens
            </h3>
          </div>
          <Badge variant="secondary">AI</Badge>
        </div>
        <p className="mt-4 text-sm leading-7">{analysis.summary}</p>
      </div>
      <div className="rounded-2xl border bg-card p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Commerce Context
        </p>
        <p className="mt-4 text-sm leading-7 text-muted-foreground">{analysis.ecommerceContext}</p>
      </div>
    </div>
  );
}

function AiRootCauseGrid({ causes }: { causes: SeoAiRootCause[] }) {
  return (
    <div className="space-y-3">
      <SectionIntro
        title="Likely root causes"
        description="These are framed for e-commerce SEO, so page-type mismatch and category/product intent alignment matter more than generic content advice."
      />
      <div className="grid gap-3 md:grid-cols-2">
        {causes.map((cause) => (
          <div key={cause.title} className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Confidence: {cause.confidence}</Badge>
              <Badge variant="outline">Area: {cause.affectedArea}</Badge>
            </div>
            <h3 className="mt-3 text-base font-semibold tracking-tight">{cause.title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{cause.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiPriorityMatrix({ priorities }: { priorities: SeoAiPriorityItem[] }) {
  const quickWins = priorities.filter((item) => item.impact === "high" && item.effort === "low");
  const strategic = priorities.filter((item) => item.impact === "high" && item.effort !== "low");
  const supporting = priorities.filter((item) => item.impact !== "high" && item.effort === "low");
  const deeperWork = priorities.filter((item) => item.impact !== "high" && item.effort !== "low");

  return (
    <div className="space-y-3">
      <SectionIntro
        title="Impact vs effort matrix"
        description="Quick wins come first, but broader category and template issues still need a strategic queue."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <PriorityQuadrant title="High impact / low effort" tone="quick" items={quickWins} />
        <PriorityQuadrant title="High impact / higher effort" tone="strategic" items={strategic} />
        <PriorityQuadrant title="Medium impact / low effort" tone="supporting" items={supporting} />
        <PriorityQuadrant title="Deeper follow-up work" tone="deep" items={deeperWork} />
      </div>
    </div>
  );
}

function PriorityQuadrant(props: {
  title: string;
  tone: "quick" | "strategic" | "supporting" | "deep";
  items: SeoAiPriorityItem[];
}) {
  const className =
    props.tone === "quick"
      ? "border-emerald-300/60 bg-emerald-50"
      : props.tone === "strategic"
        ? "border-sky-300/60 bg-sky-50"
        : props.tone === "supporting"
          ? "border-amber-300/60 bg-amber-50"
          : "border-slate-300/60 bg-slate-50";

  return (
    <div className={cn("rounded-2xl border p-4 shadow-sm", className)}>
      <p className="text-sm font-semibold">{props.title}</p>
      <div className="mt-4 space-y-3">
        {props.items.length ? (
          props.items.map((item) => (
            <div key={item.title} className="rounded-xl border bg-white/80 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{item.title}</p>
                <Badge variant="outline">Impact: {item.impact}</Badge>
                <Badge variant="outline">Effort: {item.effort}</Badge>
                <Badge variant="outline">{item.owner}</Badge>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.detail}</p>
            </div>
          ))
        ) : (
          <div className="rounded-xl border bg-white/70 p-4 text-sm text-muted-foreground">
            No items in this quadrant for the current period.
          </div>
        )}
      </div>
    </div>
  );
}

function AiActionPlanTimeline({ steps }: { steps: SeoAiActionStep[] }) {
  return (
    <div className="space-y-3">
      <SectionIntro
        title="30-day action plan"
        description="A practical sprint sequence so the team can move from diagnosis to recovery without losing momentum."
      />
      <div className="grid gap-4 xl:grid-cols-4">
        {steps.map((step) => (
          <div key={step.window} className="rounded-2xl border bg-card p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {step.window}
            </p>
            <h3 className="mt-3 text-lg font-semibold tracking-tight">{step.focus}</h3>
            <div className="mt-4 space-y-2">
              {step.tasks.map((task) => (
                <div key={task} className="rounded-xl border bg-muted/20 px-3 py-2 text-sm">
                  {task}
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border bg-slate-950 px-3 py-3 text-sm text-slate-100">
              <span className="font-medium">Success metric:</span> {step.successMetric}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiBriefCard({ brief }: { brief: SeoAiBrief }) {
  return (
    <div className="rounded-2xl border bg-gradient-to-r from-sky-50 to-indigo-50 p-5 shadow-sm dark:from-sky-950/20 dark:to-indigo-950/20">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            SEO Intelligence Brief
          </p>
          <h3 className="mt-1 text-lg font-semibold">What changed and what to do next</h3>
        </div>
        <Badge variant="secondary">{brief.source === "ai" ? "AI" : "Rules"}</Badge>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <BriefBlock label="Summary" value={brief.summary} />
        <BriefBlock label="Likely Cause" value={brief.likelyCause} />
        <BriefBlock label="Next Step" value={brief.nextStep} />
      </div>
    </div>
  );
}

function BriefBlock(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-background/70 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 text-sm leading-6">{props.value}</p>
    </div>
  );
}

export function CauseCards({ causes }: { causes: SeoCauseCandidate[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {causes.map((cause) => (
        <div key={cause.key} className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{cause.title}</h3>
            <div className="flex items-center gap-2">
              <ToneBadge label={cause.confidence} />
              <ToneBadge label={cause.severity} />
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{cause.explanation}</p>
        </div>
      ))}
    </div>
  );
}

function ToneBadge({ label }: { label: string }) {
  const tone =
    label === "high"
      ? "bg-rose-100 text-rose-700"
      : label === "medium"
        ? "bg-amber-100 text-amber-700"
        : "bg-muted text-muted-foreground";
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", tone)}>{label}</span>;
}

export function RecommendationsList({
  recommendations,
}: {
  recommendations: SeoRecommendation[];
}) {
  return (
    <div className="space-y-3">
      {recommendations.map((item) => (
        <div key={item.title} className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <Badge variant="outline">Effort: {item.effort}</Badge>
            <Badge variant="outline">Impact: {item.impact}</Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{item.rationale}</p>
        </div>
      ))}
    </div>
  );
}

export function EntityTable(props: {
  title: string;
  rows: SeoEntityChange[];
  emptyLabel: string;
  scrollHeightClass?: string;
}) {
  const [sortKey, setSortKey] = useState<EntitySortKey>("clickDelta");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const handleSort = (nextKey: EntitySortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((currentDirection) => (currentDirection === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "label" ? "asc" : "desc");
  };

  const sortedRows = useMemo(() => {
    return [...props.rows].sort((a, b) => compareEntityRows(a, b, sortKey, sortDirection));
  }, [props.rows, sortDirection, sortKey]);

  if (!props.rows.length) {
    return (
      <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {props.emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{props.title}</h3>
      </div>
      <div className={cn("overflow-auto", props.scrollHeightClass)}>
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <SortableHeader
                label="Name"
                sortKey="label"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
              <SortableHeader
                label="Clicks"
                sortKey="clicks"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
              <SortableHeader
                label="Impr."
                sortKey="impressions"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
              <SortableHeader
                label="CTR"
                sortKey="ctr"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
              <SortableHeader
                label="Pos."
                sortKey="position"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
              <SortableHeader
                label="Click delta"
                sortKey="clickDelta"
                activeKey={sortKey}
                direction={sortDirection}
                onSort={handleSort}
                className="px-4 py-3"
              />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.key} className="border-t">
                <td className="max-w-[320px] px-4 py-3 align-top">
                  <div className="line-clamp-2 font-medium">{row.label}</div>
                  {row.classificationLabel && (
                    <div className="mt-2">
                      <ClassificationBadge
                        label={row.classificationLabel}
                        tone={row.classificationTone}
                      />
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">{formatMetric(row.clicks, "number")}</td>
                <td className="px-4 py-3">{formatMetric(row.impressions, "number")}</td>
                <td className="px-4 py-3">{formatMetric(row.ctr, "percent")}</td>
                <td className="px-4 py-3">{formatMetric(row.position, "position")}</td>
                <td className={cn("px-4 py-3 font-medium", getDeltaTone(row.clicksDeltaPercent))}>
                  {formatDeltaPercent(row.clicksDeltaPercent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type EntitySortKey = "label" | "clicks" | "impressions" | "ctr" | "position" | "clickDelta";

function SortableHeader(props: {
  label: string;
  sortKey: EntitySortKey;
  activeKey: EntitySortKey;
  direction: "asc" | "desc";
  onSort: (key: EntitySortKey) => void;
  className?: string;
}) {
  const isActive = props.activeKey === props.sortKey;
  const indicator = !isActive ? "↕" : props.direction === "asc" ? "↑" : "↓";

  return (
    <th className={cn("font-medium", props.className)}>
      <button
        type="button"
        onClick={() => props.onSort(props.sortKey)}
        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
      >
        <span>{props.label}</span>
        <span className={cn("text-[10px]", isActive ? "text-foreground" : "text-muted-foreground")}>
          {indicator}
        </span>
      </button>
    </th>
  );
}

function compareEntityRows(
  a: SeoEntityChange,
  b: SeoEntityChange,
  sortKey: EntitySortKey,
  sortDirection: "asc" | "desc",
) {
  const direction = sortDirection === "asc" ? 1 : -1;
  const result =
    sortKey === "label"
      ? a.label.localeCompare(b.label)
      : sortKey === "clicks"
        ? a.clicks - b.clicks
        : sortKey === "impressions"
          ? a.impressions - b.impressions
          : sortKey === "ctr"
            ? a.ctr - b.ctr
            : sortKey === "position"
              ? a.position - b.position
              : (a.clicksDeltaPercent ?? Number.NEGATIVE_INFINITY) -
                (b.clicksDeltaPercent ?? Number.NEGATIVE_INFINITY);

  if (result !== 0) return result * direction;
  return a.label.localeCompare(b.label);
}

function ClassificationBadge(props: {
  label: string;
  tone: SeoEntityChange["classificationTone"];
}) {
  const className =
    props.tone === "informational"
      ? "bg-sky-100 text-sky-700"
      : props.tone === "commercial"
        ? "bg-violet-100 text-violet-700"
        : props.tone === "transactional"
          ? "bg-emerald-100 text-emerald-700"
          : props.tone === "navigational"
            ? "bg-slate-100 text-slate-700"
            : props.tone === "comparative"
              ? "bg-amber-100 text-amber-700"
              : props.tone === "inspirational"
                ? "bg-pink-100 text-pink-700"
                : props.tone === "product"
                  ? "bg-emerald-100 text-emerald-700"
                  : props.tone === "category"
                    ? "bg-orange-100 text-orange-700"
                    : props.tone === "editorial"
                      ? "bg-sky-100 text-sky-700"
                      : props.tone === "utility"
                        ? "bg-slate-100 text-slate-700"
                        : props.tone === "home"
                          ? "bg-indigo-100 text-indigo-700"
                          : "bg-muted text-muted-foreground";

  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>
      {props.label}
    </span>
  );
}

export function FindingsSummaryCards({
  critical,
  warning,
  opportunity,
}: SeoFindingsResponse["summary"]) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FindingSummaryCard label="Critical" value={critical} tone="critical" />
      <FindingSummaryCard label="Warnings" value={warning} tone="warning" />
      <FindingSummaryCard label="Opportunities" value={opportunity} tone="opportunity" />
    </div>
  );
}

function FindingSummaryCard(props: {
  label: string;
  value: number;
  tone: "critical" | "warning" | "opportunity";
}) {
  const toneClass =
    props.tone === "critical"
      ? "text-rose-700 bg-rose-50"
      : props.tone === "warning"
        ? "text-amber-700 bg-amber-50"
        : "text-sky-700 bg-sky-50";

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", toneClass)}>
        {props.label}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{props.value}</p>
    </div>
  );
}

export function TechnicalFindingsList({ findings }: { findings: SeoFindingsResponse["findings"] }) {
  if (!findings.length) {
    return (
      <div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        No technical findings were detected on the audited pages.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {findings.map((finding) => (
        <div key={finding.id} className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <Badge variant="outline">{finding.category}</Badge>
            <Badge variant="outline">{finding.pageType}</Badge>
          </div>
          <h3 className="mt-3 text-sm font-semibold">{finding.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{finding.description}</p>
          <p className="mt-3 text-sm">
            <span className="font-medium">Recommended fix:</span> {finding.recommendation}
          </p>
          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Affected pages
            </p>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {finding.affectedPages.map((page) => (
                <div key={`${finding.id}-${page.path}`} className="rounded-xl border bg-muted/20 px-3 py-2">
                  <p className="text-sm font-medium">{page.path}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {page.pageType} · Click delta {page.clicksDelta >= 0 ? "+" : ""}
                    {page.clicksDelta} · {new Intl.NumberFormat("en-US").format(page.impressions)} impressions
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: SeoTechnicalFindingsPayload["findings"][number]["severity"] }) {
  const className =
    severity === "critical"
      ? "bg-rose-100 text-rose-700"
      : severity === "warning"
        ? "bg-amber-100 text-amber-700"
        : "bg-sky-100 text-sky-700";

  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", className)}>{severity}</span>;
}

export function ConfirmedExcludedPagesList({
  pages,
}: {
  pages: SeoFindingsResponse["confirmedExcludedPages"];
}) {
  if (!pages.length) return null;

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Confirmed excluded important pages</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          These pages are important and Search Console inspection shows they are excluded, blocked, or not indexed.
        </p>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Page</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Verdict</th>
              <th className="px-4 py-3 font-medium">Coverage</th>
              <th className="px-4 py-3 font-medium">Indexing</th>
              <th className="px-4 py-3 font-medium">Fetch</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.path} className="border-t align-top">
                <td className="px-4 py-3">
                  <div className="font-medium">{page.path}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Click delta {page.clicksDelta >= 0 ? "+" : ""}
                    {page.clicksDelta} · {new Intl.NumberFormat("en-US").format(page.impressions)} impressions
                  </div>
                </td>
                <td className="px-4 py-3">{page.pageType}</td>
                <td className="px-4 py-3">{page.inspectionVerdict ?? "Unknown"}</td>
                <td className="px-4 py-3">{page.coverageState ?? "Unknown"}</td>
                <td className="px-4 py-3">{page.indexingState ?? "Unknown"}</td>
                <td className="px-4 py-3">{page.pageFetchState ?? "Unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
