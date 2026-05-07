"use client";

import { ArrowRight, Clock, ExternalLink, X } from "lucide-react";
import type { MetaWindowKey, MetaDrillItem } from "@/components/meta/redesign/types";
import { MetaEvidenceAccordion } from "@/components/meta/redesign/MetaEvidenceAccordion";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { scopeNameForRec } from "@/components/meta/redesign/meta-card-utils";

interface MetaDrillDrawerProps {
  item: MetaDrillItem | null;
  window: MetaWindowKey;
  onWindowChange: (window: MetaWindowKey) => void;
  onClose: () => void;
  onLaunch?: () => void;
}

const WINDOWS: MetaWindowKey[] = ["7d", "14d", "28d", "90d", "custom"];

export function MetaDrillDrawer({
  item,
  window,
  onWindowChange,
  onClose,
  onLaunch,
}: MetaDrillDrawerProps) {
  if (!item) return null;
  const isAnomaly = item.mode === "anomaly";
  const title = isAnomaly ? item.anomaly.title : item.rec.title;
  const subtitle = isAnomaly ? item.anomaly.scopeLabel : scopeNameForRec(item.rec);

  return (
    <div className="fixed inset-0 z-50" data-drawer="meta-drill" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-slate-900/20" aria-label="Close drill drawer" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 w-[80%] max-w-[1280px] bg-white border-l border-slate-200 shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {isAnomaly ? <MetaScopeChip level="anomaly" label={item.anomaly.scopeType} /> : <MetaScopeChip level={item.rec.level} />}
              <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700">
                Date:
                <select
                  className="bg-transparent text-[12px] font-medium outline-none"
                  value={window}
                  aria-label="Drill drawer date range"
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
            <h2 className="mt-2 text-[18px] font-semibold text-slate-900">{title}</h2>
            <div className="mt-1 text-[12.5px] text-slate-500">{subtitle}</div>
          </div>
          <button
            type="button"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
            aria-label="Close drill drawer"
            onClick={onClose}
          >
            <X className="inline-block shrink-0" size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="grid gap-4 px-5 py-5">
          {isAnomaly ? (
            <>
              <section className="rounded-xl border border-rose-200 bg-rose-50/30 p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-rose-700">Diagnostic</div>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{item.anomaly.detail}</p>
                <div className="mt-3 grid gap-2">
                  {item.anomaly.diagnostics.map((diagnostic) => (
                    <div key={diagnostic} className="rounded-md border border-rose-100 bg-white px-3 py-2 text-[12.5px] text-slate-700">
                      {diagnostic}
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Recent status</div>
                <div className="mt-2 flex items-center gap-2 text-[12.5px] text-slate-600">
                  <Clock className="inline-block shrink-0" size={13} aria-hidden="true" />
                  Detected at {item.anomaly.detectedAt}
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Engine reasoning</div>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{item.rec.why}</p>
                <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700">{item.rec.recommendedAction}</p>
              </section>
              {item.rec.level === "campaign" ? (
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Adset depth</div>
                  <div className="mt-2 rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-[12.5px] text-slate-600">
                    Campaign-scope drilldowns inherit adset rows from the selected snapshot. Open Launchpad for campaign/adset prefill when actioning.
                  </div>
                </section>
              ) : null}
              <MetaEvidenceAccordion rec={item.rec} />
            </>
          )}
        </div>

        <div className="sticky bottom-0 border-t border-slate-200 bg-slate-50 px-5 py-3 flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50"
            onClick={onClose}
          >
            Close
          </button>
          {!isAnomaly ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-slate-800"
              onClick={onLaunch}
            >
              Launchpad bridge
              <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[12px] text-slate-500">
              Diagnose first
              <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
            </span>
          )}
        </div>
      </aside>
    </div>
  );
}
