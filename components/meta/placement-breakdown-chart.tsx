/**
 * components/meta/placement-breakdown-chart.tsx
 *
 * Compact visual progress-list for placement spend share + ROAS.
 * No "use client" — works in both Server and Client Component trees.
 *
 * Row anatomy (2 lines, high-density):
 *   Line 1 │ [Label truncated ▸]          [ROAS 4.21 pill]
 *   Line 2 │ [███░░░░░░░░]  67.3%  $52.9k
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlacementChartRow {
  key: string;
  label: string;
  spend: number;
  roas: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compact spend: $1.2k / $1.3M — keeps pill text short */
function fmtSpend(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlacementBreakdownChart({
  rows,
  topN = 5,
  emptyMessage = "Placement breakdown unavailable for the selected range.",
}: {
  rows: PlacementChartRow[];
  /** How many rows to show. Rows are already sorted spend-desc. Default 5. */
  topN?: number;
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{emptyMessage}</p>
    );
  }

  // Rows arrive sorted by spend desc from the service layer.
  // Slice to topN before computing totalSpend so the bar widths are relative
  // to the visible set, not the full dataset — bars fill the space properly.
  const visible = rows.slice(0, topN);
  const totalSpend = visible.reduce((acc, r) => acc + r.spend, 0);
  const hiddenCount = rows.length - visible.length;

  return (
    // Fixed-height scroll container — safety guard if topN is large or
    // the caller passes an unexpectedly long list.
    <div className="max-h-[350px] overflow-y-auto">
      <div className="space-y-2">
        {visible.map((row) => {
          const sharePct =
            totalSpend > 0 ? (row.spend / totalSpend) * 100 : 0;

          // ROAS colour thresholds: green >2.5, amber 1.5–2.5, red <1.5
          const roasCls =
            row.roas > 2.5
              ? "bg-[var(--adc-pos-fg)]/15 text-[var(--adc-pos-fg)]"
              : row.roas >= 1.5
              ? "bg-[var(--adc-caution-fg)]/15 text-[var(--adc-caution-fg)]"
              : "bg-[var(--adc-danger-fg)]/15 text-[var(--adc-danger-fg)]";

          return (
            <div key={row.key} className="space-y-0.5">
              {/* Line 1: label + ROAS pill */}
              <div className="flex items-center justify-between gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate text-xs font-medium leading-none"
                  title={row.label}
                >
                  {row.label}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold leading-none ${roasCls}`}
                >
                  {row.roas.toFixed(2)}×
                </span>
              </div>

              {/* Line 2: slim bar + share % + spend */}
              <div className="flex items-center gap-1.5">
                <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-[var(--adc-info-fg)]/55"
                    style={{ width: `${sharePct.toFixed(2)}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {sharePct.toFixed(0)}%
                </span>
                <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {fmtSpend(row.spend)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Overflow hint — only shown when rows were truncated */}
      {hiddenCount > 0 && (
        <p className="mt-2 text-[10px] text-muted-foreground/60">
          +{hiddenCount} more placement{hiddenCount !== 1 ? "s" : ""} not shown
        </p>
      )}
    </div>
  );
}
