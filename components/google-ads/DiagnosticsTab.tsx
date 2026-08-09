"use client";

import { cn } from "@/lib/utils";

interface FailedQuery {
  query: string;
  message: string;
  customerId: string;
  family?: string;
}

interface TabMeta {
  label: string;
  meta: {
    partial?: boolean;
    warnings?: string[];
    failed_queries?: FailedQuery[];
    unavailable_metrics?: string[];
  };
}

interface DiagnosticsTabProps {
  tabMetas: TabMeta[];
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", ok ? "bg-emerald-500" : "bg-rose-500")} />;
}

export function DiagnosticsTab({ tabMetas }: DiagnosticsTabProps) {
  const totalWarnings = tabMetas.reduce((s, t) => s + (t.meta.warnings?.length ?? 0), 0);
  const totalFailed = tabMetas.reduce((s, t) => s + (t.meta.failed_queries?.length ?? 0), 0);
  const totalUnavailable = tabMetas.reduce((s, t) => s + (t.meta.unavailable_metrics?.length ?? 0), 0);
  const healthyTabs = tabMetas.filter((t) => !t.meta.partial && !t.meta.failed_queries?.length && !t.meta.warnings?.length).length;

  if (tabMetas.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-12 text-center">
        <p className="text-sm font-medium">No data loaded yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Navigate to other tabs first to load data, then return here for diagnostics.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-semibold">Query Diagnostics</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Health status of all loaded data sources. Only tabs you have visited are shown.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3">
          <p className="text-xs text-muted-foreground">Clean</p>
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{healthyTabs}</p>
          <p className="text-[12px] text-muted-foreground">of {tabMetas.length} loaded</p>
        </div>
        <div className={cn("rounded-xl border p-3", totalWarnings > 0 ? "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Warnings</p>
          <p className={cn("text-2xl font-bold", totalWarnings > 0 ? "text-amber-600 dark:text-amber-400" : "")}>{totalWarnings}</p>
        </div>
        <div className={cn("rounded-xl border p-3", totalFailed > 0 ? "border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Query Failures</p>
          <p className={cn("text-2xl font-bold", totalFailed > 0 ? "text-rose-600 dark:text-rose-400" : "")}>{totalFailed}</p>
        </div>
      </div>

      {/* Per-section status */}
      <div className="space-y-2">
        {tabMetas.map((tab) => {
          const hasIssues = tab.meta.partial || (tab.meta.failed_queries?.length ?? 0) > 0 || (tab.meta.warnings?.length ?? 0) > 0;
          return (
            <div key={tab.label} className={cn("rounded-xl border p-4", hasIssues ? "border-amber-200 dark:border-amber-900/50" : "")}>
              <div className="flex items-center gap-2 mb-2">
                <StatusDot ok={!hasIssues} />
                <p className="text-sm font-medium">{tab.label}</p>
                {tab.meta.partial && (
                  <span className="rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 text-[12px] font-semibold">
                    PARTIAL
                  </span>
                )}
              </div>

              {tab.meta.failed_queries && tab.meta.failed_queries.length > 0 && (
                <div className="mb-2">
                  <p className="text-[12px] font-semibold text-rose-600 dark:text-rose-400 uppercase tracking-wide mb-1">Failed Queries</p>
                  {tab.meta.failed_queries.map((fq, i) => (
                    <div key={i} className="text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground">{fq.query}</span>
                      {fq.customerId && <span className="ml-1">({fq.customerId})</span>}
                      {fq.message && <span className="ml-1">— {fq.message}</span>}
                    </div>
                  ))}
                </div>
              )}

              {tab.meta.warnings && tab.meta.warnings.length > 0 && (
                <div className="mb-2">
                  <p className="text-[12px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-1">Warnings</p>
                  {tab.meta.warnings.map((w, i) => (
                    <p key={i} className="text-[12px] text-muted-foreground">{w}</p>
                  ))}
                </div>
              )}

              {tab.meta.unavailable_metrics && tab.meta.unavailable_metrics.length > 0 && (
                <div>
                  <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Unavailable Metrics</p>
                  <p className="text-[12px] text-muted-foreground">
                    {tab.meta.unavailable_metrics.map((m) => m.replaceAll("_", " ")).join(", ")}
                  </p>
                </div>
              )}

              {!hasIssues && (
                <p className="text-[12px] text-emerald-600 dark:text-emerald-400">✓ All queries completed successfully</p>
              )}
            </div>
          );
        })}
      </div>

      {/* API limitations note */}
      <div className="rounded-xl border bg-muted/20 p-4">
        <p className="text-xs font-semibold mb-2">Known Google Ads API Limitations</p>
        <ul className="space-y-1">
          {[
            "Asset-level revenue attribution is not exposed by the API uniformly.",
            "Search term impression share is not available.",
            "Performance Max asset-level conversion data requires segment-level queries.",
            "Historical quality score changes are not available via API.",
            "Smart Bidding target data requires separate account access.",
          ].map((item, i) => (
            <li key={i} className="text-[12px] text-muted-foreground flex items-start gap-1.5">
              <span className="shrink-0 mt-0.5">·</span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
