"use client";

/**
 * Data boundaries for the five Google read leaves.
 *
 * Each reads its existing Google endpoint. Nothing here fabricates a value: a
 * field the API did not send becomes an explicit absence, and a portfolio whose
 * accounts disagree is never summed.
 */
import { useEffect, useMemo, useState } from "react";

import {
  GoogleAdvisorView,
  GoogleCollectionView,
  GoogleOverviewView,
} from "@/components/zero-base/google/google-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  googleValue,
  resolveGoogleScope,
  type GoogleAccount,
  type GoogleSourceState,
  type ReferenceCard,
  type ServedAdvisorItem,
} from "@/lib/zero-base/google/google-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

interface Props {
  businessId: string;
}

function useGoogle<T>(path: string, businessId: string, label: string) {
  const [data, setData] = useState<T | null>(null);
  const [source, setSource] = useState<GoogleSourceState>({
    kind: "unavailable",
    reason: `${label} has not been read yet.`,
  });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${path}?businessId=${encodeURIComponent(businessId)}`, {
          cache: "no-store",
        });
        if (response.status === 429) {
          // Rate limiting is its own state: the data exists, we were throttled.
          const retry = Number(response.headers.get("retry-after"));
          if (!cancelled) {
            setSource({
              kind: "rate_limited",
              reason: "Google throttled this read.",
              retryAfterSeconds: Number.isFinite(retry) ? retry : null,
            });
            setSurface({ kind: "ready" });
          }
          return;
        }
        if (!response.ok) {
          if (!cancelled) {
            setSource({ kind: "unavailable", reason: `${label} could not be read (HTTP ${response.status}).` });
            setSurface({ kind: "ready" });
          }
          return;
        }
        const json = (await response.json()) as T & {
          partial?: boolean;
          partialReason?: string | null;
          observedAt?: string | null;
        };
        if (cancelled) return;
        setData(json);
        setSource(
          json.partial
            ? {
                kind: "partial",
                reason: json.partialReason ?? `${label} returned an incomplete window.`,
                observedAt: json.observedAt ?? null,
              }
            : { kind: "serving", observedAt: json.observedAt ?? null },
        );
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSource({
          kind: "unavailable",
          reason: error instanceof Error ? error.message : `${label} could not be reached.`,
        });
        setSurface({ kind: "ready" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, businessId, label]);

  return { data, source, surface };
}

function accountsOf(data: { accounts?: GoogleAccount[] } | null): GoogleAccount[] {
  return data?.accounts ?? [];
}

export function GoogleOverviewClient({ businessId }: Props) {
  const { data, source, surface } = useGoogle<{
    accounts?: GoogleAccount[];
    rows?: Array<{ accountId: string; accountName?: string; spend?: number; conversions?: number; pulse?: string }>;
  }>("/api/google-ads/overview", businessId, "Google overview");

  const scope = useMemo(() => resolveGoogleScope(accountsOf(data)), [data]);

  return (
    <SurfaceStateBoundary state={surface}>
      <GoogleOverviewView
        scope={scope}
        source={source}
        rows={(data?.rows ?? []).map((row) => ({
          id: row.accountId,
          account: row.accountName ?? row.accountId,
          spend: googleValue(row.spend, (v) => v.toFixed(2)),
          conversions: googleValue(row.conversions, (v) => String(Math.trunc(v))),
          pulse: row.pulse ?? "Not served",
        }))}
      />
    </SurfaceStateBoundary>
  );
}

export function GoogleAdvisorClient({ businessId }: Props) {
  const { data, source, surface } = useGoogle<{
    accounts?: GoogleAccount[];
    recommendations?: ServedAdvisorItem[];
    referenceCards?: ReferenceCard[];
  }>("/api/google-ads/advisor", businessId, "Google advisor");

  const scope = useMemo(() => resolveGoogleScope(accountsOf(data)), [data]);

  return (
    <SurfaceStateBoundary state={surface}>
      <GoogleAdvisorView
        scope={scope}
        source={source}
        items={data?.recommendations ?? []}
        referenceCards={data?.referenceCards ?? []}
      />
    </SurfaceStateBoundary>
  );
}

function collection(path: string, title: string, columns: { id: string; header: string; numeric?: boolean }[]) {
  return function GoogleCollectionClient({ businessId }: Props) {
    const { data, source, surface } = useGoogle<{
      accounts?: GoogleAccount[];
      rows?: Array<Record<string, unknown>>;
      rowCap?: number | null;
    }>(path, businessId, title);

    const scope = useMemo(() => resolveGoogleScope(accountsOf(data)), [data]);
    const rows = (data?.rows ?? []).map((row, index) => ({
      id: String(row.id ?? index),
      cells: Object.fromEntries(
        columns.map((column) => {
          const raw = row[column.id];
          return [
            column.id,
            column.numeric
              ? googleValue(typeof raw === "number" ? raw : null, (v) => v.toFixed(2))
              : typeof raw === "string" && raw.trim()
                ? raw
                : "Not served",
          ];
        }),
      ),
    }));

    return (
      <SurfaceStateBoundary state={surface}>
        <GoogleCollectionView
          title={title}
          scope={scope}
          source={source}
          rows={rows}
          columns={columns}
          capText={
            typeof data?.rowCap === "number"
              ? `Up to ${data.rowCap} rows.`
              : "The backend did not supply a row cap."
          }
        />
      </SurfaceStateBoundary>
    );
  };
}

export const GoogleSearchClient = collection("/api/google-ads/search-intelligence", "Google search", [
  { id: "term", header: "Term" },
  { id: "clicks", header: "Clicks", numeric: true },
  { id: "cost", header: "Cost", numeric: true },
]);

export const GoogleProductsClient = collection("/api/google-ads/products", "Google products", [
  { id: "title", header: "Product" },
  { id: "clicks", header: "Clicks", numeric: true },
  { id: "conversions", header: "Conversions", numeric: true },
]);

export const GoogleAssetsClient = collection("/api/google-ads/assets", "Google assets and audiences", [
  { id: "name", header: "Asset" },
  { id: "type", header: "Type" },
  { id: "impressions", header: "Impressions", numeric: true },
]);
