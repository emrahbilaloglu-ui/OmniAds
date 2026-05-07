"use client";

import { AlertTriangle, ChevronDown, ExternalLink } from "lucide-react";
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
  const visible = anomalies.slice(0, 3);
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
    <div className="rounded-lg border-l-4 border-l-rose-500 border border-rose-200 bg-rose-50/30 overflow-hidden" data-alerts-strip>
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <AlertTriangle className="inline-block shrink-0 text-rose-600" size={15} aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-rose-900">
          {anomalies.length} active anomal{anomalies.length === 1 ? "y" : "ies"}
        </span>
        {visible.map((anomaly) => (
          <button
            key={anomaly.id}
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-[11.5px] text-slate-700 hover:bg-rose-50"
            onClick={() => onOpenDiagnostic?.(anomaly)}
          >
            <span className={`rounded border px-1 text-[9.5px] font-semibold uppercase ${SEVERITY_CLASS[anomaly.severity]}`}>
              {anomaly.severity}
            </span>
            <span className="max-w-[180px] truncate">{anomaly.scopeLabel}</span>
            <ExternalLink className="inline-block shrink-0" size={11} aria-hidden="true" />
          </button>
        ))}
        {hidden.length > 0 ? (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-rose-700 hover:text-rose-900"
            onClick={() => setOpen((current) => !current)}
          >
            View all
            <ChevronDown className="inline-block shrink-0" size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-rose-100 bg-white px-3 py-2 grid gap-1.5">
          {hidden.map((anomaly) => (
            <button
              key={anomaly.id}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50"
              onClick={() => onOpenDiagnostic?.(anomaly)}
            >
              <span className={`rounded border px-1 text-[9.5px] font-semibold uppercase ${SEVERITY_CLASS[anomaly.severity]}`}>
                {anomaly.severity}
              </span>
              <span className="text-[12px] font-medium text-slate-800">{anomaly.title}</span>
              <span className="ml-auto text-[11px] text-slate-500">{anomaly.detectedAt}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
