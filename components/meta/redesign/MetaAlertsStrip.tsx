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
  high: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)] border-[var(--adc-danger-bd)]",
  medium: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] border-[var(--adc-caution-bd)]",
  low: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] border-[var(--adc-info-bd)]",
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
    <div className="rounded-xl border-l-4 border-l-rose-500 border border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)]/30 overflow-hidden" data-alerts-strip>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)]/70">
        <AlertTriangle className="inline-block shrink-0 text-[var(--adc-danger-fg)]" size={15} aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-[var(--adc-danger-fg)]">
          {anomalies.length} active anomal{anomalies.length === 1 ? "y" : "ies"}
        </span>
        <span className="text-[11.5px] text-[var(--adc-danger-fg)]">diagnose before broad budget moves</span>
        {hidden.length > 0 ? (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-[var(--adc-danger-fg)] hover:text-[var(--adc-danger-fg)]"
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
            className="grid gap-2 rounded-lg border border-[var(--adc-danger-bd)] bg-white px-3 py-2 text-left hover:bg-[var(--adc-danger-bg)]/60 md:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
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
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--adc-danger-fg)]">
              Open diagnostic
              <ExternalLink className="inline-block shrink-0" size={11} aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
