"use client";

import { AlertTriangle, ChevronDown, Clock, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { MetaAnomaly } from "@/lib/meta/anomalies";

interface MetaAlertsStripProps {
  anomalies: MetaAnomaly[];
  snapshotDate?: string | null;
  onOpenDiagnostic?: (anomaly: MetaAnomaly) => void;
}

const SEVERITY_CLASS = {
  high: "bg-rose-100 text-rose-700 border-rose-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-sky-100 text-sky-700 border-sky-200",
} as const;

function formatScanTime(value?: string | null) {
  if (!value) return "unknown";
  return value;
}

export function MetaAlertsStrip({ anomalies, snapshotDate, onOpenDiagnostic }: MetaAlertsStripProps) {
  const [open, setOpen] = useState(false);
  const visible = anomalies.slice(0, open ? anomalies.length : 3);
  const hidden = anomalies.slice(3);

  if (anomalies.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/40 px-3 py-2 flex items-center gap-2 text-[12px] text-slate-500" data-alerts-empty>
        <AlertTriangle className="inline-block shrink-0 text-slate-400" size={14} aria-hidden="true" />
        No active anomalies - last scan {formatScanTime(snapshotDate)}
      </div>
    );
  }

  return (
    <div className="rounded-xl border-l-4 border-l-rose-500 border border-rose-200 bg-rose-50/30 overflow-hidden" data-alerts-strip>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-rose-100 bg-rose-50/70">
        <AlertTriangle className="inline-block shrink-0 text-rose-600" size={15} aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-rose-950">
          {anomalies.length} active anomal{anomalies.length === 1 ? "y" : "ies"}
        </span>
        <span className="text-[11.5px] text-rose-700">diagnose before broad budget moves</span>
        {hidden.length > 0 ? (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-rose-700 hover:text-rose-950"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Show less" : "View all"}
            <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="grid gap-1.5 bg-white/70 px-3 py-2">
        {visible.map((anomaly) => (
          <button
            key={anomaly.id}
            type="button"
            className="grid gap-2 rounded-lg border border-rose-100 bg-white px-3 py-2 text-left hover:bg-rose-50/60 md:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
            onClick={() => onOpenDiagnostic?.(anomaly)}
          >
            <span className={`w-fit rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase ${SEVERITY_CLASS[anomaly.severity]}`}>
              {anomaly.severity}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] font-semibold text-slate-900">{anomaly.title}</span>
              <span className="block truncate text-[11.5px] text-slate-500">{anomaly.scopeType} · {anomaly.scopeLabel}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <Clock className="inline-block shrink-0" size={11} aria-hidden="true" />
              {anomaly.detectedAt}
            </span>
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-rose-700">
              Open diagnostic
              <ExternalLink className="inline-block shrink-0" size={11} aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
