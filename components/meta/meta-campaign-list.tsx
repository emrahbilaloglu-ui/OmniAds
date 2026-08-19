"use client";

/**
 * components/meta/meta-campaign-list.tsx
 *
 * Left panel: sortable, vertically scrolled campaign list.
 * Click → right panel updates with campaign detail.
 * Sort: ROAS | Spend | CPA (client-side, state kept here)
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { MetaCampaignTableRow } from "@/components/meta/meta-campaign-table";
import { useCurrencySymbol } from "@/hooks/use-currency";

// A money value whose currency is unknown renders as the missing mark, not as
// a dollar figure. INVARIANTS.md: "Missing currency must not silently become
// USD, $, TRY, or EUR." The `sym = "$"` defaults these formatters carried were
// exactly that substitution, one hop below the store.
function fmtSpend(n: number, sym: string | null): string {
  if (sym === null) return "—";
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(1)}k`;
  return `${sym}${n.toFixed(0)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function roasColor(roas: number) {
  if (roas > 2.5) return "text-[var(--adc-pos-fg)]";
  if (roas >= 1.5) return "text-[var(--adc-caution-fg)]";
  return "text-[var(--adc-danger-fg)]";
}

function statusDot(status: string) {
  const lower = status.toLowerCase();
  if (lower === "active")
    return <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--adc-pos-fg)]" />;
  if (lower === "paused")
    return <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />;
  return <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />;
}

function laneDot(lane: MetaCampaignTableRow["laneLabel"]) {
  if (lane === "Scaling")
    return (
      <span className="shrink-0 rounded-sm bg-[var(--adc-info-fg)]/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--adc-info-fg)]">
        S
      </span>
    );
  if (lane === "Validation")
    return (
      <span className="shrink-0 rounded-sm bg-slate-400/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-600">
        V
      </span>
    );
  if (lane === "Test")
    return (
      <span className="shrink-0 rounded-sm bg-[var(--adc-caution-fg)]/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--adc-caution-fg)]">
        T
      </span>
    );
  return null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface MetaCampaignListProps {
  campaigns: MetaCampaignTableRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "active" | "inactive";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Actives" },
  { key: "inactive", label: "Inactive" },
];

export function MetaCampaignList({
  campaigns,
  selectedId,
  onSelect,
}: MetaCampaignListProps) {
  const language = "en" as "en" | "tr";
  const sym = useCurrencySymbol();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const sortedCampaigns = [...campaigns].sort((a, b) => b.spend - a.spend);

  const filteredCampaigns = sortedCampaigns.filter((c) => {
    if (statusFilter === "all") return true;
    const isActive = c.status.toLowerCase() === "active";
    return statusFilter === "active" ? isActive : !isActive;
  });

  return (
    <div className="space-y-px">
      {/* Status filter */}
      <div className="flex items-center gap-0.5 px-1 pb-1 pt-0.5">
        {STATUS_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-semibold transition-colors",
              statusFilter === key
                ? "bg-foreground/[0.08] text-foreground"
                : "text-slate-400 hover:text-slate-600"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Account Overview row */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
          selectedId === null
            ? "bg-foreground/[0.06] ring-1 ring-foreground/10"
            : "hover:bg-muted/60"
        )}
      >
        <span
          className={cn(
            "text-[12px] font-semibold",
            selectedId === null ? "text-foreground" : "text-slate-500"
          )}
        >
          {language === "tr" ? "Hesap Geneli" : "Account Overview"}
        </span>
      </button>

      {campaigns.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {language === "tr" ? "Kampanya bulunamadı." : "No campaigns found."}
        </p>
      ) : filteredCampaigns.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {language === "tr" ? "Bu filtreye uygun kampanya yok." : "No campaigns match this filter."}
        </p>
      ) : (
        filteredCampaigns.map((c) => {
          const isSelected = c.id === selectedId;

          return (
            <button
              key={c.id}
              type="button"
              id={`meta-list-item-${c.id}`}
              data-testid={`meta-list-item-${c.id}`}
              onClick={() => onSelect(c.id === selectedId ? null : c.id)}
              className={cn(
                "group flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                isSelected
                  ? "bg-foreground/[0.06] ring-1 ring-foreground/10"
                  : "hover:bg-muted/60"
              )}
            >
              {/* Status dot */}
              {statusDot(c.status)}

              {/* Name + objective + lane */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p
                    className={cn(
                      "truncate text-[12px] font-medium leading-snug",
                      isSelected ? "text-foreground" : "text-slate-700"
                    )}
                  >
                    {c.name}
                  </p>
                </div>
                {(c.objective || c.laneLabel) && (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {c.objective && (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {c.objective}
                      </span>
                    )}
                    {laneDot(c.laneLabel ?? null)}
                  </div>
                )}
              </div>

              {/* ROAS + Spend */}
              <div className="shrink-0 text-right">
                <span
                  className={cn(
                    "font-mono text-[12px] font-bold tabular-nums",
                    roasColor(c.roas)
                  )}
                >
                  {c.roas.toFixed(2)}
                  <span className="text-[10px] font-normal opacity-60">×</span>
                </span>
                <p className="text-[10px] tabular-nums text-slate-400">
                  <span className="mr-0.5 text-[9px] uppercase tracking-wide opacity-50">spend </span>
                  {fmtSpend(c.spend, sym)}
                </p>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
