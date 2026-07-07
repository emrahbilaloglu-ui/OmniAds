"use client";

import { useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ColumnDef<T> {
  key: keyof T | string;
  header: string;
  accessor: (row: T) => string | number;
  render?: (row: T) => React.ReactNode;
  align?: "left" | "right";
  sortable?: boolean;
  heatmap?: boolean; // color the value based on relative magnitude
  heatmapInvert?: boolean; // lower = better (e.g. bounce rate)
  sticky?: boolean;
}

interface SortableTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  defaultSortKey?: string;
  defaultSortDir?: "asc" | "desc";
  emptyText?: string;
  maxRows?: number;
}

export function SortableTable<T extends object>({
  columns,
  rows,
  defaultSortKey,
  defaultSortDir = "desc",
  emptyText = "No data available.",
  maxRows,
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<string>(defaultSortKey ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDir);

  const sortedRows = [...rows].sort((a, b) => {
    if (!sortKey) return 0;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return 0;
    const av = col.accessor(a);
    const bv = col.accessor(b);
    if (typeof av === "number" && typeof bv === "number") {
      return sortDir === "asc" ? av - bv : bv - av;
    }
    return sortDir === "asc"
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const displayRows = maxRows ? sortedRows.slice(0, maxRows) : sortedRows;

  // Compute heatmap max per column
  const heatmapMax: Record<string, number> = {};
  for (const col of columns) {
    if (col.heatmap) {
      const vals = rows.map((r) => col.accessor(r)).filter((v) => typeof v === "number") as number[];
      heatmapMax[String(col.key)] = Math.max(...vals, 0.001);
    }
  }

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((col) => (
              <th
                key={String(col.key)}
                className={cn(
                  "py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                  col.align === "right" ? "text-right" : "text-left",
                  col.sticky && "sticky left-0 bg-white z-10",
                  col.sortable !== false && "cursor-pointer select-none hover:text-foreground"
                )}
                onClick={() => col.sortable !== false && handleSort(String(col.key))}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortable !== false && (
                    <span className="opacity-40">
                      {sortKey === col.key ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3" />
                      )}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => (
            <tr
              key={i}
              className="border-b last:border-0 hover:bg-muted/30 transition-colors"
            >
              {columns.map((col) => {
                const rawValue = col.accessor(row);
                const max = heatmapMax[String(col.key)] ?? 1;
                const ratio =
                  col.heatmap && typeof rawValue === "number"
                    ? rawValue / max
                    : null;

                let heatClass = "";
                if (ratio !== null) {
                  const effective = col.heatmapInvert ? 1 - ratio : ratio;
                  if (effective >= 0.7) heatClass = "text-emerald-600 dark:text-emerald-400 font-medium";
                  else if (effective >= 0.4) heatClass = "text-foreground";
                  else if (effective >= 0.15) heatClass = "text-amber-600 dark:text-amber-400";
                  else heatClass = "text-rose-600 dark:text-rose-400";
                }

                return (
                  <td
                    key={String(col.key)}
                    className={cn(
                      "py-2.5 pr-4",
                      col.align === "right" ? "text-right tabular-nums" : "",
                      col.sticky && "sticky left-0 bg-white z-10",
                      heatClass
                    )}
                  >
                    {col.render ? col.render(row) : rawValue}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
