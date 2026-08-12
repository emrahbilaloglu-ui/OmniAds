"use client";

/**
 * Creative performance data boundary.
 *
 * Reads two existing authorities and composes nothing of its own: the served
 * creative rows from `/api/meta/creatives`, and the engine's posture from
 * `/api/creatives/decision-engine-v3`. The posture read failing is not the same
 * as the engine being off, so a failure resolves to `unavailable` rather than
 * to a quiet `disabled`.
 */
import { useEffect, useMemo, useState } from "react";

import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  buildPerformanceViewModel,
  type ServedCreativeRow,
} from "@/lib/zero-base/creative/performance-adapter";
import { resolveEnginePosture, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export function CreativePerformanceClient({
  businessId,
  providerAccountId,
  start,
  end,
}: {
  businessId: string;
  providerAccountId: string | null;
  start: string;
  end: string;
}) {
  const [rows, setRows] = useState<ServedCreativeRow[] | null>(null);
  const [totalAvailable, setTotal] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [posture, setPosture] = useState<EnginePosture>("unavailable");
  const [canonicalDecisions, setCanonicalDecisions] = useState<MetaCanonicalDecision[]>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading creatives" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const query = new URLSearchParams({ businessId, start, end });
      if (providerAccountId) query.set("providerAccountId", providerAccountId);

      // Posture first and independently: it decides what the rows may offer,
      // and its failure must not be mistaken for the engine being off.
      const postureResult = await fetch(
        `/api/creatives/decision-engine-v3?${query.toString()}`,
        { cache: "no-store" },
      )
        .then(async (response) =>
          response.ok
              ? ((await response.json()) as {
                status?: string;
                flags?: { enabled: boolean; surfaceVisible: boolean; shadowOnly: boolean };
                inventory?: { items?: MetaCanonicalDecision[] };
              })
            : null,
        )
        .catch(() => null);

      if (!cancelled) {
        setPosture(
          resolveEnginePosture({
            status:
              postureResult === null
                ? "unavailable"
                : postureResult.status === "disabled"
                  ? "disabled"
                  : "serving",
            flags: postureResult?.flags ?? null,
          }),
        );
        setCanonicalDecisions(postureResult?.inventory?.items ?? []);
      }

      try {
        const response = await fetch(`/api/meta/creatives?${query.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          // A failed read is a failure, not an empty account.
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "Creative performance could not be read for this business.",
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as {
          rows?: ServedCreativeRow[];
          totalCreativeCount?: number | null;
          defaultCurrency?: string | null;
        };
        if (cancelled) return;
        setRows(json.rows ?? []);
        setTotal(typeof json.totalCreativeCount === "number" ? json.totalCreativeCount : null);
        setCurrency(json.defaultCurrency ?? null);
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "Creative performance could not be reached.",
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, providerAccountId, start, end]);

  const model = useMemo(
    () =>
      rows
        ? buildPerformanceViewModel({
            rows,
            totalAvailable,
            posture,
            defaultCurrency: currency,
            canonicalDecisions,
          })
        : null,
    [rows, totalAvailable, posture, currency, canonicalDecisions],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      {model ? <CreativePerformanceView model={model} businessId={businessId} /> : null}
    </SurfaceStateBoundary>
  );
}
