"use client";

import { useMemo, useState } from "react";
import type { OverviewAttributionRow } from "@/src/types/models";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Circle,
  SlidersHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { formatCurrencySmart } from "@/lib/metric-format";
import { formatPercentSmart } from "@/lib/metric-format";
import { usePreferencesStore } from "@/store/preferences-store";

type SortKey =
  | "channel"
  | "spend"
  | "revenue"
  | "roas"
  | "conversions"
  | "clicks"
  | "ctr"
  | "cpa"
  | "aov";

const DEFAULT_COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "channel", label: "Channel" },
  { key: "spend", label: "Spend" },
  { key: "revenue", label: "Revenue" },
  { key: "roas", label: "ROAS" },
  { key: "conversions", label: "Conversions" },
];

const OPTIONAL_COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "clicks", label: "Clicks" },
  { key: "ctr", label: "CTR" },
  { key: "cpa", label: "CPA" },
  { key: "aov", label: "AOV" },
];

function tr(language: "en" | "tr", english: string, turkish: string) {
  return language === "tr" ? turkish : english;
}

export function SummaryAttributionTable({
  rows,
  currencySymbol,
}: {
  rows: OverviewAttributionRow[];
  currencySymbol: string;
}) {
  const language = usePreferencesStore((state) => state.language);
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [filterText, setFilterText] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<SortKey[]>(
    DEFAULT_COLUMNS.map((column) => column.key)
  );

  const filteredRows = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    return rows
      .filter((row) => row.channel.toLowerCase().includes(normalizedFilter))
      .sort((left, right) => compareRows(left, right, sortKey, sortDirection));
  }, [filterText, rows, sortDirection, sortKey]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder={tr(language, "Filter channels", "Kanallari filtrele")}
            className="h-10 w-56 rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none ring-0 placeholder:text-neutral-400"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2 rounded-xl">
              <SlidersHorizontal className="h-4 w-4" />
              {tr(language, "Columns", "Kolonlar")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {[...DEFAULT_COLUMNS, ...OPTIONAL_COLUMNS].map((column) => (
              <DropdownMenuCheckboxItem
                key={column.key}
                checked={visibleColumns.includes(column.key)}
                onCheckedChange={(checked) =>
                  setVisibleColumns((current) =>
                    checked
                      ? [...current, column.key]
                      : current.filter((entry) => entry !== column.key)
                  )
                }
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/*
        Below 768px this table stacks into one card per channel.

        A horizontal scroller looks like it works and is not: at 390px it hid
        135px of this table, so a channel's ROAS and conversions sat off-screen
        with nothing indicating there was more. Someone comparing channels on a
        phone would compare the two columns that happened to fit. Cards show
        every visible metric for a channel at once, which is what the
        comparison actually needs.
      */}
      <div className="hidden overflow-x-auto rounded-xl border border-neutral-200 bg-white md:block">
        <table className="min-w-full divide-y divide-neutral-200 text-sm tabular-nums">
          <thead className="bg-neutral-50">
            <tr>
              {[...DEFAULT_COLUMNS, ...OPTIONAL_COLUMNS]
                .filter((column) => visibleColumns.includes(column.key))
                .map((column) => (
                <th
                  key={column.key}
                  className={
                    column.key === "channel"
                      ? "px-3 py-3 text-left text-[12px] font-semibold uppercase tracking-[0.16em] text-neutral-500"
                      : "px-3 py-3 text-right text-[12px] font-semibold uppercase tracking-[0.16em] text-neutral-500"
                  }
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className={
                      column.key === "channel"
                        ? "inline-flex items-center gap-1"
                        : "inline-flex items-center justify-end gap-1"
                    }
                  >
                    {column.key === "channel"
                      ? tr(language, "Channel", "Kanal")
                      : column.key === "revenue"
                        ? tr(language, "Revenue", "Gelir")
                        : column.key === "conversions"
                          ? tr(language, "Conversions", "Donusumler")
                          : column.key === "clicks"
                            ? tr(language, "Clicks", "Tiklamalar")
                            : column.label}
                    {sortKey === column.key ? (
                      sortDirection === "asc" ? (
                        <ArrowUp className="h-3.5 w-3.5" />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3.5 w-3.5 text-neutral-400" />
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {filteredRows.map((row) => (
              <tr
                key={row.channel}
                className="transition-colors hover:bg-neutral-50/70"
              >
                {visibleColumns.includes("channel") ? (
                  <td className="px-3 py-2.5 text-sm font-medium text-neutral-900">
                    <div className="flex items-center gap-2">
                      <ChannelBadge channel={row.channel} />
                      <span>{row.channel}</span>
                    </div>
                  </td>
                ) : null}
                {visibleColumns.includes("spend") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCurrency(row.spend, currencySymbol)}
                  </td>
                ) : null}
                {visibleColumns.includes("revenue") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCurrency(row.revenue, currencySymbol)}
                  </td>
                ) : null}
                {visibleColumns.includes("roas") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatRatio(row.roas)}
                  </td>
                ) : null}
                {visibleColumns.includes("conversions") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCount(row.conversions)}
                  </td>
                ) : null}
                {visibleColumns.includes("clicks") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCount(row.clicks)}
                  </td>
                ) : null}
                {visibleColumns.includes("ctr") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatPercent(row.ctr)}
                  </td>
                ) : null}
                {visibleColumns.includes("cpa") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCurrency(row.cpa, currencySymbol)}
                  </td>
                ) : null}
                {visibleColumns.includes("aov") ? (
                  <td className="px-3 py-2.5 text-right text-sm font-medium text-neutral-900">
                    {formatCurrency(row.aov, currencySymbol)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden" data-testid="attribution-cards">
        {filteredRows.map((row) => (
          <li
            key={row.channel}
            className="rounded-xl border border-neutral-200 bg-white p-3"
          >
            <div className="flex items-center gap-2">
              <ChannelBadge channel={row.channel} />
              <span className="text-sm font-medium text-neutral-900">
                {row.channel}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {[...DEFAULT_COLUMNS, ...OPTIONAL_COLUMNS]
                .filter(
                  (column) =>
                    column.key !== "channel" &&
                    visibleColumns.includes(column.key),
                )
                .map((column) => (
                  <div key={column.key} className="flex flex-col">
                    <dt className="text-[12px] text-neutral-500">
                      {columnHeading(column)}
                    </dt>
                    <dd className="text-sm font-medium tabular-nums text-neutral-900">
                      {cellValue(row, column.key)}
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );

  /** The heading a column shows, in the reader's language. */
  function columnHeading(column: { key: SortKey; label: string }) {
    switch (column.key) {
      case "channel":
        return tr(language, "Channel", "Kanal");
      case "revenue":
        return tr(language, "Revenue", "Gelir");
      case "conversions":
        return tr(language, "Conversions", "Donusumler");
      case "clicks":
        return tr(language, "Clicks", "Tiklamalar");
      default:
        return column.label;
    }
  }

  /**
   * One formatter for both layouts.
   *
   * The card stack must show the same number the table would; formatting a
   * value twice is how a phone and a desktop end up disagreeing about spend.
   */
  function cellValue(row: OverviewAttributionRow, key: SortKey) {
    switch (key) {
      case "spend":
        return formatCurrency(row.spend, currencySymbol);
      case "revenue":
        return formatCurrency(row.revenue, currencySymbol);
      case "roas":
        return formatRatio(row.roas);
      case "conversions":
        return formatCount(row.conversions);
      case "clicks":
        return formatCount(row.clicks);
      case "ctr":
        return formatPercent(row.ctr);
      case "cpa":
        return formatCurrency(row.cpa, currencySymbol);
      case "aov":
        return formatCurrency(row.aov, currencySymbol);
      case "channel":
        return row.channel;
    }
  }

  function toggleSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "channel" ? "asc" : "desc");
  }
}

function compareRows(
  left: OverviewAttributionRow,
  right: OverviewAttributionRow,
  key: SortKey,
  direction: "asc" | "desc"
) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (key === "channel") {
    return left.channel.localeCompare(right.channel) * multiplier;
  }
  const numericLeft = typeof left[key] === "number" ? (left[key] as number) : -Infinity;
  const numericRight = typeof right[key] === "number" ? (right[key] as number) : -Infinity;
  return (numericLeft - numericRight) * multiplier;
}

function ChannelBadge({ channel }: { channel: string }) {
  const normalized = channel.toLowerCase();
  const styles =
    normalized.includes("meta")
      ? "bg-[#E7F0FF] text-[#1864FF]"
      : normalized.includes("google")
      ? "bg-[#EDF7ED] text-[#188038]"
      : normalized.includes("ga4") || normalized.includes("analytics")
      ? "bg-[#FFF4E5] text-[#D97706]"
      : normalized.includes("shopify")
      ? "bg-[#ECFDF3] text-[#15803D]"
      : normalized.includes("klaviyo")
      ? "bg-[#F2FDE8] text-[#3F6212]"
      : "bg-neutral-100 text-neutral-600";

  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${styles}`}
      aria-hidden="true"
    >
      <Circle className="h-3 w-3 fill-current stroke-current" />
    </span>
  );
}

function formatCurrency(value: number | null, currencySymbol: string) {
  if (value === null) return "—";
  return formatCurrencySmart(value, currencySymbol);
}

function formatCount(value: number | null) {
  if (value === null) return "—";
  return Math.round(value).toLocaleString();
}

function formatRatio(value: number | null) {
  if (value === null) return "—";
  return value.toFixed(2);
}

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return formatPercentSmart(value);
}
