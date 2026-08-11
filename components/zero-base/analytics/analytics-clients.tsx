"use client";

/**
 * Data boundaries for the four analytics leaves.
 *
 * Each reads its existing endpoint and adapts the real payload. A 200 whose
 * body lacks the required shape is refused with its reason rather than rendered
 * as a serving, empty surface.
 *
 * None of these constructs a call to the AI generate endpoint. That absence is
 * asserted by a scan over these shipped files.
 */
import { useEffect, useState } from "react";

import {
  AnalyticsTableView,
  GeoView,
  SeoView,
  SourceOverviewView,
} from "@/components/zero-base/analytics/analytics-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  adaptGeoOverview,
  adaptLatestInsight,
  adaptSources,
  adaptTable,
  analyticsValue,
  seoRoleState,
  type AdaptedGeo,
  type AdaptedInsight,
  type SourcePanel,
} from "@/lib/zero-base/analytics/analytics-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

interface Props {
  businessId: string;
  role?: string | null;
}

function useEndpoint<T>(path: string, businessId: string, label: string, adapt: (raw: unknown) => T | null) {
  const [value, setValue] = useState<T | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${path}?businessId=${encodeURIComponent(businessId)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setReason(`${label} could not be read (HTTP ${response.status}).`);
            setSurface({ kind: "ready" });
          }
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setRaw(body);
        const adapted = adapt(body);
        if (adapted === null) {
          // A 200 with the wrong shape is degraded, never serving.
          setReason(`${label} returned a response this surface could not read.`);
        } else {
          setValue(adapted);
        }
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setReason(error instanceof Error ? error.message : `${label} could not be reached.`);
        setSurface({ kind: "ready" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, businessId, label, adapt]);

  return { value, raw, reason, surface };
}

function useInsight(businessId: string): AdaptedInsight {
  const [insight, setInsight] = useState<AdaptedInsight>({
    text: null,
    generatedAt: null,
    absentReason: "No AI insight has been generated for this business yet.",
  });
  useEffect(() => {
    let cancelled = false;
    // READ only. There is no generate call anywhere in this module.
    fetch(`/api/ai/insights/latest?businessId=${encodeURIComponent(businessId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setInsight(adaptLatestInsight(body));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  return insight;
}

export function AnalyticsSourceClient({ businessId }: Props) {
  const { raw, reason, surface } = useEndpoint(
    "/api/analytics/overview",
    businessId,
    "Analytics overview",
    (body) => (adaptTable(body, ["rows", "sources", "channels"]).ok ? body : null),
  );
  const insight = useInsight(businessId);
  const table = adaptTable(raw, ["rows", "sources", "channels"]);
  const panels: SourcePanel[] = adaptSources(raw);

  return (
    <SurfaceStateBoundary state={surface}>
      <SourceOverviewView
        panels={panels}
        rows={
          table.ok
            ? table.value.rows.map((row, index) => ({
                id: String((row as { id?: unknown }).id ?? index),
                label: String((row as { label?: unknown; source?: unknown }).label ?? (row as { source?: unknown }).source ?? "(not served)"),
                sessions: analyticsValue((row as { sessions?: unknown }).sessions, (v) => String(Math.trunc(v))),
                revenue: analyticsValue((row as { revenue?: unknown }).revenue, (v) => v.toFixed(2)),
              }))
            : []
        }
        capText={table.ok ? table.value.capText : ""}
        insight={insight}
        unavailableReason={reason}
      />
    </SurfaceStateBoundary>
  );
}

function tableClient(path: string, title: string, rowKeys: string[], columns: { id: string; header: string; numeric?: boolean }[]) {
  return function AnalyticsTableClient({ businessId }: Props) {
    const { raw, reason, surface } = useEndpoint(path, businessId, title, (body) =>
      adaptTable(body, rowKeys).ok ? body : null,
    );
    const table = adaptTable(raw, rowKeys);
    return (
      <SurfaceStateBoundary state={surface}>
        <AnalyticsTableView
          title={title}
          panels={adaptSources(raw)}
          rows={
            table.ok
              ? table.value.rows.map((row, index) => ({
                  id: String((row as { id?: unknown }).id ?? index),
                  cells: Object.fromEntries(
                    columns.map((column) => {
                      const cell = (row as Record<string, unknown>)[column.id];
                      return [
                        column.id,
                        column.numeric
                          ? analyticsValue(cell, (v) => v.toFixed(2))
                          : typeof cell === "string" && cell.trim()
                            ? cell
                            : "Not served",
                      ];
                    }),
                  ),
                }))
              : []
          }
          columns={columns}
          capText={table.ok ? table.value.capText : ""}
          unavailableReason={reason}
        />
      </SurfaceStateBoundary>
    );
  };
}

export const AnalyticsLandingPagesClient = tableClient(
  "/api/analytics/landing-pages",
  "Landing pages",
  ["pages", "rows"],
  [
    { id: "path", header: "Page" },
    { id: "sessions", header: "Sessions", numeric: true },
    { id: "conversions", header: "Conversions", numeric: true },
  ],
);

export function SeoClient({ businessId, role }: Props) {
  const { raw, reason, surface } = useEndpoint("/api/seo/overview", businessId, "SEO", (body) =>
    adaptTable(body, ["findings", "rows", "pages"]).ok ? body : null,
  );
  const table = adaptTable(raw, ["findings", "rows", "pages"]);
  return (
    <SurfaceStateBoundary state={surface}>
      <SeoView
        panels={adaptSources(raw)}
        role={seoRoleState(role ?? null)}
        findings={
          table.ok
            ? table.value.rows.map((row, index) => ({
                id: String((row as { id?: unknown }).id ?? index),
                title: String((row as { title?: unknown }).title ?? "(finding not named)"),
                detail: typeof (row as { detail?: unknown }).detail === "string" ? String((row as { detail?: unknown }).detail) : null,
              }))
            : []
        }
        unavailableReason={reason}
      />
    </SurfaceStateBoundary>
  );
}

export function GeoClient({ businessId }: Props) {
  const [geo, setGeo] = useState<AdaptedGeo | null>(null);
  const { raw, reason, surface } = useEndpoint("/api/geo/overview", businessId, "GEO", (body) =>
    adaptGeoOverview(body).ok ? body : null,
  );
  useEffect(() => {
    const adapted = adaptGeoOverview(raw);
    if (adapted.ok) setGeo(adapted.value);
  }, [raw]);
  return (
    <SurfaceStateBoundary state={surface}>
      <GeoView geo={geo} unavailableReason={reason} />
    </SurfaceStateBoundary>
  );
}
