"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingPagePerformanceRow } from "@/src/types/landing-pages";
import {
  type LandingPageSortState,
  type LandingPageSortableMetric,
  formatCurrency,
  formatInteger,
  formatPercent,
  getDropOffLabel,
} from "@/components/landing-pages/support";
import { usePreferencesStore } from "@/store/preferences-store";

interface LandingPagesTableSectionProps {
  rows: LandingPagePerformanceRow[];
  currency: string | null;
  sort: LandingPageSortState;
  onSortChange: (next: LandingPageSortState) => void;
  onRowClick: (row: LandingPagePerformanceRow) => void;
  selectedPath?: string | null;
}

function getColumns(language: "en" | "tr"): Array<{
  key: LandingPageSortableMetric;
  label: string;
  render: (row: LandingPagePerformanceRow, currency: string | null) => string;
}> {
  return [
    { key: "sessions", label: language === "tr" ? "Oturumlar" : "Sessions", render: (row) => formatInteger(row.sessions) },
    { key: "engagementRate", label: language === "tr" ? "Etkilesim" : "Engagement", render: (row) => formatPercent(row.engagementRate) },
    { key: "scrollRate", label: "Scroll", render: (row) => formatPercent(row.scrollRate) },
    { key: "viewItem", label: language === "tr" ? "Ürün Goruntuleme" : "View Item", render: (row) => formatInteger(row.viewItem) },
    { key: "addToCarts", label: language === "tr" ? "Sepete Ekle" : "Add to Cart", render: (row) => formatInteger(row.addToCarts) },
    { key: "checkouts", label: "Checkout", render: (row) => formatInteger(row.checkouts) },
    { key: "addShippingInfo", label: language === "tr" ? "Kargo Bilgisi" : "Shipping", render: (row) => formatInteger(row.addShippingInfo) },
    { key: "purchases", label: language === "tr" ? "Satin Almalar" : "Purchases", render: (row) => formatInteger(row.purchases) },
    { key: "totalRevenue", label: language === "tr" ? "Gelir" : "Revenue", render: (row, currency) => formatCurrency(row.totalRevenue, currency) },
    { key: "averagePurchaseRevenue", label: "AOV", render: (row, currency) => formatCurrency(row.averagePurchaseRevenue, currency) },
  ];
}

export function LandingPagesTableSection({
  rows,
  currency,
  sort,
  onSortChange,
  onRowClick,
  selectedPath,
}: LandingPagesTableSectionProps) {
  const language = usePreferencesStore((state) => state.language);
  const columns = getColumns(language);
  return (
    <section className="overflow-hidden rounded-[var(--r-lg,11px)] border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] ">
      <div className="border-b border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--adc-ink3,#7d838c)]">
          {language === "tr" ? "Funnel Tablosu" : "Funnel Table"}
        </p>
        <p className="mt-1 text-sm text-[var(--adc-ink3,#7d838c)]">
          {language === "tr"
            ? "Düşüşü, conversion oranlarını ve AI yorumlarını incelemek için bir landing page seçin."
            : "Click any landing page to inspect drop-offs, conversion rates, and AI commentary."}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1500px] w-full text-sm">
          <thead className="bg-[var(--adc-s1,#f5f5f3)] text-[var(--adc-ink3,#7d838c)]">
            <tr>
              <th className="sticky left-0 z-[1] min-w-[320px] border-r border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-5 py-3 text-left font-semibold">
                Landing Page
              </th>
              {columns.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th key={column.key} className="px-3 py-3 text-right font-semibold">
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange({
                          key: column.key,
                          direction:
                            active && sort.direction === "desc" ? "asc" : "desc",
                        })
                      }
                      className="inline-flex items-center gap-1 text-[var(--adc-ink3,#7d838c)] transition hover:text-[var(--adc-ink,#1a1c1f)]"
                    >
                      {column.label}
                      {active ? (
                        sort.direction === "desc" ? (
                          <ArrowDown className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUp className="h-3.5 w-3.5" />
                        )
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = selectedPath === row.path;
              return (
                <tr
                  key={row.path}
                  className={cn(
                    "cursor-pointer border-t border-[var(--adc-b1,#e4e4e0)] transition-colors hover:bg-[var(--adc-s1,#f5f5f3)]",
                    selected && "bg-[var(--adc-s3,#ededea)]"
                  )}
                  onClick={() => onRowClick(row)}
                >
                  <td className="sticky left-0 z-[1] border-r border-[var(--adc-b1,#e4e4e0)] bg-inherit px-5 py-4 align-top">
                    <div className="space-y-1">
                      <p className="font-semibold text-[var(--adc-ink,#1a1c1f)]">{row.title}</p>
                      <p className="font-mono text-xs text-[var(--adc-ink3,#7d838c)]">{row.path}</p>
                      <div className="flex flex-wrap gap-2 pt-1">
                        <span className="rounded-full bg-[var(--adc-s3,#ededea)] px-2.5 py-1 text-[12px] font-medium text-[var(--adc-ink2,#4a4f56)]">
                          Session CVR {formatPercent(row.sessionToPurchaseRate)}
                        </span>
                        <span className="rounded-full bg-[var(--adc-caution-bg,#faf2df)] px-2.5 py-1 text-[12px] font-medium text-[var(--adc-caution-fg,#86590a)]">
                          {language === "tr" ? "Kacak" : "Leak"} {getDropOffLabel(row.largestDropOffStep, language)}
                        </span>
                      </div>
                    </div>
                  </td>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className="px-3 py-4 text-right font-mono text-[var(--adc-ink2,#4a4f56)]"
                      style={{ fontFeatureSettings: "'tnum'" }}
                    >
                      {column.render(row, currency)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
