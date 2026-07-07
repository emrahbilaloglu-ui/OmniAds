"use client";

import { useMemo } from "react";
import { CalendarRange, Copy, Rows3 } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import {
  SHARE_TABLE_COLUMNS,
  SHARE_TABLE_COLUMN_MAP,
  type ShareTableColumnDefinition,
  type ShareTableColumnKey,
  buildShareDistributions,
  buildShareTableCalcContext,
  evaluateShareMetricCell,
  isShareMetricApplicable,
  toShareHeatColor,
} from "@/components/creatives/shareTableEngine";
import {
  ShareMetricKey,
  SharePayload,
  SharedCreative,
  SharedCreativeAnalysis,
} from "./shareCreativeTypes";

type TopMetricLabelMap = Record<ShareMetricKey, string>;

type PublicShareCreative = SharedCreative & {
  mediaPreviewUrl?: string | null;
  cardPreviewUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cachedThumbnailUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  previewUrl?: string | null;
};

const TOP_METRIC_LABELS: TopMetricLabelMap = {
  spend: "Spend",
  purchaseValue: "Purchase value",
  roas: "ROAS",
  cpa: "CPA",
  cpcLink: "CPC link",
  cpm: "CPM",
  ctrAll: "CTR",
  linkCtr: "Link CTR",
  purchases: "Purchases",
  impressions: "Impressions",
  clicks: "Clicks",
  linkClicks: "Link clicks",
  addToCart: "Add to cart",
  thumbstop: "Thumbstop",
  clickToAddToCart: "Click to ATC",
  clickToPurchase: "Click to purchase",
  video25: "25% views",
  video50: "50% views",
  video75: "75% views",
  video100: "100% views",
  atcToPurchaseRatio: "ATC to purchase",
  leads: "Leads",
  messages: "Messages",
  hookScore: "Hook",
  ctaScore: "CTA",
  offerScore: "Offer",
  clickScore: "Click",
  watchScore: "Watch",
};

const SHARE_METRIC_TO_TABLE_COLUMN: Partial<Record<ShareMetricKey, ShareTableColumnKey>> = {
  clickToAddToCart: "clickToAtcRatio",
  clickToPurchase: "clickToPurchaseRatio",
  video25: "video25Rate",
  video50: "video50Rate",
  video75: "video75Rate",
  video100: "video100Rate",
};

function tableColumnForMetric(key: ShareMetricKey) {
  return SHARE_TABLE_COLUMN_MAP[SHARE_METRIC_TO_TABLE_COLUMN[key] ?? (key as ShareTableColumnKey)] ?? null;
}

function formatTopMetric(key: ShareMetricKey, value: number | null): string {
  if (value == null) return "—";
  switch (key) {
    case "spend":
    case "purchaseValue":
    case "cpcLink":
    case "cpm":
    case "cpa":
      return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    case "roas":
      return value.toFixed(2);
    case "ctrAll":
    case "linkCtr":
    case "thumbstop":
    case "clickToAddToCart":
    case "clickToPurchase":
    case "video25":
    case "video50":
    case "video75":
    case "video100":
    case "atcToPurchaseRatio":
      return `${value.toFixed(2)}%`;
    case "purchases":
    case "impressions":
    case "clicks":
    case "linkClicks":
    case "addToCart":
    case "leads":
    case "messages":
      return value.toLocaleString();
    case "hookScore":
    case "ctaScore":
    case "offerScore":
    case "clickScore":
    case "watchScore":
      return `${Math.round(value)}/100`;
    default:
      return String(value);
  }
}

function topMetricValue(creative: SharedCreative, key: ShareMetricKey): number | null {
  const value = creative[key as keyof SharedCreative];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (key === "hookScore" || key === "ctaScore" || key === "offerScore" || key === "clickScore" || key === "watchScore") {
    return null;
  }
  return 0;
}

