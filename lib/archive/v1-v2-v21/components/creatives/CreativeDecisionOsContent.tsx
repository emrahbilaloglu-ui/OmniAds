"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type {
  CreativeDecisionOsV1Response,
  CreativeDecisionOsPattern,
  CreativeDecisionLifecycleState,
} from "@/lib/creative-decision-os";
import type { CreativeQuickFilter, CreativeQuickFilterKey } from "@/lib/creative-operator-surface";

// ─── helpers ─────────────────────────────────────────────────────────────────

function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        className,
      )}
    >
      <div className="mb-4 flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold leading-tight tracking-[-0.005em] text-slate-900">
          {title}
        </h3>
        {subtitle && (
          <p className="text-[11px] leading-relaxed text-slate-500">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Pill({
  tone = "slate",
  children,
}: {
  tone?: "emerald" | "amber" | "rose" | "slate";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-semibold",
        tone === "emerald" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "amber" && "border-amber-200 bg-amber-50 text-amber-700",
        tone === "rose" && "border-rose-200 bg-rose-50 text-rose-700",
        tone === "slate" && "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      {children}
    </span>
  );
}

function Divider() {
  return <div className="my-0.5 h-px bg-slate-100" />;
}

// ─── section 1: portfolio health ────────────────────────────────────────────

function PortfolioHealth({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const tiles = [
    {
      label: "Scale Ready",
      value: String(decisionOs.summary.scaleReadyCount),
      sub: decisionOs.summary.scaleReadyCount > 0
        ? "Ready for controlled budget increase"
        : "No clear scale candidates yet",
      trend: decisionOs.summary.scaleReadyCount === 0 ? "warn" as const : null,
    },
    {
      label: "Protected Winners",
      value: String(decisionOs.summary.protectedWinnerCount),
      sub: "Stable — do not change",
      trend: null,
    },
    {
      label: "In Testing",
      value: String(decisionOs.summary.keepTestingCount),
      sub: decisionOs.summary.keepTestingCount < 2
        ? "Pipeline thin — launch new tests"
        : "Validation pipeline active",
      trend: decisionOs.summary.keepTestingCount < 2 ? "warn" as const : null,
    },
    {
      label: "Need Action",
      value: String(decisionOs.summary.fatiguedCount + decisionOs.summary.blockedCount),
      sub: `${decisionOs.summary.fatiguedCount} fatigued · ${decisionOs.summary.blockedCount} blocked`,
      trend: (decisionOs.summary.fatiguedCount + decisionOs.summary.blockedCount) > 3
        ? "down" as const
        : null,
    },
  ];

  return (
    <SectionCard title="Portfolio Health">
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white px-4 py-3"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              {tile.label}
            </p>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[22px] font-semibold leading-none tracking-tight text-slate-950 tabular-nums">
                {tile.value}
              </span>
              {tile.trend === "down" && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
                  <path d="M6 2V10M6 10L2.5 6.5M6 10L9.5 6.5" stroke="#b45309" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {tile.trend === "warn" && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
                  <path d="M6 1L11 10H1L6 1Z" stroke="#b45309" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
                  <path d="M6 5V7" stroke="#b45309" strokeWidth="1.3" strokeLinecap="round" />
                  <circle cx="6" cy="8.6" r="0.6" fill="#b45309" />
                </svg>
              )}
            </div>
            <p className="text-[11px] leading-snug text-slate-500">{tile.sub}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── section 2: winning patterns ────────────────────────────────────────────

function PatternBar({ label, share, roas, maxShare }: { label: string; share: number; roas: number; maxShare: number }) {
  return (
    <div className="grid items-center gap-3.5" style={{ gridTemplateColumns: "160px 1fr auto" }}>
      <span className="text-[13px] font-medium tracking-[-0.005em] text-slate-900">{label}</span>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-slate-800"
          style={{ width: `${(share / maxShare) * 100}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-[12px] text-slate-500 tabular-nums">
        <span className="font-medium text-slate-900">{share}%</span> spend ·{" "}
        <span className="font-medium text-slate-900">{roas.toFixed(1)}x</span> ROAS
      </span>
    </div>
  );
}

function WinningPatterns({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const { winningFormats = [], hookTrends = [], angleTrends = [] } = decisionOs.historicalAnalysis ?? {};

  const maxFormatShare = Math.max(...winningFormats.map((f) => Math.round(f.shareOfSpend * 100)), 1);
  const maxHookShare = Math.max(...hookTrends.map((h) => Math.round(h.shareOfSpend * 100)), 1);
  const maxAngleShare = Math.max(...angleTrends.map((a) => Math.round(a.shareOfSpend * 100)), 1);

  if (winningFormats.length === 0 && hookTrends.length === 0 && angleTrends.length === 0) {
    return (
      <SectionCard
        title="What's Working"
        subtitle="Patterns driving performance across all creatives this period"
      >
        <p className="text-sm text-slate-500">No pattern data available for the selected window.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="What's Working"
      subtitle="Patterns driving performance across all creatives this period"
    >
      <div className="flex flex-col gap-4">
        {winningFormats.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Format
            </p>
            {winningFormats.slice(0, 4).map((f) => (
              <PatternBar
                key={f.label}
                label={f.label}
                share={Math.round(f.shareOfSpend * 100)}
                roas={f.roas}
                maxShare={maxFormatShare}
              />
            ))}
          </div>
        )}

        {hookTrends.length > 0 && (
          <>
            <Divider />
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Hook
              </p>
              {hookTrends.slice(0, 4).map((h) => (
                <PatternBar
                  key={h.label}
                  label={h.label}
                  share={Math.round(h.shareOfSpend * 100)}
                  roas={h.roas}
                  maxShare={maxHookShare}
                />
              ))}
            </div>
          </>
        )}

        {angleTrends.length > 0 && (
          <>
            <Divider />
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Angle
              </p>
              {angleTrends.slice(0, 4).map((a) => (
                <PatternBar
                  key={a.label}
                  label={a.label}
                  share={Math.round(a.shareOfSpend * 100)}
                  roas={a.roas}
                  maxShare={maxAngleShare}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// ─── section 3: risk signals ─────────────────────────────────────────────────

function buildRiskSignals(decisionOs: CreativeDecisionOsV1Response) {
  const risks: Array<{ tone: "rose" | "amber"; title: string; body: string }> = [];
  const families = decisionOs.families ?? [];

  const fatiguingFamilies = families.filter(
    (f) => f.lifecycleState === "fatigued_winner",
  );
  if (fatiguingFamilies.length >= 2) {
    risks.push({
      tone: "rose",
      title: `${fatiguingFamilies.length} creative families fatiguing simultaneously`,
      body: "Coordinated refresh needed before spend performance drops. Brief new variants soon.",
    });
  } else if (fatiguingFamilies.length === 1) {
    risks.push({
      tone: "amber",
      title: `"${fatiguingFamilies[0].familyLabel}" family showing fatigue signals`,
      body: "Plan a refresh before performance deteriorates further.",
    });
  }

  const totalSpend = families.reduce((sum, f) => sum + f.totalSpend, 0);
  if (totalSpend > 0 && families.length >= 2) {
    const top2Spend = families
      .slice(0, 2)
      .reduce((sum, f) => sum + f.totalSpend, 0);
    const concentration = Math.round((top2Spend / totalSpend) * 100);
    if (concentration > 60) {
      risks.push({
        tone: "amber",
        title: `Spend concentration — top 2 families = ${concentration}% of portfolio`,
        body: "Single-point dependency risk if either family fatigues at the same time.",
      });
    }
  }

  const highPriority = (decisionOs.supplyPlan ?? []).filter((s) => s.priority === "high");
  if (highPriority.length > 0) {
    risks.push({
      tone: "amber",
      title: `${highPriority.length} high-priority creative gap${highPriority.length > 1 ? "s" : ""} in supply backlog`,
      body: highPriority[0]?.summary ?? "Review supply plan for urgent creative needs.",
    });
  }

  if (
    decisionOs.summary.scaleReadyCount === 0 &&
    decisionOs.summary.protectedWinnerCount < 2
  ) {
    risks.push({
      tone: "rose",
      title: "No creatives ready to scale",
      body: "Portfolio lacks clear scale candidates. Increase test velocity and coverage.",
    });
  }

  return risks;
}

function RiskSignals({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const risks = useMemo(() => buildRiskSignals(decisionOs), [decisionOs]);

  if (risks.length === 0) {
    return (
      <SectionCard title="Risk Signals">
        <p className="text-[13px] text-emerald-700">
          No critical signals detected in the current window.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Risk Signals">
      <div className="flex flex-col gap-3">
        {risks.map((risk, i) => (
          <div
            key={i}
            className={cn(
              "border-l-4 pl-3",
              risk.tone === "rose" ? "border-rose-500" : "border-amber-400",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  risk.tone === "rose" ? "bg-rose-500" : "bg-amber-400",
                )}
              />
              <p className="text-[13px] font-semibold tracking-[-0.005em] text-slate-900">
                {risk.title}
              </p>
            </div>
            <p className="mt-1 pl-4 text-[12px] leading-relaxed text-slate-600">{risk.body}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── section 4: format performance ──────────────────────────────────────────

function FormatPerformance({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const formats = decisionOs.historicalAnalysis?.winningFormats ?? [];
  if (formats.length === 0) return null;

  const maxRoas = Math.max(...formats.map((f) => f.roas), 0.1);

  function roasTone(roas: number) {
    if (roas >= 3) return "bg-emerald-500";
    if (roas >= 2) return "bg-amber-400";
    return "bg-rose-400";
  }

  return (
    <SectionCard
      title="Format Performance"
      subtitle="ROAS comparison across active formats in this period"
    >
      <div className="flex flex-col gap-3">
        {formats.slice(0, 5).map((f) => (
          <div
            key={f.label}
            className="grid items-center gap-3.5"
            style={{ gridTemplateColumns: "140px 1fr auto" }}
          >
            <span className="text-[13px] font-medium text-slate-900">{f.label}</span>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn("absolute inset-y-0 left-0 rounded-full", roasTone(f.roas))}
                style={{ width: `${(f.roas / maxRoas) * 100}%` }}
              />
            </div>
            <span className="whitespace-nowrap text-[12px] tabular-nums text-slate-500">
              <span className="font-semibold text-slate-900">{f.roas.toFixed(2)}x</span> ROAS
              {f.label.toLowerCase().includes("carousel") && (
                <Pill tone="amber"> fast fatigue</Pill>
              )}
            </span>
          </div>
        ))}
        {decisionOs.historicalAnalysis?.summary ? (
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            {decisionOs.historicalAnalysis.summary}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

// ─── section 5: coverage map ─────────────────────────────────────────────────

type CellState = "win" | "test" | "cut" | "empty";

function buildCoverageGrid(patterns: CreativeDecisionOsPattern[]) {
  const hookSpend = new Map<string, number>();
  const formatSpend = new Map<string, number>();

  for (const p of patterns) {
    hookSpend.set(p.hook, (hookSpend.get(p.hook) ?? 0) + p.spend);
    formatSpend.set(p.format, (formatSpend.get(p.format) ?? 0) + p.spend);
  }

  const topHooks = [...hookSpend.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hook]) => hook);

  const topFormats = [...formatSpend.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([format]) => format);

  const winnerStates = new Set<CreativeDecisionLifecycleState>([
    "stable_winner",
    "scale_ready",
  ]);
  const cutStates = new Set<CreativeDecisionLifecycleState>(["blocked", "retired"]);

  const grid: CellState[][] = topHooks.map((hook) =>
    topFormats.map((format) => {
      const pattern = patterns.find(
        (p) => p.hook === hook && p.format === format,
      );
      if (!pattern) return "empty";
      if (winnerStates.has(pattern.lifecycleState)) return "win";
      if (cutStates.has(pattern.lifecycleState)) return "cut";
      return "test";
    }),
  );

  const opportunities: string[] = [];
  for (let r = 0; r < topHooks.length; r++) {
    for (let c = 0; c < topFormats.length; c++) {
      if (grid[r][c] !== "empty") continue;
      const adjacentWin =
        (r > 0 && grid[r - 1][c] === "win") ||
        (r < topHooks.length - 1 && grid[r + 1][c] === "win") ||
        (c > 0 && grid[r][c - 1] === "win") ||
        (c < topFormats.length - 1 && grid[r][c + 1] === "win");
      if (adjacentWin) {
        opportunities.push(`${topHooks[r]} × ${topFormats[c]}`);
      }
    }
  }

  return { hooks: topHooks, formats: topFormats, grid, opportunities: opportunities.slice(0, 3) };
}

function CoverageCell({ state }: { state: CellState }) {
  if (state === "empty") {
    return (
      <div className="flex h-9 items-center rounded-lg border border-dashed border-slate-300 px-2.5" />
    );
  }
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-lg border px-2.5",
        state === "win" && "border-emerald-200 bg-emerald-50",
        state === "test" && "border-slate-200 bg-slate-50",
        state === "cut" && "border-rose-200 bg-rose-50",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          state === "win" && "bg-emerald-500",
          state === "test" && "bg-slate-400",
          state === "cut" && "bg-rose-500",
        )}
      />
      <span
        className={cn(
          "text-[11px] font-semibold",
          state === "win" && "text-emerald-700",
          state === "test" && "text-slate-500",
          state === "cut" && "text-rose-600",
        )}
      >
        {state === "win" ? "Win" : state === "test" ? "Test" : "Cut"}
      </span>
    </div>
  );
}

function CoverageMap({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const coverage = useMemo(
    () => buildCoverageGrid(decisionOs.patterns ?? []),
    [decisionOs.patterns],
  );

  if (coverage.hooks.length === 0) return null;

  return (
    <SectionCard
      title="Test Coverage Map"
      subtitle="Which hook × format combinations have you tested?"
    >
      <div
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `160px repeat(${coverage.formats.length}, 1fr)`,
        }}
      >
        <div />
        {coverage.formats.map((f) => (
          <div
            key={f}
            className="pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400"
          >
            {f}
          </div>
        ))}
        {coverage.hooks.map((hook, rowI) => (
          <>
            <div
              key={`hook-${hook}`}
              className="flex items-center py-0.5 text-[13px] font-medium tracking-[-0.005em] text-slate-900"
            >
              {hook}
            </div>
            {coverage.grid[rowI].map((state, colI) => (
              <CoverageCell key={`${rowI}-${colI}`} state={state} />
            ))}
          </>
        ))}
      </div>

      {coverage.opportunities.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
          <span className="font-semibold text-slate-900">
            {coverage.opportunities.length} untested{" "}
            {coverage.opportunities.length === 1 ? "opportunity" : "opportunities"}
          </span>{" "}
          with strong adjacent signals:{" "}
          {coverage.opportunities.map((o, i) => (
            <span key={o}>
              <span className="font-medium text-slate-900">{o}</span>
              {i < coverage.opportunities.length - 1 ? " · " : ""}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── section 6: lifecycle pipeline ──────────────────────────────────────────

function LifecyclePipeline({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const stateLabels: Record<string, { label: string; tone: "emerald" | "amber" | "rose" | "slate" }> = {
    incubating: { label: "New — incubating", tone: "slate" },
    validating: { label: "In test", tone: "slate" },
    scale_ready: { label: "Scale ready", tone: "emerald" },
    stable_winner: { label: "Stable winner", tone: "emerald" },
    fatigued_winner: { label: "Fatigued", tone: "amber" },
    comeback_candidate: { label: "Comeback candidate", tone: "amber" },
    blocked: { label: "Blocked", tone: "rose" },
    retired: { label: "Retired", tone: "rose" },
  };

  const activeStates = (decisionOs.lifecycleBoard ?? []).filter((item) => item.count > 0);
  if (activeStates.length === 0) return null;

  return (
    <SectionCard
      title="Creative Pipeline"
      subtitle="Current distribution of creatives across lifecycle stages"
    >
      <div className="flex flex-col gap-1">
        {activeStates.map((item, i, arr) => {
          const config = stateLabels[item.state] ?? { label: item.label, tone: "slate" as const };
          const total = arr.reduce((sum, s) => sum + s.count, 0);
          const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
          return (
            <div
              key={item.state}
              className="grid items-center gap-3"
              style={{ gridTemplateColumns: "160px 1fr 40px 36px" }}
            >
              <span className="text-[12px] font-medium text-slate-700">{config.label}</span>
              <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    config.tone === "emerald" && "bg-emerald-500",
                    config.tone === "amber" && "bg-amber-400",
                    config.tone === "rose" && "bg-rose-400",
                    config.tone === "slate" && "bg-slate-400",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right text-[11px] tabular-nums text-slate-500">{pct}%</span>
              <span className="text-right text-[13px] font-semibold tabular-nums text-slate-900">
                {item.count}
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─── section 7: protected winners ────────────────────────────────────────────

function ProtectedWinners({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const winners = decisionOs.protectedWinners ?? [];
  if (winners.length === 0) return null;

  return (
    <SectionCard
      title="Active Winners"
      subtitle="Protected creatives — do not change budget, bids, or creative"
    >
      <div className="flex flex-col gap-2">
        {winners.slice(0, 6).map((winner) => (
          <div
            key={winner.creativeId}
            className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-slate-900">
                {winner.creativeName}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">{winner.familyLabel}</p>
              {winner.reasons[0] && (
                <p className="mt-1 text-[11px] leading-snug text-slate-600">{winner.reasons[0]}</p>
              )}
            </div>
            <div className="shrink-0 text-right text-[12px] tabular-nums text-slate-700">
              <p className="font-semibold text-slate-900">{winner.roas.toFixed(2)}x</p>
              <p className="text-slate-500">${Math.round(winner.spend).toLocaleString()}</p>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── section 8: supply plan ───────────────────────────────────────────────────

function SupplyPlan({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const items = decisionOs.supplyPlan ?? [];
  if (items.length === 0) return null;

  const priorityDot: Record<string, string> = {
    high: "bg-rose-500",
    medium: "bg-amber-400",
    low: "bg-slate-400",
  };
  const priorityColor: Record<string, string> = {
    high: "text-rose-600",
    medium: "text-amber-600",
    low: "text-slate-500",
  };
  const kindLabel: Record<string, string> = {
    refresh_existing_winner: "Refresh existing winner",
    expand_angle_family: "Expand angle — new family",
    revive_comeback: "Revive for comeback test",
    new_test: "New test",
  };

  return (
    <SectionCard
      title="What to Create Next"
      subtitle="Prioritised creative backlog based on gaps, fatigue, and coverage"
    >
      <div className="flex flex-col gap-2">
        {items.slice(0, 5).map((item, i) => (
          <div
            key={`${item.kind}-${item.familyId}-${i}`}
            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5"
          >
            <div className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityDot[item.priority] ?? "bg-slate-400")} />
              <span className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", priorityColor[item.priority] ?? "text-slate-500")}>
                {item.priority}
              </span>
            </div>
            <p className="text-[13px] font-semibold leading-snug tracking-[-0.005em] text-slate-900">
              {item.familyLabel}
            </p>
            <p className="text-[12px] leading-relaxed text-slate-600">{item.summary}</p>
            <p className="text-[12px] italic leading-relaxed text-slate-500">
              {kindLabel[item.kind] ?? item.kind.replaceAll("_", " ")}
            </p>
            {item.reasons[0] && (
              <p className="text-[11px] text-slate-500">{item.reasons[0]}</p>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── section 9: comeback candidates ──────────────────────────────────────────

function ComebackCandidates({ decisionOs }: { decisionOs: CreativeDecisionOsV1Response }) {
  const comebacks = (decisionOs.creatives ?? []).filter(
    (c) =>
      c.lifecycleState === "comeback_candidate" ||
      c.primaryAction === "retest_comeback",
  );

  if (comebacks.length === 0) return null;

  return (
    <SectionCard
      title="Comeback Refresh"
      subtitle="Stopped or low-priority creatives where conditions changed enough to justify a controlled refresh"
    >
      <div className="flex flex-col gap-2">
        {comebacks.slice(0, 4).map((c) => (
          <div
            key={c.creativeId}
            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-[13px] font-semibold tracking-[-0.005em] text-slate-900">
                {c.name}
              </p>
              <Pill tone="amber">
                {c.lifecycleState === "comeback_candidate" ? "Comeback" : "Paused winner"}
              </Pill>
            </div>
            <p className="text-[11px] text-slate-500">
              Family: <span className="font-medium text-slate-700">{c.familyLabel}</span>
            </p>
            {c.summary && (
              <div className="border-l-[3px] border-emerald-400 pl-2.5 text-[12px] leading-relaxed text-slate-600">
                <span className="font-semibold text-slate-900">Why refresh: </span>
                {c.summary}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── main export ──────────────────────────────────────────────────────────────

export function CreativeDecisionOsContent({
  decisionOs,
  isLoading,
  quickFilters: _quickFilters,
  activeQuickFilterKey: _activeQuickFilterKey,
  onSelectQuickFilter: _onSelectQuickFilter,
}: {
  decisionOs: CreativeDecisionOsV1Response | null;
  isLoading: boolean;
  quickFilters: CreativeQuickFilter[];
  activeQuickFilterKey: CreativeQuickFilterKey | null;
  onSelectQuickFilter: (key: CreativeQuickFilterKey) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-5 md:p-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-2xl border border-slate-100 bg-white"
          />
        ))}
      </div>
    );
  }

  if (!decisionOs) return null;

  return (
    <div className="flex flex-col gap-4 px-5 py-5 md:px-6">
      <PortfolioHealth decisionOs={decisionOs} />
      <WinningPatterns decisionOs={decisionOs} />
      <RiskSignals decisionOs={decisionOs} />
      <FormatPerformance decisionOs={decisionOs} />
      <CoverageMap decisionOs={decisionOs} />
      <LifecyclePipeline decisionOs={decisionOs} />
      <ProtectedWinners decisionOs={decisionOs} />
      <SupplyPlan decisionOs={decisionOs} />
      <ComebackCandidates decisionOs={decisionOs} />
    </div>
  );
}
