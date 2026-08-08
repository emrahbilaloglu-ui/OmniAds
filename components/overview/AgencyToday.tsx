"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { MISSING_VALUE, formatMoneyIso } from "@/lib/metric-format";
import type {
  AgencyTodayReadModel,
  AgencyTodayRow,
  ClientSeverity,
} from "@/lib/agency-today-read-model";

interface AgencyTodayResponse {
  startDate: string;
  endDate: string;
  model: AgencyTodayReadModel;
}

async function fetchAgencyToday(): Promise<AgencyTodayResponse> {
  const response = await fetch("/api/agency-today", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ?? "Could not load Agency Today.",
    );
  }
  return payload as AgencyTodayResponse;
}

const SEVERITY_STYLE: Record<ClientSeverity, { label: string; className: string }> = {
  critical: { label: "Needs you first", className: "bg-rose-50 text-rose-700 border-rose-200" },
  attention: { label: "Check", className: "bg-amber-50 text-amber-800 border-amber-200" },
  steady: { label: "Steady", className: "bg-neutral-100 text-neutral-600 border-neutral-200" },
  unknown: { label: "Can't rank", className: "bg-neutral-100 text-neutral-600 border-neutral-200" },
};

function formatRoas(roas: number | null) {
  return roas == null ? MISSING_VALUE : `${roas.toFixed(2)}x`;
}

function ClientRow({ row }: { row: AgencyTodayRow }) {
  const severity = SEVERITY_STYLE[row.severity];
  return (
    <Link
      href={row.href}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-200 px-4 py-3 last:border-b-0 hover:bg-neutral-50"
    >
      <span className="min-w-[9rem] flex-1 text-[13px] font-medium text-neutral-900">
        {row.businessName}
      </span>

      <span
        className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${severity.className}`}
      >
        {severity.label}
      </span>

      <span className="min-w-[7rem] text-right text-[13px] tabular-nums text-neutral-900">
        {formatMoneyIso(row.spend, { currency: row.currency })}
      </span>
      <span className="min-w-[4.5rem] text-right text-[13px] tabular-nums text-neutral-700">
        {formatRoas(row.roas)}
      </span>

      <span className="min-w-[10rem] text-[11px] text-neutral-500">
        {row.severityReasons.length > 0
          ? row.severityReasons.join(" · ")
          : row.freshness === "unknown"
            ? "Sync age unknown"
            : "No open issues"}
      </span>
    </Link>
  );
}

/**
 * The cross-client morning surface.
 *
 * Ordering and severity come from the server read model; this component renders
 * the ranking it is given rather than deciding priority from the numbers. A
 * portfolio total appears only when the server confirmed every client shares
 * one currency, because there is no FX contract to blend them honestly.
 */
export function AgencyToday({ businessCount }: { businessCount: number }) {
  const query = useQuery({
    queryKey: ["agency-today"],
    queryFn: fetchAgencyToday,
  });

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="h-4 w-40 animate-pulse rounded bg-neutral-100" />
        <div className="mt-3 space-y-2">
          {Array.from({ length: Math.min(businessCount || 3, 6) }).map((_, index) => (
            <div key={index} className="h-9 animate-pulse rounded bg-neutral-100" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
        <p className="text-[13px] font-medium text-rose-800">Agency Today is unavailable</p>
        <p className="mt-1 text-[12px] text-rose-700">
          {query.error instanceof Error ? query.error.message : "Could not load clients."}
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-3 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-[12px] font-medium text-rose-800 hover:bg-rose-50"
        >
          Try again
        </button>
      </div>
    );
  }

  const model = query.data?.model;
  const rows = model?.rows ?? [];

  return (
    <div className="rounded-xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
        <div>
          <p className="text-[13px] font-semibold text-neutral-900">Agency Today</p>
          <p className="text-[11px] text-neutral-500">
            {model
              ? `${model.needsAttentionCount} of ${model.clientCount} clients need you · ${query.data?.startDate} to ${query.data?.endDate}`
              : null}
          </p>
        </div>

        {model?.portfolio.available ? (
          <p className="text-[12px] tabular-nums text-neutral-700">
            Portfolio spend{" "}
            <span className="font-semibold text-neutral-900">
              {formatMoneyIso(model.portfolio.spend, { currency: model.portfolio.currency })}
            </span>
          </p>
        ) : (
          <p className="text-[11px] text-neutral-500">
            {model?.portfolio.withheldReason === "mixed_currency"
              ? "No portfolio total — clients use different currencies"
              : model?.portfolio.withheldReason === "unknown_currency"
                ? "No portfolio total — a client currency is unknown"
                : null}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-[12px] text-neutral-500">
          No active clients are assigned to this account yet.
        </p>
      ) : (
        <div>
          {rows.map((row) => (
            <ClientRow key={row.businessId} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
