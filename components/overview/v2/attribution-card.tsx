"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { formatCurrencySmart } from "@/lib/metric-format";
import type { OverviewAttributionRow } from "@/src/types/models";

const CHANNEL_LOGOS: Array<{ match: RegExp; logo: string }> = [
  { match: /meta|facebook|instagram/i, logo: "/platform-logos/Meta.png" },
  { match: /google\s*ads|adwords/i, logo: "/platform-logos/googleAds.svg" },
  { match: /klaviyo/i, logo: "/platform-logos/Klaviyo.svg" },
  { match: /tiktok/i, logo: "/platform-logos/tiktok.svg" },
  { match: /pinterest/i, logo: "/platform-logos/Pinterest.svg" },
  { match: /snapchat/i, logo: "/platform-logos/snapchat.svg" },
  { match: /shopify/i, logo: "/platform-logos/shopify_glyph.svg" },
  { match: /ga4|organic|analytics|direct|referral|search/i, logo: "/platform-logos/GA4.svg" },
];

function channelLogo(channel: string, source: string) {
  const hay = `${channel} ${source}`;
  return CHANNEL_LOGOS.find((entry) => entry.match.test(hay))?.logo ?? null;
}

type SortKey = "spend" | "revenue" | "roas" | "conversions";

const COLUMNS = [
  { key: "spend", label: "Spend", optional: false },
  { key: "revenue", label: "Revenue", optional: false },
  { key: "roas", label: "ROAS", optional: false },
  { key: "cpa", label: "CPA", optional: true },
  { key: "aov", label: "AOV", optional: true },
  { key: "conversions", label: "Conv.", optional: false },
  { key: "clicks", label: "Clicks", optional: true },
  { key: "ctr", label: "CTR", optional: true },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const DEFAULT_COLUMNS: ColumnKey[] = ["spend", "revenue", "roas", "cpa", "aov", "conversions"];

/** Missing figures render as an em dash — never as zero. */
function dash(value: number | null | undefined, render: (value: number) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return render(value);
}

export function AttributionCard({
  rows,
  currencySymbol,
  loading = false,
}: {
  rows: OverviewAttributionRow[];
  currencySymbol: string;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [pickerOpen, setPickerOpen] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) => row.channel.toLowerCase().includes(needle))
      : rows;
    return [...filtered].sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));
  }, [filter, rows, sortKey]);

  const revenueTotal = visible.reduce((sum, row) => sum + (row.revenue ?? 0), 0);
  const activeColumns = COLUMNS.filter((column) => columns.includes(column.key));

  return (
    <article className="adv-card overflow-hidden">
      <div className="adv-card-head">
        <h2 className="adv-card-title">Attribution by channel</h2>
        <div className="relative flex gap-1.5">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter channels"
            aria-label="Filter channels"
            className="adv-input w-[160px]"
          />
          <button
            type="button"
            className="adv-btn adv-btn--sm"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
          >
            Columns
          </button>
          {pickerOpen ? (
            <div className="absolute right-0 top-[34px] z-20 w-[190px] rounded-[var(--adv-r-tile)] border border-[var(--adv-border)] bg-white p-2 shadow-[0_16px_40px_rgba(11,16,32,0.16)]">
              {COLUMNS.map((column) => (
                <label
                  key={column.key}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
                >
                  <input
                    type="checkbox"
                    checked={columns.includes(column.key)}
                    disabled={!column.optional && columns.includes(column.key)}
                    onChange={(event) =>
                      setColumns((current) =>
                        event.target.checked
                          ? [...current, column.key]
                          : current.filter((key) => key !== column.key),
                      )
                    }
                  />
                  {column.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="adv-scroll-x">
        <table className="adv-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              {activeColumns.map((column) => {
                const sortable = ["spend", "revenue", "roas", "conversions"].includes(
                  column.key,
                );
                return (
                  <th key={column.key} scope="col">
                    {sortable ? (
                      <button
                        type="button"
                        className="cursor-pointer bg-transparent font-[inherit] text-[inherit] uppercase tracking-[inherit]"
                        onClick={() => setSortKey(column.key as SortKey)}
                      >
                        {column.label}
                        {sortKey === column.key ? " ↓" : ""}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={activeColumns.length + 2} className="!text-center">
                  <span className="text-[var(--adv-ink-3)]">Loading attribution…</span>
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={activeColumns.length + 2} className="!text-center">
                  <span className="text-[var(--adv-ink-3)]">
                    No attributed channels for this window.
                  </span>
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const logo = channelLogo(row.channel, row.source);
                const share =
                  revenueTotal > 0 && row.revenue !== null
                    ? `${Math.round((row.revenue / revenueTotal) * 100)}%`
                    : "—";
                return (
                  <tr key={`${row.channel}-${row.source}`}>
                    <td>
                      <span className="inline-flex items-center gap-2.5">
                        <span className="grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[var(--adv-border)] bg-[var(--adv-fill-2)]">
                          {logo ? (
                            <Image
                              src={logo}
                              alt=""
                              width={15}
                              height={15}
                              className="h-[15px] w-[15px] object-contain"
                              aria-hidden="true"
                            />
                          ) : null}
                        </span>
                        <span className="font-semibold text-[var(--adv-ink)]">
                          {row.channel}
                        </span>
                      </span>
                    </td>
                    {activeColumns.map((column) => {
                      if (column.key === "roas") {
                        const positive = (row.roas ?? 0) >= 1;
                        return (
                          <td key={column.key}>
                            <span
                              className="inline-flex rounded-[6px] px-[7px] py-0.5 text-[12px] font-semibold"
                              style={
                                row.roas === null
                                  ? {
                                      background: "var(--adv-fill-2)",
                                      color: "var(--adv-ink-3)",
                                    }
                                  : positive
                                    ? {
                                        background: "var(--adc-pos-bg)",
                                        color: "var(--adc-pos-fg)",
                                      }
                                    : {
                                        background: "var(--adc-danger-bg)",
                                        color: "var(--adc-danger-fg)",
                                      }
                              }
                            >
                              {dash(row.roas, (value) => value.toFixed(2))}
                            </span>
                          </td>
                        );
                      }
                      if (column.key === "revenue") {
                        return (
                          <td key={column.key} className="!font-semibold !text-[var(--adv-ink)]">
                            {dash(row.revenue, (value) =>
                              formatCurrencySmart(value, currencySymbol, { compactLarge: false }),
                            )}
                          </td>
                        );
                      }
                      if (column.key === "spend") {
                        return (
                          <td key={column.key} className="!text-[var(--adv-ink)]">
                            {dash(row.spend, (value) =>
                              formatCurrencySmart(value, currencySymbol, { compactLarge: false }),
                            )}
                          </td>
                        );
                      }
                      if (column.key === "cpa" || column.key === "aov") {
                        // Per-unit money keeps cents; totals do not.
                        return (
                          <td key={column.key}>
                            {dash(
                              row[column.key],
                              (value) =>
                                `${currencySymbol}${value.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}`,
                            )}
                          </td>
                        );
                      }
                      if (column.key === "ctr") {
                        return (
                          <td key={column.key}>
                            {dash(row.ctr, (value) => `${value.toFixed(2)}%`)}
                          </td>
                        );
                      }
                      return (
                        <td key={column.key}>
                          {dash(row[column.key as "conversions" | "clicks"], (value) =>
                            Math.round(value).toLocaleString(),
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <span className="inline-flex items-center justify-end gap-2">
                        <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-[var(--adv-hairline)]">
                          <span
                            className="block h-full rounded-full bg-[var(--adv-accent)]"
                            style={{ width: share === "—" ? 0 : share }}
                          />
                        </span>
                        <span className="min-w-[34px] text-[12px] text-[var(--adv-ink-3)]">
                          {share}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}
