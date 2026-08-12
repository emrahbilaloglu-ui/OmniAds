"use client";

/**
 * Creative detail data boundary.
 *
 * The deep link names a creative and an account. The rows are read for THAT
 * account, and the resolver then checks the creative really belongs to it —
 * because a creative id alone is not proof of ownership, and rendering one from
 * another account inside this workspace is the failure this route exists to
 * prevent.
 */
import { useEffect, useMemo, useState } from "react";

import { CreativeDetailView } from "@/components/zero-base/creative/detail-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  buildEvidence,
  buildHistory,
  decisionBand,
  resolveDetail,
  type ServedHistoryEntry,
} from "@/lib/zero-base/creative/detail-adapter";
import {
  decisionsHrefForCreative,
  mediaStateFor,
  type ServedCreativeRow,
} from "@/lib/zero-base/creative/performance-adapter";
import { postureView, resolveEnginePosture, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export function CreativeDetailClient({
  businessId,
  creativeId,
  providerAccountId,
  start,
  end,
}: {
  businessId: string;
  creativeId: string;
  providerAccountId: string | null;
  start: string;
  end: string;
}) {
  const [rows, setRows] = useState<ServedCreativeRow[] | null>(null);
  const [history, setHistory] = useState<ServedHistoryEntry[]>([]);
  const [posture, setPosture] = useState<EnginePosture>("unavailable");
  const [servedLabel, setServedLabel] = useState<string | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading creative" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const query = new URLSearchParams({ businessId, start, end, creativeId });
      if (providerAccountId) query.set("providerAccountId", providerAccountId);

      const engine = await fetch(`/api/creatives/decision-engine-v3?${query.toString()}`, {
        cache: "no-store",
      })
        .then(async (response) =>
          response.ok
            ? ((await response.json()) as {
                status?: string;
                flags?: { enabled: boolean; surfaceVisible: boolean; shadowOnly: boolean };
                decisions?: Array<{ creativeId?: string; label?: string }>;
              })
            : null,
        )
        .catch(() => null);

      if (!cancelled) {
        setPosture(
          resolveEnginePosture({
            status:
              engine === null ? "unavailable" : engine.status === "disabled" ? "disabled" : "serving",
            flags: engine?.flags ?? null,
          }),
        );
        setServedLabel(
          engine?.decisions?.find((item) => item.creativeId === creativeId)?.label ?? null,
        );
      }

      try {
        const response = await fetch(`/api/meta/creatives?${query.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "This creative could not be read for this business.",
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as {
          rows?: ServedCreativeRow[];
          history?: ServedHistoryEntry[];
        };
        if (cancelled) return;
        setRows(json.rows ?? []);
        setHistory(json.history ?? []);
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "This creative could not be reached.",
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, creativeId, providerAccountId, start, end]);

  const resolved = useMemo(
    () => (rows ? resolveDetail({ creativeId, accountId: providerAccountId, rows }) : null),
    [rows, creativeId, providerAccountId],
  );

  const built = useMemo(() => (history.length ? buildHistory(history) : { rows: [], anyReplayed: false }), [history]);

  return (
    <SurfaceStateBoundary state={surface}>
      {resolved === null ? null : resolved.kind !== "ready" ? (
        <CreativeDetailView
          creativeId={creativeId}
          name={creativeId}
          media={{ kind: "missing", reason: "" }}
          evidence={[]}
          band={{ kind: "none", reason: "" }}
          decisionsHref={null}
          history={[]}
          anyReplayed={false}
          unavailableReason={resolved.reason}
        />
      ) : (
        <CreativeDetailView
          creativeId={resolved.row.creative_id}
          name={resolved.row.name}
          media={mediaStateFor(resolved.row)}
          evidence={buildEvidence(resolved.row)}
          band={decisionBand({
            posture,
            postureExplanation: postureView(posture).explanation,
            servedLabel,
            servedDetail: null,
          })}
          decisionsHref={decisionsHrefForCreative({
            businessId,
            row: {
              creativeId: resolved.row.creative_id,
              adId: resolved.row.real_ad_id?.trim() || null,
              accountId: resolved.row.account_id,
            },
          })}
          history={built.rows}
          anyReplayed={built.anyReplayed}
        />
      )}
    </SurfaceStateBoundary>
  );
}
