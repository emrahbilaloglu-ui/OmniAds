"use client";

/**
 * Decisions data boundary.
 *
 * Reads the existing workspace endpoint and keeps URL state in sync. It adds no
 * decision logic: every verdict, count and banner comes from the payload, and
 * this component's only judgement is which lane and level the operator asked
 * for.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { DecisionsView } from "@/components/zero-base/meta/decisions/decisions-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import {
  decisionsHref,
  type DecisionsUrlState,
} from "@/lib/zero-base/meta/decisions-url-state";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";

export function DecisionsClient({
  businessId,
  initialState,
  demo,
}: {
  businessId: string;
  initialState: DecisionsUrlState;
  demo: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [payload, setPayload] = useState<MetaDecisionsWorkspacePayload | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading decisions" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/meta/decisions-workspace?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          // A failed read is a failure, not an empty lane — otherwise the
          // operator concludes there is nothing to do today.
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: "The decisions workspace could not be read for this business.",
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as MetaDecisionsWorkspacePayload;
        if (cancelled) return;
        setPayload(json);
        setSurface({ kind: "ready" });
      } catch (error: unknown) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: "The decisions workspace could not be reached.",
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const onStateChange = useCallback(
    (next: DecisionsUrlState) => {
      setState(next);
      // Every filter and the selection live in the URL, so the view is
      // linkable and survives a reload.
      router.replace(decisionsHref(businessId, next), { scroll: false });
    },
    [businessId, router],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      {payload ? (
        <DecisionsView
          model={buildDecisionsViewModel({
            lane: payload.lanes,
            banners: payload.banners ?? [],
            viewer: payload.viewer ?? null,
            state,
          })}
          state={state}
          demo={demo}
          onStateChange={onStateChange}
        />
      ) : null}
    </SurfaceStateBoundary>
  );
}
