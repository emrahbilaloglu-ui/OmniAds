"use client";

import { ArrowRight, Info } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { formatPercent } from "@/lib/briefing/utils";
import { MetaCohortChip } from "@/components/meta/redesign/MetaCohortChip";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";

interface MetaUpperFunnelInformationalCardProps {
  rec: MetaRecommendation;
  moneyCurrency?: string | null;
  onOpenDrill?: (rec: MetaRecommendation) => void;
}

export interface MetaUpperFunnelMetrics {
  spend: number | null;
  impressions: number | null;
  thruplayActions: number | null;
  videoViews3s: number | null;
  frequency: number | null;
  costPerThruplayP50: number | null;
}

function numericTargetValue(rec: MetaRecommendation, key: string) {
  const target = rec.targetValue;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const value = (target as Record<string, unknown>)[key];
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function upperFunnelMetricsForRec(rec: MetaRecommendation): MetaUpperFunnelMetrics {
  return {
    spend: numericTargetValue(rec, "spend"),
    impressions: numericTargetValue(rec, "impressions"),
    thruplayActions: numericTargetValue(rec, "thruplayActions"),
    videoViews3s: numericTargetValue(rec, "videoViews3s"),
    frequency: numericTargetValue(rec, "frequency"),
    costPerThruplayP50: numericTargetValue(rec, "costPerThruplayP50"),
  };
}

function formatRatioPercent(numerator: number | null, denominator: number | null) {
  if (numerator == null || denominator == null || denominator <= 0) return "—";
  return formatPercent((numerator / denominator) * 100, 1);
}

function formatFrequency(value: number | null) {
  if (value == null) return "—";
  return value.toFixed(1);
}

function costPerThruplay(
  metrics: MetaUpperFunnelMetrics,
  moneyCurrency: string | null | undefined,
) {
  if (metrics.spend == null || metrics.thruplayActions == null || metrics.thruplayActions <= 0) return "—";
  return formatMoney(metrics.spend / metrics.thruplayActions, moneyCurrency);
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
      <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-1 font-mono text-[14px] font-semibold tabular-nums text-slate-900">{value}</div>
      {sub ? <div className="mt-1 text-[12px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function UpperFunnelKpiGrid({
  metrics,
  moneyCurrency,
}: {
  metrics: MetaUpperFunnelMetrics;
  moneyCurrency?: string | null;
}) {
  const p50Sub =
    metrics.costPerThruplayP50 != null
      ? `vs cohort p50 ${formatMoney(metrics.costPerThruplayP50, moneyCurrency)}`
      : null;

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-upper-funnel-kpi-grid>
      <KpiTile
        label="Cost / ThruPlay"
        value={costPerThruplay(metrics, moneyCurrency)}
        sub={p50Sub}
      />
      <KpiTile label="ThruPlay rate" value={formatRatioPercent(metrics.thruplayActions, metrics.impressions)} />
      <KpiTile label="Hook rate (3s)" value={formatRatioPercent(metrics.videoViews3s, metrics.impressions)} />
      <KpiTile label="Frequency" value={formatFrequency(metrics.frequency)} />
    </div>
  );
}

export function MetaUpperFunnelInformationalCard({
  rec,
  moneyCurrency,
  onOpenDrill,
}: MetaUpperFunnelInformationalCardProps) {
  if (rec.cohort !== "upper_funnel") return null;

  const metrics = upperFunnelMetricsForRec(rec);
  const title = rec.level === "adset"
    ? rec.adsetName ?? rec.title
    : rec.campaignName ?? rec.title;

  return (
    <article
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      data-card="meta-upper-funnel-informational"
      data-rec-id={rec.id}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <MetaScopeChip level={rec.level} />
        <MetaCohortChip cohort={rec.cohort} />
        <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[12px] font-medium text-slate-600">
          <Info className="inline-block shrink-0" size={11} aria-hidden="true" />
          Informational
        </span>
      </div>

      <h4 className="mt-2 text-[14px] font-semibold leading-snug text-slate-900">{title}</h4>
      <p className="mt-1 text-[12.5px] leading-snug text-slate-600">
        Brand-build cohort — no purchase decision evaluation
      </p>

      <div className="mt-3">
        <UpperFunnelKpiGrid
          metrics={metrics}
          moneyCurrency={moneyCurrency}
        />
      </div>

      <div className="mt-3 flex items-center justify-end">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
          aria-haspopup="dialog"
          onClick={() => onOpenDrill?.(rec)}
        >
          View in drawer
          <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