function actionClasses(actionLabel: string) {
  const normalized = actionLabel.toLowerCase();
  if (normalized.includes("scale")) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (normalized.includes("cut")) return "border-rose-200 bg-rose-50 text-rose-800";
  if (normalized.includes("refresh")) return "border-amber-200 bg-amber-50 text-amber-800";
  if (normalized.includes("protect")) return "border-blue-200 bg-blue-50 text-blue-800";
  if (normalized.includes("test")) return "border-sky-200 bg-sky-50 text-sky-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function compactLabel(value: string | null | undefined) {
  return value?.replaceAll("_", " ").trim() || null;
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function AnalysisPill({ label }: { label: string | null | undefined }) {
  const normalized = compactLabel(label);
  if (!normalized) return null;
  return (
    <span className="rounded-full border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-0.5 text-[10px] font-medium text-[#4B5563]">
      {normalized}
    </span>
  );
}

function CreativeAnalysisCard({
  creative,
  analysis,
}: {
  creative: PublicShareCreative;
  analysis: SharedCreativeAnalysis;
}) {
  return (
    <article className="rounded-lg border border-[#E5E7EB] bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-1 text-[13px] font-semibold text-[#111827]">
            {analysis.headline || creative.name}
          </p>
          {analysis.headline && analysis.headline !== creative.name ? (
            <p className="mt-0.5 line-clamp-1 text-[10px] font-medium text-[#6B7280]">{creative.name}</p>
          ) : null}
          <p className="mt-1 text-[11px] leading-relaxed text-[#6B7280]">{analysis.summary}</p>
        </div>
        <span
          className={[
            "shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
            actionClasses(analysis.actionLabel),
          ].join(" ")}
        >
          {analysis.actionLabel}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-[#E5E7EB] bg-[#FAFAFA] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6B7280]">What to do</p>
          <p className="mt-1 text-[12px] font-semibold leading-snug text-[#111827]">{analysis.whatToDo}</p>
        </div>
        <div className="rounded-md border border-[#E5E7EB] bg-[#FAFAFA] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6B7280]">Why</p>
          <p className="mt-1 text-[12px] leading-snug text-[#374151]">{analysis.why}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <AnalysisPill label={analysis.authorityLabel} />
        <AnalysisPill label={`Confidence: ${analysis.confidenceLabel}`} />
        <AnalysisPill label={analysis.evidenceStrength ? `Evidence: ${analysis.evidenceStrength}` : null} />
        <AnalysisPill label={analysis.urgency ? `Urgency: ${analysis.urgency}` : null} />
        <AnalysisPill label={analysis.benchmarkLabel ? `Benchmark: ${analysis.benchmarkLabel}` : null} />
        <AnalysisPill label={analysis.benchmarkReliability ? `Benchmark reliability: ${analysis.benchmarkReliability}` : null} />
        <AnalysisPill label={analysis.amountGuidance ? `Amount: ${analysis.amountGuidance}` : null} />
        <AnalysisPill label={analysis.previewState ? `Preview: ${analysis.previewState}` : null} />
      </div>

      {analysis.factors.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {analysis.factors.slice(0, 4).map((factor) => (
            <div key={`${analysis.creativeId}_${factor.label}`} className="rounded-md border border-[#EEF0F3] px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6B7280]">{factor.label}</p>
                <span className="text-[11px] font-semibold tabular-nums text-[#111827]">{factor.value}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#6B7280]">{factor.reason}</p>
            </div>
          ))}
        </div>
      ) : null}

      {analysis.nextObservation.length > 0 || analysis.invalidActions.length > 0 || analysis.businessValidationNote ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {analysis.nextObservation.length > 0 ? (
            <div className="rounded-md border border-[#E5E7EB] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6B7280]">Watch next</p>
              <ul className="mt-1 space-y-1 text-[11px] leading-snug text-[#4B5563]">
                {analysis.nextObservation.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {analysis.invalidActions.length > 0 || analysis.businessValidationNote ? (
            <div className="rounded-md border border-[#F3D4D4] bg-[#FFF7F7] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[#9F1239]">Do not</p>
              <ul className="mt-1 space-y-1 text-[11px] leading-snug text-[#7F1D1D]">
                {analysis.businessValidationNote ? <li>- {analysis.businessValidationNote}</li> : null}
                {analysis.invalidActions.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

interface PublicCreativeSharePageProps {
  payload: SharePayload;
}

export function PublicCreativeSharePage({ payload }: PublicCreativeSharePageProps) {
  const {
    title,
    dateRange,
    metrics,
    creatives,
    benchmarkCreatives,
    includeNotes,
    note,
    groupBy,
    filters,
    selectedRowIds,
    totalRows,
    createdAt,
    frozenAt,
    openCount,
    audience,
    presetLabel,
    includeCampaignNames,
    includeDecisionLanguage,
    allowCsv,
  } = payload;

  const displayRows = creatives as PublicShareCreative[];
  const showDecisionLanguage =
    includeDecisionLanguage !== false &&
    audience !== "creative_team" &&
    audience !== "external";
  const showCampaignNames = includeCampaignNames !== false;
  const analysisRows = useMemo(
    () =>
      showDecisionLanguage
        ? displayRows.filter(
            (creative): creative is PublicShareCreative & { analysis: SharedCreativeAnalysis } =>
              Boolean(creative.analysis),
          )
        : [],
    [displayRows, showDecisionLanguage],
  );
  const benchmarkRows = useMemo(
    () => ((benchmarkCreatives && benchmarkCreatives.length > 0 ? benchmarkCreatives : creatives) as PublicShareCreative[]),
    [benchmarkCreatives, creatives]
  );

  const benchmarkCtx = useMemo(() => buildShareTableCalcContext(benchmarkRows), [benchmarkRows]);
  const displayCtx = useMemo(() => buildShareTableCalcContext(displayRows), [displayRows]);

  const distributions = useMemo(
    () =>
      buildShareDistributions({
        benchmarkRows,
        benchmarkCtx,
      }),
    [benchmarkCtx, benchmarkRows]
  );

  const roasDistribution = distributions.value.roas;

  const visibleTableColumns = useMemo(() => {
    const mapped = metrics.map(tableColumnForMetric).filter((column): column is ShareTableColumnDefinition => Boolean(column));
    return mapped.length > 0 ? mapped : SHARE_TABLE_COLUMNS.slice(0, 6);
  }, [metrics]);

  const tableMinWidth = useMemo(() => {
    const staticWidth = 300;
    return staticWidth + visibleTableColumns.reduce((sum, column) => sum + column.minWidth, 0);
  }, [visibleTableColumns]);

  const frozenAtLabel = useMemo(() => new Date(frozenAt ?? createdAt).toLocaleString(), [createdAt, frozenAt]);

  const copyLink = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // no-op
    }
  };

  const downloadCsv = () => {
    if (typeof window === "undefined") return;
    const headers = ["Creative", ...visibleTableColumns.map((column) => column.label), "Gap"];
    const lines = displayRows.map((creative, index) => {
      const ctx = displayCtx;
      return [
        showCampaignNames ? creative.name : `Creative asset ${index + 1}`,
        ...visibleTableColumns.map((column) => {
          const value = column.getValue(creative, ctx);
          return isShareMetricApplicable(column.key, creative) ? column.format(value, creative) : "";
        }),
        creative.creativeScoreGap?.label ?? "",
      ].map(csvEscape).join(",");
    });
    const blob = new Blob([[headers.map(csvEscape).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `adsecute-shared-creatives-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#F3F4F6] px-3 py-4 sm:px-5 sm:py-5">
      <main className="mx-auto w-full max-w-[1320px] rounded-xl border border-[#E5E7EB] bg-white p-3 sm:p-4">
        <header className="mb-3 border-b border-[#ECEFF3] pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-[#111827]">{title || "Top Creatives"}</h1>
              <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-[#6B7280]">
                <CalendarRange className="h-3.5 w-3.5" />
                {dateRange}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {allowCsv ? (
                <button
                  type="button"
                  onClick={downloadCsv}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#D1D5DB] px-2.5 py-1.5 text-xs text-[#374151] hover:bg-[#F9FAFB]"
                >
                  Download CSV
                </button>
              ) : null}
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#D1D5DB] px-2.5 py-1.5 text-xs text-[#374151] hover:bg-[#F9FAFB]"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy link
              </button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[#6B7280]">
            <span className="inline-flex items-center gap-1">
              <Rows3 className="h-3.5 w-3.5" />
              {displayRows.length} creatives
            </span>
            {typeof totalRows === "number" ? <span>{totalRows} rows in snapshot</span> : null}
            <span>{benchmarkRows.length} rows in benchmark</span>
            {showCampaignNames && groupBy ? <span>Group by: {groupBy}</span> : null}
            {presetLabel ? <span>Preset: {presetLabel}</span> : null}
            {selectedRowIds && selectedRowIds.length > 0 ? <span>Selection: {selectedRowIds.length}</span> : null}
            <span>Snapshot frozen: {frozenAtLabel}</span>
            {typeof openCount === "number" ? <span>Open count: {openCount}</span> : null}
          </div>

          {filters && filters.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {filters.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-0.5 text-[11px] text-[#6B7280]"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </header>

        <section className="space-y-2">
          <div className="overflow-x-auto pb-1">
            <div className="flex min-w-max gap-2.5">
              {displayRows.map((creative) => (
                <article
                  key={creative.id}
                  className="w-[190px] shrink-0 overflow-hidden rounded-lg border border-[#E5E7EB] bg-white"
                >
                  <CreativeRenderSurface
                    id={creative.id}
                    name={creative.name}
                    preview={creative.preview}
                    size="card"
                    mode="asset"
                    assetFallbacks={[
                      creative.mediaPreviewUrl,
                      creative.cardPreviewUrl,
                      creative.imageUrl,
                      creative.preview?.image_url,
                      creative.preview?.poster_url,
                      creative.previewUrl,
                      creative.cachedThumbnailUrl,
                      creative.thumbnailUrl,
                    ]}
                  />
                  <div className="space-y-1 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="line-clamp-1 text-[12px] font-medium text-[#111827]">{creative.name}</p>
                      <span className="rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-0.5 text-[10px] text-[#6B7280]">
                        {creative.format === "video" ? "Video" : creative.format === "catalog" ? "Catalog" : "Image"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      {metrics.slice(0, 4).map((metric) => (
                        <div key={`${creative.id}_${metric}`}>
                          <p className="text-[10px] text-[#9CA3AF]">{TOP_METRIC_LABELS[metric]}</p>
                          <p className="text-[11px] font-semibold tabular-nums text-[#111827]">
                            {formatTopMetric(metric, topMetricValue(creative, metric))}
                          </p>
                        </div>
                      ))}
                    </div>
                    {creative.creativeScoreGap?.label ? (
                      <span className="inline-flex rounded-full border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-0.5 text-[10px] font-medium text-[#4B5563]">
                        {creative.creativeScoreGap.label}
                      </span>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>

          {analysisRows.length > 0 ? (
            <section className="rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] p-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                <div>
                  <h2 className="text-[13px] font-semibold text-[#111827]">Creative action plan</h2>
                  <p className="mt-0.5 text-[11px] text-[#6B7280]">
                    {analysisRows.length} selected creative{analysisRows.length === 1 ? "" : "s"} with export analysis
                  </p>
                </div>
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                {analysisRows.map((creative) => (
                  <CreativeAnalysisCard
                    key={`analysis_${creative.id}`}
                    creative={creative}
                    analysis={creative.analysis}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-[#E5E7EB]">
            <table className="text-[12px]" style={{ minWidth: tableMinWidth }}>
              <thead className="bg-[#F9FAFB]">
                <tr className="border-b border-[#E5E7EB]">
                  <th className="px-3 py-2 text-left font-medium text-[#6B7280]">Creative</th>
                  {visibleTableColumns.map((column) => (
                    <th key={column.key} className="whitespace-nowrap px-3 py-2 text-right font-medium text-[#6B7280]">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((creative) => (
                  <tr key={`table_${creative.id}`} className="border-b border-[#F0F2F5]">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <CreativeRenderSurface
                          id={creative.id}
                          name={creative.name}
                          preview={creative.preview}
                          size="thumb"
                          mode="asset"
                          className="h-8 w-14 rounded"
                          assetFallbacks={[
                            creative.tableThumbnailUrl,
                            creative.cachedThumbnailUrl,
                            creative.mediaPreviewUrl,
                            creative.thumbnailUrl,
                            creative.imageUrl,
                            creative.preview?.image_url,
                            creative.preview?.poster_url,
                            creative.previewUrl,
                          ]}
                        />
                        <span className="line-clamp-2 text-[11px] text-[#111827]">
                          {showCampaignNames ? creative.name : "Creative asset"}
                        </span>
                      </div>
                    </td>
                    {visibleTableColumns.map((column) => {
                      const value = column.getValue(creative, displayCtx);
                      const distribution = distributions.value[column.key];
                      const spendDistribution = distributions.spend[column.key];

                      if (!distribution || !spendDistribution || !roasDistribution) {
                        return (
                          <td
                            key={`cell_${creative.id}_${column.key}`}
                            className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#111827]"
                          >
                            {column.format(value, creative)}
                          </td>
                        );
                      }

                      const evaluation = evaluateShareMetricCell({
                        key: column.key,
                        row: creative,
                        value,
                        distribution,
                        roasDistribution,
                        spendDistribution,
                      });

                      return (
                        <td
                          key={`cell_${creative.id}_${column.key}`}
                          className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#111827]"
                          style={{
                            backgroundColor: evaluation.applicable
                              ? toShareHeatColor(evaluation.tone, evaluation.intensity)
                              : "transparent",
                          }}
                          title={evaluation.reason}
                        >
                          {isShareMetricApplicable(column.key, creative) ? (
                            column.format(value, creative)
                          ) : (
                            <span className="text-[#9CA3AF]">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {includeNotes && note ? (
          <section className="mt-2 rounded-lg border border-[#E5E7EB] bg-[#FAFAFA] px-3 py-2 text-[12px] text-[#4B5563]">
            {note}
          </section>
        ) : null}

        <footer className="mt-3 border-t border-[#ECEFF3] pt-2 text-[11px] text-[#9CA3AF]">
          Read-only shared report.
        </footer>
      </main>
    </div>
  );
}
