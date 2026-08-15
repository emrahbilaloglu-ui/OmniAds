"use client";

/**
 * components/meta/meta-breakdown-grid.tsx
 *
 * Collapsible "Performance Breakdown" panel for the Meta Ads account view.
 * Shows Age ROAS badges and Platform/Placement breakdown in a 2-column grid.
 * Defaults to collapsed — secondary information that can be surfaced on demand.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrencySymbol } from "@/hooks/use-currency";
import { PlacementBreakdownChart, type PlacementChartRow } from "./placement-breakdown-chart";

// ── Shared type ───────────────────────────────────────────────────────────────

export interface BreakdownRow {
  key: string;
  label: string;
  spend: number;
  purchases: number;
  revenue: number;
  clicks: number;
  impressions: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtK(n: number, sym: string): string {
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(1)}k`;
  return `${sym}${n.toFixed(0)}`;
}

function roasTheme(roas: number) {
  if (roas > 2.5)
    return { bg: "bg-[var(--adc-pos-fg)]/10", border: "border-[var(--adc-pos-bd)]/20", text: "text-[var(--adc-pos-fg)]" };
  if (roas >= 1.5)
    return { bg: "bg-[var(--adc-caution-fg)]/10", border: "border-[var(--adc-caution-bd)]/20", text: "text-[var(--adc-caution-fg)]" };
  return { bg: "bg-[var(--adc-danger-fg)]/10", border: "border-[var(--adc-danger-bd)]/15", text: "text-[var(--adc-danger-fg)]" };
}

// ── Age breakdown badges ──────────────────────────────────────────────────────

function AgeBreakdownBadges({ rows, language }: { rows: BreakdownRow[]; language: "en" | "tr" }) {
  const sym = useCurrencySymbol();

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {language === "tr" ? "Yaş verisi yok." : "No age breakdown data."}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {rows.map((row) => {
        const roas = row.spend > 0 ? row.revenue / row.spend : 0;
        const { bg, border, text } = roasTheme(roas);
        return (
          <div key={row.key} className={cn("rounded-lg border p-2", border, bg)}>
            <p className="text-[10px] font-medium leading-none text-muted-foreground">{row.label}</p>
            <p className={cn("mt-1 font-mono text-base font-bold leading-none", text)}>
              {roas.toFixed(2)}
              <span className="ml-0.5 text-xs font-normal opacity-70">×</span>
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{fmtK(row.spend, sym)}</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function BreakdownSkeleton() {
  return (
    <div className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
      ))}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface MetaBreakdownGridProps {
  ageRows: BreakdownRow[];
  placementRows: PlacementChartRow[];
  isLoading: boolean;
  language: "en" | "tr";
}

export function MetaBreakdownGrid({
  ageRows,
  placementRows,
  isLoading,
  language,
}: MetaBreakdownGridProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-slate-100 pt-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-left"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {language === "tr" ? "Performans Dağılımı" : "Performance Breakdown"}
        </p>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-slate-400 transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="mt-3 grid grid-cols-2 gap-4">
          {/* Age ROAS */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {language === "tr" ? "Yaşa Göre ROAS" : "ROAS by Age"}
            </p>
            {isLoading ? <BreakdownSkeleton /> : <AgeBreakdownBadges rows={ageRows} language={language} />}
          </div>

          {/* Platform share */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {language === "tr" ? "Platform Payı" : "Platform Share"}
            </p>
            {isLoading ? (
              <BreakdownSkeleton />
            ) : (
              <PlacementBreakdownChart rows={placementRows} topN={6} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
