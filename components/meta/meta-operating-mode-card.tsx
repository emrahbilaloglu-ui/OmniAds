"use client";

import { useQuery } from "@tanstack/react-query";
import { DecisionAuthorityPanel } from "@/components/decision-trust/DecisionAuthorityPanel";
import { cn } from "@/lib/utils";
import { fetchBusinessOperatingMode, getOperatingModeTone } from "@/lib/business-operating-mode-client";
import type { AccountOperatingModePayload } from "@/src/types/business-commercial";

function SectionList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </p>
      <ul className="mt-1 space-y-1 text-sm text-slate-700">
        {items.map((item) => (
          <li key={`${title}-${item}`}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}

function InputList({
  title,
  rows,
}: {
  title: string;
  rows: AccountOperatingModePayload["activeCommercialInputs"];
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {rows.map((row) => (
          <div
            key={`${title}-${row.label}-${row.detail}`}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              {row.label}
            </p>
            <p className="mt-1 text-sm text-slate-800">{row.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetaOperatingModeCard({
  businessId,
  startDate,
  endDate,
  enabled = true,
}: {
  businessId: string;
  startDate: string;
  endDate: string;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: ["business-operating-mode", businessId, startDate, endDate],
    enabled: enabled && Boolean(businessId && startDate && endDate),
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchBusinessOperatingMode({ businessId, startDate, endDate }),
  });

  if (query.isLoading) {
    return (
      <div
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        data-testid="meta-operating-mode-card"
      >
        <p className="text-sm text-slate-500">Loading operating mode...</p>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        data-testid="meta-operating-mode-card"
      >
        <p className="text-sm text-slate-500">
          Operating mode is currently unavailable.
        </p>
      </div>
    );
  }

  const tone = getOperatingModeTone(query.data.recommendedMode);

  return (
    <section
      className={cn("rounded-2xl border p-4 shadow-sm", tone.panel)}
      data-testid="meta-operating-mode-card"
    >
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Operating Mode
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-950">
            {query.data.recommendedMode}
          </h3>
          <p className="mt-1 text-sm text-slate-700">
            Decisions use live windows. Selected period affects analysis only.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Decision as of {query.data.decisionAsOf} · primary window {query.data.decisionWindows.primary30d.startDate} to {query.data.decisionWindows.primary30d.endDate}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
              tone.badge,
            )}
          >
            Current Mode: {query.data.currentMode}
          </span>
          <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
            Recommended Mode: {query.data.recommendedMode}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <DecisionAuthorityPanel
            authority={query.data.authority}
            commercialSummary={query.data.commercialSummary}
            title="Operating Authority"
          />
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Confidence
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {Math.round(query.data.confidence * 100)}%
            </p>
            {query.data.degradedMode.confidenceCap != null ? (
              <p className="mt-1 text-xs text-slate-500">
                Confidence cap {Math.round(query.data.degradedMode.confidenceCap * 100)}%
              </p>
            ) : null}
          </div>
          <SectionList title="Why" items={query.data.why} />
          <SectionList title="Guardrails" items={query.data.guardrails} />
          <SectionList
            title="What changes this mode"
            items={query.data.changeTriggers}
          />
        </div>

        <div className="space-y-4">
          <InputList
            title="Commercial Drivers"
            rows={query.data.activeCommercialInputs}
          />
          <InputList title="Platform Inputs" rows={query.data.platformInputs} />
          <SectionList title="Missing Inputs" items={query.data.missingInputs} />
          <SectionList title="Degraded Reasons" items={query.data.degradedMode.reasons} />
        </div>
      </div>
    </section>
  );
}
