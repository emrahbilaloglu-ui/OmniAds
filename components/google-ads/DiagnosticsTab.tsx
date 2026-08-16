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
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", ok ? "bg-[var(--adc-pos-fg)]" : "bg-[var(--adc-danger-fg)]")} />;
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
        <div className="rounded-xl border border-[var(--adc-pos-bd)] dark:border-[var(--adc-pos-bd)]/50 bg-[var(--adc-pos-bg)] dark:bg-[var(--adc-pos-fg)]/30 p-3">
          <p className="text-xs text-muted-foreground">Clean</p>
          <p className="text-2xl font-bold text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]">{healthyTabs}</p>
          <p className="text-[10px] text-muted-foreground">of {tabMetas.length} loaded</p>
        </div>
        <div className={cn("rounded-xl border p-3", totalWarnings > 0 ? "border-[var(--adc-caution-bd)] dark:border-[var(--adc-caution-bd)]/50 bg-[var(--adc-caution-bg)] dark:bg-[var(--adc-caution-fg)]/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Warnings</p>
          <p className={cn("text-2xl font-bold", totalWarnings > 0 ? "text-[var(--adc-caution-fg)] dark:text-[var(--adc-caution-fg)]" : "")}>{totalWarnings}</p>
        </div>
        <div className={cn("rounded-xl border p-3", totalFailed > 0 ? "border-[var(--adc-danger-bd)] dark:border-[var(--adc-danger-bd)]/50 bg-[var(--adc-danger-bg)] dark:bg-[var(--adc-danger-fg)]/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Query Failures</p>
          <p className={cn("text-2xl font-bold", totalFailed > 0 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "")}>{totalFailed}</p>
        </div>
      </div>

      {/* Per-section status */}
      <div className="space-y-2">
        {tabMetas.map((tab) => {
          const hasIssues = tab.meta.partial || (tab.meta.failed_queries?.length ?? 0) > 0 || (tab.meta.warnings?.length ?? 0) > 0;
          return (
            <div key={tab.label} className={cn("rounded-xl border p-4", hasIssues ? "border-[var(--adc-caution-bd)] dark:border-[var(--adc-caution-bd)]/50" : "")}>
              <div className="flex items-center gap-2 mb-2">
                <StatusDot ok={!hasIssues} />
                <p className="text-sm font-medium">{tab.label}</p>
                {tab.meta.partial && (
                  <span className="rounded-full bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] dark:bg-[var(--adc-caution-fg)]/40 dark:text-[var(--adc-caution-fg)] px-1.5 py-0.5 text-[9px] font-semibold">
                    PARTIAL
                  </span>
                )}
              </div>

              {tab.meta.failed_queries && tab.meta.failed_queries.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] font-semibold text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)] uppercase tracking-wide mb-1">Failed Queries</p>
                  {tab.meta.failed_queries.map((fq, i) => (
                    <div key={i} className="text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground">{fq.query}</span>
                      {fq.customerId && <span className="ml-1">({fq.customerId})</span>}
                      {fq.message && <span className="ml-1">— {fq.message}</span>}
                    </div>
                  ))}
                </div>
              )}

              {tab.meta.warnings && tab.meta.warnings.length > 0 && (
                <div className="mb-2">
                  <p className="text-[10px] font-semibold text-[var(--adc-caution-fg)] dark:text-[var(--adc-caution-fg)] uppercase tracking-wide mb-1">Warnings</p>
                  {tab.meta.warnings.map((w, i) => (
                    <p key={i} className="text-[10px] text-muted-foreground">{w}</p>
                  ))}
                </div>
              )}

              {tab.meta.unavailable_metrics && tab.meta.unavailable_metrics.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Unavailable Metrics</p>
                  <p className="text-[10px] text-muted-foreground">
                    {tab.meta.unavailable_metrics.map((m) => m.replaceAll("_", " ")).join(", ")}
                  </p>
                </div>
              )}

              {!hasIssues && (
                <p className="text-[10px] text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]">✓ All queries completed successfully</p>
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
            <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1.5">
              <span className="shrink-0 mt-0.5">·</span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
