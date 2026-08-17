"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import { buildCreativeStudioTabHrefs } from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import {
  mapApiRowToCopyRow,
  type CopyMotionRow,
} from "@/app/(dashboard)/platforms/meta/copies/page-support";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { resolveCreativeDateRange } from "@/components/creatives/CreativesTopSection";
import { standardDateRangeToCreative } from "@/components/creatives/creatives-top-section-support";
import { buildCreativeStudioCopiesModel } from "@/components/creatives/creative-studio-exact-adapters";
import { formatMoney } from "@/components/creatives/money";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";

interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
    generatedAt?: string;
    warehouseObservedAt?: string | null;
    provider_account_id?: string;
  };
}

export interface CopiesPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

function hasMessage(payload: unknown): payload is { message: string } {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

async function fetchCopyRows(params: {
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
}): Promise<MetaCopiesResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    providerAccountId: params.providerAccountId,
    start: params.start,
    end: params.end,
    groupBy: "copy",
    format: "all",
    sort: "spend",
  });
  const response = await fetch(`/api/meta/copies?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      hasMessage(payload)
        ? payload.message
        : `Could not load copies (${response.status}).`,
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as MetaCopiesResponse).rows)
  ) {
    throw new Error("Invalid copies response received from backend.");
  }
  return payload as MetaCopiesResponse;
}

function toCsvCell(value: string | number | null | undefined): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function exportCopiesCsv(rows: CopyMotionRow[], defaultCurrency: string | null) {
  if (typeof document === "undefined" || rows.length === 0) return;
  const header = [
    "Copy",
    "Campaign",
    "Ad Set",
    "Spend",
    "Purchase Value",
    "ROAS",
    "CPA",
    "Link CTR %",
    "Click to Purchase %",
  ];
  const body = rows.map((row) => [
    row.copyText,
    row.campaignName ?? "",
    row.adSetName ?? "",
    formatMoney(row.spend, row.currency, defaultCurrency),
    formatMoney(row.purchaseValue, row.currency, defaultCurrency),
    Number.isFinite(row.roas) ? `${row.roas.toFixed(2)}x` : "",
    formatMoney(row.cpa, row.currency, defaultCurrency),
    Number.isFinite(row.linkCtr) ? row.linkCtr.toFixed(2) : "",
    Number.isFinite(row.clickToPurchase) ? row.clickToPurchase.toFixed(2) : "",
  ]);
  const csv = [header, ...body]
    .map((line) => line.map(toCsvCell).join(","))
    .join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `copies-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function launchpadHref(input: {
  pathname: string | null;
  businessId: string;
  providerAccountId: string;
}) {
  if (input.pathname?.startsWith("/c/")) {
    const query = input.providerAccountId
      ? `?providerAccountId=${encodeURIComponent(input.providerAccountId)}`
      : "";
    return `/c/${encodeURIComponent(input.businessId)}/meta/launchpad${query}`;
  }
  if (input.pathname?.startsWith("/app/")) {
    const query = input.providerAccountId
      ? `?providerAccountId=${encodeURIComponent(input.providerAccountId)}`
      : "";
    return `/app/meta/launchpad${query}`;
  }
  return buildMetaScopedHref("/platforms/meta/launchpad", {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
}

export default function CopiesPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
}: CopiesPageProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const hasAuthorizedBusinessScope = authorizedBusinessId !== undefined;
  const hasAuthorizedProviderScope = authorizedProviderAccountId !== undefined;
  const businessId = hasAuthorizedBusinessScope
    ? authorizedBusinessId?.trim() ?? ""
    : storeBusinessId ?? "";
  const requestedProviderAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : searchParams?.get("providerAccountId")?.trim() ?? "";
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );
  const [dashboardDateRange] = usePersistentDateRange();
  const { start, end } = resolveCreativeDateRange(
    standardDateRangeToCreative(dashboardDateRange),
  );
  const [detailRowId, setDetailRowId] = useState<string | null>(null);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId) && !hasAuthorizedProviderScope,
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const discoveredProviderAccountId =
    (selectedProviderAccountId &&
    providerAccounts.some((account) => account.id === selectedProviderAccountId)
      ? selectedProviderAccountId
      : "") ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const providerAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : discoveredProviderAccountId;

  useEffect(() => {
    if (hasAuthorizedProviderScope) return;
    setSelectedProviderAccountId((current) => {
      if (current && providerAccounts.some((account) => account.id === current)) {
        return current;
      }
      if (
        requestedProviderAccountId &&
        providerAccounts.some((account) => account.id === requestedProviderAccountId)
      ) {
        return requestedProviderAccountId;
      }
      return "";
    });
  }, [
    businessId,
    hasAuthorizedProviderScope,
    providerAccounts,
    requestedProviderAccountId,
  ]);

  const hasExplicitAccountScope = Boolean(businessId && providerAccountId);
  const copiesQuery = useQuery({
    queryKey: [
      "copies-creatives",
      businessId,
      providerAccountId,
      start,
      end,
      "copy",
    ],
    enabled: hasExplicitAccountScope,
    queryFn: () =>
      fetchCopyRows({
        businessId,
        providerAccountId,
        start,
        end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isLoading) ||
      copiesQuery.isLoading,
    isFetching:
      (!hasAuthorizedProviderScope && providerAccountsQuery.isFetching) ||
      copiesQuery.isFetching,
    error: copiesQuery.error ?? providerAccountsQuery.error,
    asOf: measuredAsOf(copiesQuery.data?.meta?.warehouseObservedAt ?? null),
    businessId: businessId || null,
    onRetry: () => {
      if (!hasAuthorizedProviderScope && providerAccountsQuery.isError) {
        void providerAccountsQuery.refetch();
      }
      if (hasExplicitAccountScope) void copiesQuery.refetch();
    },
  });

  const rows = useMemo(
    () =>
      (copiesQuery.data?.rows ?? [])
        .map(mapApiRowToCopyRow)
        .filter((row) => row.accountId === providerAccountId),
    [copiesQuery.data?.rows, providerAccountId],
  );
  const accountCurrency =
    providerAccounts.find((account) => account.id === providerAccountId)?.currency ??
    rows.find((row) => row.currency)?.currency ??
    null;
  const scopeLoading =
    !hasAuthorizedProviderScope && providerAccountsQuery.isLoading;
  const scopeError =
    !hasAuthorizedProviderScope && providerAccountsQuery.isError;
  const state = scopeLoading
    ? "loading"
    : scopeError
      ? "error"
      : !providerAccountId
        ? "account_required"
        : copiesQuery.isLoading
          ? "loading"
          : copiesQuery.isError
            ? "error"
            : rows.length > 0
              ? "ready"
              : "empty";
  const message = scopeLoading
    ? "Loading assigned Meta account scope."
    : scopeError
      ? errorMessage(
          providerAccountsQuery.error,
          "Assigned Meta accounts could not load.",
        )
      : !providerAccountId
        ? "Select one assigned Meta account to load copy performance."
        : copiesQuery.isLoading
          ? "Loading copy performance."
          : copiesQuery.isError
            ? errorMessage(copiesQuery.error, "Copy performance is unavailable.")
            : rows.length === 0
              ? "No copy performance is available for this account and date range."
              : null;
  const model = useMemo(() => {
    const base = buildCreativeStudioCopiesModel({
      rows,
      state,
      message,
      onOpenRow: setDetailRowId,
    });
    const angles = [...base.angles];
    while (angles.length < 4) {
      const slot = angles.length + 1;
      angles.push({
        id: `unavailable-${slot}`,
        name: "—",
        tone: "neutral",
        lines: null,
        spendShare: null,
        roas: null,
        ctr: null,
        bestLine: null,
        usage: null,
      });
    }
    return { ...base, angles: angles.slice(0, 4) };
  }, [message, rows, state]);
  const activeDetailRow = useMemo(
    () => rows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, rows],
  );
  const closeDetailDrawer = useCallback(() => setDetailRowId(null), []);
  const tabHrefs = buildCreativeStudioTabHrefs({
    pathname,
    businessId,
    providerAccountId,
    start,
    end,
  });

  if (!businessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
      <div
        data-copies-fetch-status={copiesQuery.fetchStatus}
        data-copies-query-status={copiesQuery.status}
        data-testid="copies-studio-page"
      >
        <CreativeStudioExact
          activeTab="copies"
          copies={model}
          counts={{ copies: state === "ready" || state === "empty" ? rows.length : null }}
          onExport={rows.length > 0 ? () => exportCopiesCsv(rows, accountCurrency) : undefined}
          tabHrefs={tabHrefs}
        />
        {activeDetailRow ? (
          <CopyDetailDrawer
            defaultCurrency={accountCurrency}
            launchpadHref={launchpadHref({
              pathname,
              businessId,
              providerAccountId,
            })}
            onClose={closeDetailDrawer}
            row={activeDetailRow}
          />
        ) : null}
      </div>
    </PlanGate>
  );
}

