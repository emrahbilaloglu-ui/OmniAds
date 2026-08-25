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
import Link from "next/link";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  buildPerformanceViewModel,
  type ServedCreativeRow,
} from "@/lib/zero-base/creative/performance-adapter";
import { resolveEnginePosture, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";
import type { MetaDecisionsOsWorkspacePayload } from "@/components/meta/redesign/types";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import { CreativeDetailClient } from "@/components/zero-base/creative/detail-client";
import { decisionsHrefForCreative } from "@/lib/zero-base/creative/performance-adapter";

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
  const copy = useCopy();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<ServedCreativeRow[] | null>(null);
  const [totalAvailable, setTotal] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [posture, setPosture] = useState<EnginePosture>("unavailable");
  const [canonicalDecisions, setCanonicalDecisions] = useState<MetaCanonicalDecision[]>([]);
  const [servedOsDecisions, setServedOsDecisions] = useState<MetaOsAdDecision[]>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading creatives" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const query = new URLSearchParams({ businessId, start, end });
      if (providerAccountId) query.set("providerAccountId", providerAccountId);

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
        const creativeRows = json.rows ?? [];
        const creativeIds = [
          ...new Set(
            creativeRows
              .map((row) => row.creative_id?.trim())
              .filter((value): value is string => Boolean(value)),
          ),
        ];
        let postureResult: {
          status?: string;
          flags?: { enabled: boolean; surfaceVisible: boolean; shadowOnly: boolean };
          inventory?: { items?: MetaCanonicalDecision[] };
        } | null = null;
        let workspaceResult: MetaDecisionsOsWorkspacePayload | null = null;

        if (providerAccountId && creativeIds.length > 0) {
          const decisionQuery = new URLSearchParams({
            businessId,
            providerAccountId,
            creativeIds: creativeIds.join(","),
          });
          postureResult = await fetch(
            `/api/creatives/decision-engine-v3?${decisionQuery.toString()}`,
            { cache: "no-store" },
          )
            .then(async (decisionResponse) =>
              decisionResponse.ok
                ? ((await decisionResponse.json()) as {
                    status?: string;
                    flags?: {
                      enabled: boolean;
                      surfaceVisible: boolean;
                      shadowOnly: boolean;
                    };
                    inventory?: { items?: MetaCanonicalDecision[] };
                  })
                : null,
            )
            .catch(() => null);

          // The compact OS projection is a review-only resilience path, not a
          // second request every time the native generation is healthy.
          if (postureResult === null) {
            const workspaceQuery = new URLSearchParams({
              businessId,
              providerAccountId,
              surface: "os",
              status_filter: "active",
            });
            workspaceResult = await fetch(
              `/api/meta/decisions-workspace?${workspaceQuery.toString()}`,
              { cache: "no-store" },
            )
              .then(async (workspaceResponse) =>
                workspaceResponse.ok
                  ? ((await workspaceResponse.json()) as MetaDecisionsOsWorkspacePayload)
                  : null,
              )
              .catch(() => null);
          }
        }
        if (cancelled) return;
        const nativeItems = postureResult?.inventory?.items ?? [];
        const osItems = workspaceResult?.os?.ads?.items ?? [];
        const nativePosture = resolveEnginePosture({
          status:
            postureResult === null
              ? "unavailable"
              : postureResult.status === "disabled"
                ? "disabled"
                : "serving",
          flags: postureResult?.flags ?? null,
        });
        setPosture(
          nativePosture === "unavailable" && osItems.length > 0
            ? "shadow_only"
            : nativePosture,
        );
        setCanonicalDecisions(nativeItems);
        setServedOsDecisions(
          postureResult?.status === "disabled" ? [] : osItems,
        );
        setRows(creativeRows);
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
            servedOsDecisions,
          })
        : null,
    [rows, totalAvailable, posture, currency, canonicalDecisions, servedOsDecisions],
  );
  const selectedCreativeId = searchParams.get("creativeId");
  const selectedRow = model?.rows.find((row) => row.creativeId === selectedCreativeId) ?? null;

  function setSelectedCreative(creativeId: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (creativeId) next.set("creativeId", creativeId);
    else next.delete("creativeId");
    router.replace(`/app/creative/performance${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  return (
    <>
      <SurfaceStateBoundary state={surface}>
        {model ? (
          <CreativePerformanceView
            model={model}
            businessId={businessId}
            onOpenCreative={(creativeId) => setSelectedCreative(creativeId)}
          />
        ) : null}
      </SurfaceStateBoundary>
      <ZeroBaseSheet
        open={selectedRow !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCreative(null);
        }}
        title={selectedRow?.name ?? "Creative detail"}
        closeCtl="live:close"
      >
        {selectedRow ? (
          <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
            {selectedRow.decision ? (
              <section aria-label={copy.canonicalAdDecisions} style={{ display: "grid", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 14 }}>{copy.canonicalAdDecisions}</h2>
                {selectedRow.decision.items.map((item) => (
                  <div key={item.adId} style={{ padding: 10, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)" }}>
                    <strong style={{ display: "block", fontSize: 13 }}>{item.buyerLabel}</strong>
                    <span style={{ display: "block", marginTop: 3, fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
                      Ad {item.adId} · {item.decisionState}
                    </span>
                    <Link
                      href={decisionsHrefForCreative({
                        businessId,
                        row: {
                          creativeId: selectedRow.creativeId,
                          adId: item.adId,
                          accountId: selectedRow.accountId,
                        },
                      })}
                      style={{ display: "inline-block", marginTop: 6, fontSize: 12, color: "var(--ledger-accent-action)" }}
                    >
                      {copy.openThisAdInDecisions}
                    </Link>
                  </div>
                ))}
              </section>
            ) : null}
            <CreativeDetailClient
              businessId={businessId}
              creativeId={selectedRow.creativeId}
              providerAccountId={selectedRow.accountId}
              start={start}
              end={end}
            />
          </div>
        ) : null}
      </ZeroBaseSheet>
    </>
  );
}
