"use client";

import { CheckCircle2, ChevronDown, Gauge, Save, ShieldCheck } from "lucide-react";
import { PulseStrip } from "@/components/common/briefing";
import type { MetaPulsePayload, MetaWindowKey } from "@/components/meta/redesign/types";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";

interface MetaPulseProps {
  pulse?: MetaPulsePayload | null;
  window: MetaWindowKey;
  onWindowChange: (window: MetaWindowKey) => void;
}

const WINDOWS: MetaWindowKey[] = ["7d", "14d", "28d", "90d", "custom"];

function kpiDelta(current: number | null, prev: number | null) {
  if (current == null || prev == null || prev === 0) return "0%";
  const delta = ((current - prev) / Math.abs(prev)) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
}

function KpiTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: string;
}) {
  return (
    <div className="px-3 py-2 border-l border-slate-100 first:border-l-0">
      <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold">{label}</div>
      <div className="font-mono tabular-nums text-[15px] font-semibold text-slate-900">{value}</div>
      {delta ? <div className="text-[10.5px] text-slate-500">{delta}</div> : null}
    </div>
  );
}

export function MetaPulse({ pulse, window, onWindowChange }: MetaPulseProps) {
  const selectedWindowLabel = window === "custom" ? "Custom" : window;
  const trackingTone =
    !pulse || pulse.trackingHealth.status === "unknown"
      ? "border-slate-200 bg-slate-50 text-slate-600"
      : pulse.trackingHealth.status === "blocked"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : pulse?.trackingHealth.status === "degraded"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-emerald-200 bg-emerald-50 text-emerald-700";

  return (
    <PulseStrip
      variant="meta"
      left={
        <div className="flex items-center gap-2">
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
        </div>
      }
      center={
        <div className="flex items-center gap-3 flex-wrap text-[12px]">
          <span className="inline-flex items-center gap-1 text-slate-600">
            <Gauge className="inline-block shrink-0 text-slate-400" size={13} aria-hidden="true" />
            Pace <span className="font-mono text-slate-900">{pulse ? `${Math.round(pulse.pacing.dayPace * 100)}%` : "—"}</span>
          </span>
          <span className="font-mono text-slate-700">
            {pulse
              ? `7d ${formatRoas(pulse.roas.d7)} / 14d ${formatRoas(pulse.roas.d14)} / 28d ${formatRoas(pulse.roas.d28)}`
              : "7d — / 14d — / 28d —"}
          </span>
          <span className="text-slate-500">{pulse ? `${pulse.matureCampaigns} mature campaigns` : "Loading campaigns"}</span>
        </div>
      }
      right={
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-700">
            {pulse?.operatingMode ?? "Loading"}
          </span>
          <span className="rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-700">
            {pulse?.seasonalRegime ?? "normalized"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] text-slate-600">
            <ShieldCheck className="inline-block shrink-0" size={11} aria-hidden="true" />
            {pulse?.engineVersion ?? "engine"}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] ${trackingTone}`}>
            <CheckCircle2 className="inline-block shrink-0" size={11} aria-hidden="true" />
            {pulse?.trackingHealth.status ?? "unknown"}
          </span>
          <span className="inline-flex items-center gap-1 text-[10.5px] text-slate-500">
            <Save className="inline-block shrink-0" size={11} aria-hidden="true" />
            saved
          </span>
        </div>
      }
      jumpNav={
        <>
          <a href="#action-now" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Action Now</a>
          <a href="#watching" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Watching</a>
          <a href="#healthy" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-50">Healthy</a>
        </>
      }
      kpiBand={
        <>
          <KpiTile label="Spend" value={pulse ? formatCurrency(pulse.spend.current) : "—"} delta={pulse ? kpiDelta(pulse.spend.current, pulse.spend.prev) : undefined} />
          <KpiTile label="Revenue" value={pulse ? formatCurrency(pulse.revenue.current) : "—"} delta={pulse ? kpiDelta(pulse.revenue.current, pulse.revenue.prev) : undefined} />
          <KpiTile label="CPA" value={!pulse ? "—" : pulse.cpa.current == null ? "—" : formatCurrency(pulse.cpa.current)} delta={pulse ? kpiDelta(pulse.cpa.current, pulse.cpa.prev) : undefined} />
          <KpiTile label="ROAS vs target" value={pulse ? `${formatRoas(pulse.roas.d28)} / ${formatRoas(pulse.roas.target)}` : "—"} />
        </>
      }
    />
  );
}
