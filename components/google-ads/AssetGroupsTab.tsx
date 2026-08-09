"use client";

import { cn } from "@/lib/utils";
import {
  fmtCurrency, fmtNumber, fmtRoas, fmtPercent,
  TabSkeleton, TabEmpty, SectionLabel, SimpleTable, ColDef,
} from "./shared";

interface Creative {
  id: string;
  name: string;
  type: string;
  status: string;
  adStrength?: "Best" | "Good" | "Low" | "Learning" | "Unknown" | null;
  campaign: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  impressions: number;
  clicks: number;
  assetCount?: number;
  assetMix?: Record<string, number>;
}

const STRENGTH_CONFIG: Record<string, { cls: string; icon: string }> = {
  Best:     { cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300", icon: "✦" },
  Good:     { cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",             icon: "●" },
  Low:      { cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",             icon: "↓" },
  Learning: { cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",         icon: "…" },
  Unknown:  { cls: "bg-muted text-muted-foreground",                                               icon: "?" },
};

const EXPECTED_TYPES = ["HEADLINE", "DESCRIPTION", "IMAGE"];

function diversityScore(assetMix?: Record<string, number>): number {
  if (!assetMix) return 0;
  const keys = Object.keys(assetMix).filter((k) => (assetMix[k] ?? 0) > 0);
  return Math.min(Math.round((keys.length / 5) * 100), 100);
}

function CoverageIndicators({ assetMix }: { assetMix?: Record<string, number> }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {EXPECTED_TYPES.map((t) => {
        const count = assetMix?.[t] ?? 0;
        return (
          <span
            key={t}
            title={`${t}: ${count}`}
            className={cn(
              "rounded px-1 py-0.5 text-[12px] font-semibold uppercase",
              count > 0
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 opacity-60"
            )}
          >
            {t.slice(0, 3)} {count > 0 ? count : "✕"}
          </span>
        );
      })}
    </div>
  );
}

const cols: ColDef<Creative>[] = [
  {
    key: "name", header: "Asset Group", accessor: (r) => r.name,
    render: (r) => {
      const cfg = STRENGTH_CONFIG[r.adStrength ?? "Unknown"];
      return (
        <div className="max-w-[200px]">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", cfg.cls)}>
              {cfg.icon} {r.adStrength ?? "Unknown"}
            </span>
          </div>
          <p className="text-xs font-medium truncate" title={r.name}>{r.name}</p>
          <p className="text-[12px] text-muted-foreground">{r.type}</p>
          {r.assetMix && (
            <div className="mt-1">
              <CoverageIndicators assetMix={r.assetMix} />
            </div>
          )}
        </div>
      );
    },
  },
  { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "revenue", header: "Conv. Value", accessor: (r) => r.revenue, align: "right", render: (r) => fmtCurrency(r.revenue) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn("font-semibold", r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : r.roas < 1 && r.roas > 0 ? "text-rose-600 dark:text-rose-400" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  {
    key: "diversity", header: "Diversity", accessor: (r) => diversityScore(r.assetMix), align: "right",
    render: (r) => {
      const score = diversityScore(r.assetMix);
      return (
        <span className={cn("font-medium", score >= 80 ? "text-emerald-600 dark:text-emerald-400" : score < 40 ? "text-rose-600 dark:text-rose-400" : "")}>
          {r.assetMix ? `${score}%` : "—"}
        </span>
      );
    },
  },
  { key: "assetCount", header: "Assets", accessor: (r) => r.assetCount ?? 0, align: "right", render: (r) => r.assetCount != null ? String(r.assetCount) : "—" },
];

interface AssetGroupsTabProps {
  creatives?: Creative[];
  insights?: string[];
  isLoading: boolean;
}

export function AssetGroupsTab({ creatives, insights, isLoading }: AssetGroupsTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!creatives || creatives.length === 0) {
    return <TabEmpty message="No asset groups found. Requires Performance Max campaigns with asset groups." />;
  }

  const bestCount = creatives.filter((c) => c.adStrength === "Best").length;
  const lowCount = creatives.filter((c) => c.adStrength === "Low").length;
  const missingAssets = creatives.filter((c) => c.assetMix && EXPECTED_TYPES.some((t) => !c.assetMix![t]));

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Asset group performance for Performance Max campaigns. Diversity Score = variety of asset types present.
        Google requires coverage across headlines, descriptions, and images for best performance.
      </p>

      {/* Strength summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3">
          <p className="text-xs text-muted-foreground">Best Strength</p>
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{bestCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">Asset Groups</p>
          <p className="text-2xl font-bold">{creatives.length}</p>
        </div>
        <div className={cn("rounded-xl border p-3", lowCount > 0 ? "border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Low Strength</p>
          <p className={cn("text-2xl font-bold", lowCount > 0 ? "text-rose-600 dark:text-rose-400" : "")}>{lowCount}</p>
        </div>
      </div>

      {/* Missing assets warning */}
      {missingAssets.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
          <p className="text-xs font-semibold">△ {missingAssets.length} asset group{missingAssets.length > 1 ? "s" : ""} missing asset types</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Add missing headlines, descriptions, and images to improve ad strength and reach.
          </p>
        </div>
      )}

      {/* Intelligence insights */}
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          {insights.map((ins, i) => (
            <div key={i} className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
              <p className="text-xs">△ {ins}</p>
            </div>
          ))}
        </div>
      )}

      <SimpleTable cols={cols} rows={creatives} defaultSort="spend" />
    </div>
  );
}
