"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type {
  CreativeQuickFilter,
  CreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";
import type { CreativeDecisionOsV1Response } from "@/lib/creative-decision-os";
import type {
  CreativeDecisionOsSnapshot,
  CreativeDecisionOsSnapshotStatus,
} from "@/lib/creative-decision-os-snapshots";
import type { DecisionCenterSnapshot } from "@/lib/creative-decision-center/contracts";
import { CreativeDecisionOsContent } from "@/components/creatives/CreativeDecisionOsContent";

const CREATIVE_DECISION_OS_DRAWER_STORAGE_KEY = "creative-decision-os-drawer-width-v1";
export const CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH = 1240;
export const CREATIVE_DECISION_OS_DRAWER_MIN_WIDTH = 920;

export function clampCreativeDecisionOsDrawerWidth(width: number, viewportWidth: number) {
  const safeViewport = Math.max(360, viewportWidth);
  const maxWidth = Math.max(360, safeViewport - 48);
  const minWidth = Math.min(CREATIVE_DECISION_OS_DRAWER_MIN_WIDTH, maxWidth);
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

type CreativeDecisionOsDrawerProps = {
  decisionOs: CreativeDecisionOsV1Response | null;
  decisionCenter?: DecisionCenterSnapshot | null;
  isLoading: boolean;
  snapshot?: CreativeDecisionOsSnapshot | null;
  snapshotStatus?: CreativeDecisionOsSnapshotStatus;
  snapshotError?: string | null;
  onRunAnalysis?: () => void;
  isRunningAnalysis?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quickFilters: CreativeQuickFilter[];
  allRows: MetaCreativeRow[];
  selectedRows: MetaCreativeRow[];
  activeFamilyId: string | null;
  activeQuickFilterKey: CreativeQuickFilterKey | null;
  onSelectFamily: (familyId: string | null) => void;
  onSelectQuickFilter: (key: CreativeQuickFilterKey) => void;
  onClearFilters: () => void;
};

export function CreativeDecisionOsDrawer({
  decisionOs,
  decisionCenter = null,
  isLoading,
  snapshot = null,
  snapshotStatus = "not_run",
  snapshotError = null,
  onRunAnalysis,
  isRunningAnalysis = false,
  open,
  onOpenChange,
  quickFilters,
  allRows,
  selectedRows,
  activeFamilyId,
  activeQuickFilterKey,
  onSelectFamily,
  onSelectQuickFilter,
  onClearFilters,
}: CreativeDecisionOsDrawerProps) {
  const [width, setWidth] = useState(CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    document.body.style.overflow = "hidden";
    const raw = window.localStorage.getItem(CREATIVE_DECISION_OS_DRAWER_STORAGE_KEY);
    const storedWidth = raw ? Number(raw) : CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH;
    setWidth(
      clampCreativeDecisionOsDrawerWidth(
        Number.isFinite(storedWidth) ? storedWidth : CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH,
        window.innerWidth,
      ),
    );
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const handleMouseMove = (event: MouseEvent) => {
      const active = resizeStateRef.current;
      if (!active) return;
      const delta = active.startX - event.clientX;
      setWidth(clampCreativeDecisionOsDrawerWidth(active.startWidth + delta, window.innerWidth));
    };
    const handleMouseUp = () => {
      resizeStateRef.current = null;
    };
    const handleResize = () => {
      setWidth((current) => clampCreativeDecisionOsDrawerWidth(current, window.innerWidth));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CREATIVE_DECISION_OS_DRAWER_STORAGE_KEY, String(width));
    } catch {
      // ignore persistence failures
    }
  }, [open, width]);

  if (!open) return null;
  const snapshotDate = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  const snapshotTimestamp =
    snapshotDate && !Number.isNaN(snapshotDate.getTime())
      ? snapshotDate.toISOString().slice(0, 16).replace("T", " ")
      : null;
  const hasReadySnapshot = Boolean(decisionOs && snapshotStatus === "ready");

  return (
    <div className="fixed inset-0 z-[88]" data-testid="creative-decision-os-drawer">
      <div
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
      />

      <aside
        className="absolute right-0 top-0 flex h-full flex-col border-l border-slate-200 bg-[#f7f9fc] shadow-2xl"
        style={{ width }}
      >
        <button
          type="button"
          aria-label="Resize Creative Decision OS drawer"
          data-testid="creative-decision-os-drawer-resize"
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-sky-200/70"
          onMouseDown={(event) => {
            event.preventDefault();
            resizeStateRef.current = { startX: event.clientX, startWidth: width };
          }}
        />

        <header className="border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Decision OS
              </p>
              <h2 className="text-xl font-semibold leading-tight tracking-tight text-slate-950">
                Creative System Intelligence
              </h2>
              <p className="mt-0.5 text-[13px] tabular-nums text-slate-500">
                {decisionOs
                  ? `${decisionOs.decisionAsOf} · ${decisionOs.decisionWindows.primary30d.startDate} – ${decisionOs.decisionWindows.primary30d.endDate} · ${decisionOs.summary.totalCreatives} creatives`
                  : snapshot
                  ? `Last analyzed ${snapshotTimestamp ?? snapshot.generatedAt} UTC`
                  : "Run analysis to generate a snapshot"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onRunAnalysis}
                disabled={!onRunAnalysis || isRunningAnalysis}
                className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRunningAnalysis ? "Running…" : "Run Creative Analysis"}
              </button>
              {decisionOs?.summary.operatingMode ? (
                <span className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                  <span className="text-slate-400">Mode:</span>
                  <span className="font-medium text-slate-900">{decisionOs.summary.operatingMode}</span>
                </span>
              ) : null}
              <button
                type="button"
                data-testid="creative-decision-os-drawer-reset-width"
                onClick={() => {
                  if (typeof window === "undefined") {
                    setWidth(CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH);
                    return;
                  }
                  setWidth(
                    clampCreativeDecisionOsDrawerWidth(
                      CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH,
                      window.innerWidth,
                    ),
                  );
                }}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Reset width
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                aria-label="Close Creative Decision OS"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {decisionCenter ? (
            <section
              data-testid="creative-decision-center-drawer-summary"
              className="border-b border-slate-200 bg-white px-6 py-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                    Decision Center V2.1
                  </p>
                  <h3 className="mt-1 text-sm font-semibold text-slate-950">
                    {decisionCenter.rowDecisions.length} row decisions · {decisionCenter.aggregateDecisions.length} aggregate decisions
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {decisionCenter.todayBrief.length} brief items · freshness {decisionCenter.dataFreshness.status}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-[11px] text-slate-500">
                  <span>engine</span>
                  <span className="font-medium text-slate-900">{decisionCenter.engineVersion}</span>
                  <span>adapter</span>
                  <span className="font-medium text-slate-900">{decisionCenter.adapterVersion}</span>
                  <span>config</span>
                  <span className="font-medium text-slate-900">{decisionCenter.configVersion}</span>
                </div>
              </div>
              {decisionCenter.rowDecisions.length === 0 && decisionCenter.aggregateDecisions.length === 0 ? (
                <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  No validated V2.1 actions are present in this snapshot. Legacy Decision OS remains available below.
                </p>
              ) : null}
            </section>
          ) : null}

          {!hasReadySnapshot && (
            <div className="px-5 pt-5 md:px-6">
              <section
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                data-testid="creative-decision-os-not-run-state"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Analysis snapshot
                </p>
                <h3 className="mt-1 text-base font-semibold text-slate-950">
                  {isRunningAnalysis
                    ? "Decision OS analysis is running…"
                    : "Decision OS has not been run for this scope."}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Reporting range changes do not recompute Creative Decision OS. Run analysis to create or refresh the saved operator snapshot.
                </p>
                {snapshotError && (
                  <p className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {snapshotError}
                  </p>
                )}
              </section>
            </div>
          )}
          <CreativeDecisionOsContent
            decisionOs={decisionOs}
            isLoading={isLoading}
            quickFilters={quickFilters}
            activeQuickFilterKey={activeQuickFilterKey}
            onSelectQuickFilter={onSelectQuickFilter}
          />
        </div>
      </aside>
    </div>
  );
}