function CopyDetailDrawer({
  row,
  defaultCurrency,
  launchpadHref: guardedLaunchpadHref,
  onClose,
}: {
  row: CopyMotionRow;
  defaultCurrency: string | null;
  launchpadHref: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const alternatives = (row.copyVariants ?? []).filter(
    (variant) =>
      variant.trim().length > 0 &&
      variant.trim() !== (row.copyText ?? "").trim(),
  );
  const money = (value: number) =>
    formatMoney(value, row.currency, defaultCurrency);
  const kind = row.copyAssetType?.trim() || "—";

  return (
    <div aria-modal="true" className="fixed inset-0 z-50" role="dialog">
      <button
        aria-label="Close drawer overlay"
        className="absolute inset-0"
        onClick={onClose}
        style={{ background: "rgba(11,16,32,0.46)" }}
        type="button"
      />
      <aside
        aria-labelledby="copy-detail-title"
        className="absolute right-0 top-0 flex h-full w-[min(520px,100vw)] flex-col overflow-y-auto bg-[var(--adv-canvas)] shadow-2xl"
        data-testid="copy-detail-drawer"
      >
        <header className="flex items-start gap-3 bg-[var(--adv-rail)] px-5 py-4 text-white">
          <div className="min-w-0 flex-1">
            <p className="m-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--adv-rail-ink-2)]">
              Copy detail · {kind}
            </p>
            <h2 className="mt-1 text-[15px] font-semibold" id="copy-detail-title">
              “{row.copyText || "—"}”
            </h2>
          </div>
          <button
            aria-label="Close drawer"
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/20"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="grid gap-4 p-5 text-[12px] text-[var(--adv-ink)]">
          <section className="rounded-xl border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4">
            <p className="whitespace-pre-wrap text-[14px] font-semibold">
              “{row.copyText || "—"}”
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <CopyStat label="Spend" value={money(row.spend)} />
              <CopyStat
                label="ROAS"
                value={Number.isFinite(row.roas) ? row.roas.toFixed(2) : "—"}
              />
              <CopyStat
                label="CTR"
                value={Number.isFinite(row.linkCtr) ? `${row.linkCtr.toFixed(2)}%` : "—"}
              />
              <CopyStat
                label="CVR"
                value={
                  Number.isFinite(row.clickToPurchase)
                    ? `${row.clickToPurchase.toFixed(2)}%`
                    : "—"
                }
              />
            </dl>
          </section>

          <section className="rounded-xl border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4">
            <h3 className="text-[13px] font-semibold">Served alternatives</h3>
            {alternatives.length === 0 ? (
              <p className="mt-2 text-[var(--adv-ink-4)]">
                Meta supplied no additional served line for this creative.
              </p>
            ) : (
              <div className="mt-3 grid gap-2">
                {alternatives.map((variant, index) => (
                  <div
                    className="rounded-lg border border-[var(--adv-hairline)] p-3"
                    key={`${variant}:${index}`}
                  >
                    <p className="whitespace-pre-wrap font-medium">“{variant}”</p>
                    <Link
                      className="mt-2 inline-flex text-[11px] font-semibold text-[var(--adv-accent)]"
                      href={guardedLaunchpadHref}
                    >
                      Open in Launchpad →
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

function CopyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--adv-fill)] p-2">
      <dt className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-[var(--adv-ink-4)]">
        {label}
      </dt>
      <dd className="mt-1 tabular-nums font-semibold">{value}</dd>
    </div>
  );
}
