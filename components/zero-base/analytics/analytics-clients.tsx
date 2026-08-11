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
  adaptAnalyticsOverview,
  adaptGeoOverview,
  adaptLandingPages,
  adaptLatestInsight,
  adaptSeoOverview,
  adaptSources,
  analyticsValue,
  seoRoleState,
  type AdaptedAnalyticsOverview,
  type AdaptedGeo,
  type AdaptedInsight,
  type AdaptedSeo,
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
    (body) => (adaptAnalyticsOverview(body).ok ? body : null),
  );
  const insight = useInsight(businessId);
  const adapted = adaptAnalyticsOverview(raw);
  const overview: AdaptedAnalyticsOverview | null = adapted.ok ? adapted.value : null;
  const panels: SourcePanel[] = adaptSources(raw);

  return (
    <SurfaceStateBoundary state={surface}>
      <SourceOverviewView
        panels={panels}
        overview={overview}
        insight={insight}
        unavailableReason={reason}
      />
    </SurfaceStateBoundary>
  );
}

export function AnalyticsLandingPagesClient({ businessId }: Props) {
  const { raw, reason, surface } = useEndpoint(
    "/api/analytics/landing-pages",
    businessId,
    "Landing pages",
    (body) => (adaptLandingPages(body).ok ? body : null),
  );
  const adapted = adaptLandingPages(raw);
  return (
    <SurfaceStateBoundary state={surface}>
      <AnalyticsTableView
        title="Landing pages"
        panels={adaptSources(raw)}
        rows={
          adapted.ok
            ? adapted.value.rows.map((row) => ({
                id: row.id,
                cells: {
                  path: row.path,
                  sessions: row.sessions,
                  // The handler serves purchases and purchaseCvr; there is no
                  // `conversions` field, and asking for one showed "Not served"
                  // on every row of a healthy read.
                  purchases: row.purchases,
                  purchaseCvr: row.purchaseCvr,
                },
              }))
            : []
        }
        columns={[
          { id: "path", header: "Page" },
          { id: "sessions", header: "Sessions", numeric: true },
          { id: "purchases", header: "Purchases", numeric: true },
          { id: "purchaseCvr", header: "Purchase CVR", numeric: true },
        ]}
        capText={adapted.ok ? adapted.value.capText : ""}
        unavailableReason={reason}
      />
    </SurfaceStateBoundary>
  );
}

export function SeoClient({ businessId, role }: Props) {
  const { raw, reason, surface } = useEndpoint("/api/seo/overview", businessId, "SEO", (body) =>
    adaptSeoOverview(body).ok ? body : null,
  );
  const adapted = adaptSeoOverview(raw);
  const seo: AdaptedSeo | null = adapted.ok ? adapted.value : null;
  return (
    <SurfaceStateBoundary state={surface}>
      <SeoView
        panels={adaptSources(raw)}
        role={seoRoleState(role ?? null)}
        seo={seo}
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
