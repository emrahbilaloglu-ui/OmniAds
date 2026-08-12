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
  type GoogleScope,
  type GoogleSourceState,
  type ReferenceCard,
} from "@/lib/zero-base/google/google-contract";
import {
  adaptCollection,
  adaptOverview,
  adaptRecommendations,
  adaptScopeAccounts,
  sourceStateFromMeta,
} from "@/lib/zero-base/google/payload-adapters";
import type { SurfaceState } from "@/lib/zero-base/state-types";

interface Props {
  businessId: string;
}

/**
 * Account scope from the server-owned reader.
 *
 * The Google report endpoints serve report bodies, not account identity, so
 * scope comes from its own authorized route rather than being invented here.
 */
function useGoogleScope(businessId: string): GoogleScope {
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/zero-base/google/scope?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          if (!cancelled) setFailed(`Account scope could not be read (HTTP ${response.status}).`);
          return;
        }
        const adapted = adaptScopeAccounts(await response.json());
        if (cancelled) return;
        if (adapted.ok) setAccounts(adapted.value);
        else setFailed(adapted.reason);
      } catch (error) {
        if (!cancelled) {
          setFailed(error instanceof Error ? error.message : "Account scope could not be reached.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (failed) return { kind: "none", reason: failed };
  if (!accounts) return { kind: "none", reason: "Reading account scope…" };
  return resolveGoogleScope(accounts);
}

/**
 * Fetch one Google report and adapt it.
 *
 * A 200 whose body lacks the required shape is `malformed` — reported as
 * unavailable with the reason, never as a serving read of an empty surface.
 */
function useGoogleReport<T>(
  path: string,
  businessId: string,
  label: string,
  adapt: (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string },
) {
  const [value, setValue] = useState<T | null>(null);
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
        const adapted = adapt(await response.json());
        if (cancelled) return;
        if (!adapted.ok) {
          // The shape is wrong. Saying "serving" here is what made the first
          // version render an empty surface while claiming it was fine.
          setSource({ kind: "unavailable", reason: adapted.reason });
          setSurface({ kind: "ready" });
          return;
        }
        setValue(adapted.value);
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
  }, [path, businessId, label, adapt]);

  return { value, source, setSource, surface };
}

export function GoogleOverviewClient({ businessId }: Props) {
  const scope = useGoogleScope(businessId);
  const { value, source, setSource, surface } = useGoogleReport(
    "/api/google-ads/overview",
    businessId,
    "Google overview",
    adaptOverview,
  );

  useEffect(() => {
    if (value) setSource(sourceStateFromMeta(value.meta));
  }, [value, setSource]);

  return (
    <SurfaceStateBoundary state={surface}>
      <GoogleOverviewView
        scope={scope}
        source={source}
        kpis={value?.kpis ?? []}
        rows={(value?.campaigns ?? []).map((row) => ({
          id: row.id,
          account: row.name,
          spend: googleValue(row.cost, (v) => v.toFixed(2)),
          conversions: googleValue(row.conversions, (v) => String(Math.trunc(v))),
          pulse:
            value?.kpis.find((kpi) => kpi.key.toLowerCase().includes("conversion"))?.delta === null
              ? "Not served"
              : "Served",
        }))}
        unavailableReason={source.kind === "unavailable" ? source.reason : null}
      />
    </SurfaceStateBoundary>
  );
}

export function GoogleAdvisorClient({ businessId }: Props) {
  const scope = useGoogleScope(businessId);
  const { value, source, surface } = useGoogleReport(
    "/api/google-ads/advisor",
    businessId,
    "Google advisor",
    adaptRecommendations,
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <GoogleAdvisorView
        scope={scope}
        source={source}
        // Real doBucket, not a re-derived urgency word.
        items={(value ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          rationale: item.summary ?? item.why,
          urgency: item.doBucket === "do_next" ? "next" : item.doBucket === "do_now" ? "do_now" : "later",
        }))}
        referenceCards={[] as ReferenceCard[]}
      />
    </SurfaceStateBoundary>
  );
}

function collection(path: string, title: string, rowKeys: string[], columns: { id: string; header: string; numeric?: boolean }[]) {
  const adapt = (raw: unknown) => adaptCollection(raw, rowKeys);
  return function GoogleCollectionClient({ businessId }: Props) {
    const scope = useGoogleScope(businessId);
    const { value, source, setSource, surface } = useGoogleReport(path, businessId, title, adapt);

    useEffect(() => {
      if (value) setSource(sourceStateFromMeta(value.meta));
    }, [value, setSource]);

    const rows = (value?.rows ?? []).map((row) => ({
      id: String(row.id),
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
            typeof value?.rowCap === "number"
              ? `Up to ${value.rowCap} rows.`
              : "The backend did not supply a row cap."
          }
          unavailableReason={source.kind === "unavailable" ? source.reason : null}
        />
      </SurfaceStateBoundary>
    );
  };
}

export const GoogleSearchClient = collection(
  "/api/google-ads/search-intelligence",
  "Google search",
  ["rows", "searchTerms", "terms", "clusters"],
  [
    { id: "term", header: "Term" },
    { id: "clicks", header: "Clicks", numeric: true },
    { id: "cost", header: "Cost", numeric: true },
  ],
);

export const GoogleProductsClient = collection(
  "/api/google-ads/products",
  "Google products",
  ["rows", "products"],
  [
    { id: "title", header: "Product" },
    { id: "clicks", header: "Clicks", numeric: true },
    { id: "conversions", header: "Conversions", numeric: true },
  ],
);

export const GoogleAssetsClient = collection(
  "/api/google-ads/assets",
  "Google assets and audiences",
  ["rows", "assets", "assetGroups"],
  [
    { id: "name", header: "Asset" },
    { id: "type", header: "Type" },
    { id: "impressions", header: "Impressions", numeric: true },
  ],
);
