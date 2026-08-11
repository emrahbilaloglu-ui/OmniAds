"use client";

/**
 * Data boundaries for the five creative studio routes.
 *
 * Each reads its existing endpoint and renders the served answer. The share
 * client owns the only mutations here — revoke and rotate — and both go to the
 * existing share API rather than a new one.
 */
import { useCallback, useEffect, useState } from "react";

import {
  BriefsView,
  LandingPagesView,
  SharesView,
  SourcedListView,
  type SourcedRow,
} from "@/components/zero-base/creative/studio-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  canCreateBrief,
  toBriefRow,
  toShareRow,
  type ServedBrief,
  type ServedShare,
} from "@/lib/zero-base/creative/studio-adapters";
import type { SurfaceState } from "@/lib/zero-base/state-types";

interface ScopeProps {
  businessId: string;
  providerAccountId: string | null;
  start: string;
  end: string;
}

function useJson<T>(url: string | null, label: string) {
  const [data, setData] = useState<T | null>(null);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setSurface({ kind: "loading", label });
    (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          // A failed read is a failure, never an empty collection.
          if (!cancelled) {
            setSurface({
              kind: "error",
              reason: `${label} could not be read for this business.`,
              verbatim: `HTTP ${response.status}`,
              retry: true,
            });
          }
          return;
        }
        const json = (await response.json()) as T;
        if (cancelled) return;
        setData(json);
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSurface({
          kind: "error",
          reason: `${label} could not be reached.`,
          verbatim: error instanceof Error ? error.message : undefined,
          retry: true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, label, nonce]);

  return { data, surface, refresh: () => setNonce((value) => value + 1) };
}

function scoped(base: string, scope: ScopeProps, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    businessId: scope.businessId,
    start: scope.start,
    end: scope.end,
    ...extra,
  });
  if (scope.providerAccountId) params.set("providerAccountId", scope.providerAccountId);
  return `${base}?${params.toString()}`;
}

/* ---------------------------------------------------------------- briefs */

export function CreativeBriefsClient(props: ScopeProps) {
  const { data, surface } = useJson<{ briefs?: ServedBrief[] }>(
    scoped("/api/meta/creative-briefs", props),
    "Creative briefs",
  );
  // A brief needs a creative and an account to be traceable; without a selected
  // account there is nothing safe to derive one from.
  const gate = canCreateBrief({ creativeId: null, accountId: props.providerAccountId });

  return (
    <SurfaceStateBoundary state={surface}>
      <BriefsView
        rows={(data?.briefs ?? []).map(toBriefRow)}
        canCreate={gate.ok}
        createBlockedReason={gate.ok ? null : gate.reason}
      />
    </SurfaceStateBoundary>
  );
}

/* ----------------------------------------------------------------- inbox */

export function CreativeInboxClient(props: ScopeProps) {
  const { data, surface } = useJson<{ items?: SourcedRow[] }>(
    scoped("/api/creatives/inbox", props),
    "Creative inbox",
  );
  return (
    <SurfaceStateBoundary state={surface}>
      <SourcedListView
        title="Creative inbox"
        rows={data?.items ?? []}
        emptyReason="Nothing is waiting in the inbox for this window."
      />
    </SurfaceStateBoundary>
  );
}

/* ---------------------------------------------------------------- copies */

export function CreativeCopiesClient(props: ScopeProps) {
  const { data, surface } = useJson<{ copies?: SourcedRow[] }>(
    scoped("/api/meta/copies", props),
    "Creative copies",
  );
  return (
    <SurfaceStateBoundary state={surface}>
      <SourcedListView
        title="Creative copies"
        rows={data?.copies ?? []}
        emptyReason="No copy was served for this window."
      />
    </SurfaceStateBoundary>
  );
}

/* -------------------------------------------------------- landing pages */

export function CreativeLandingPagesClient(props: ScopeProps) {
  const { data, surface } = useJson<{
    pages?: Array<{ id?: string; path?: string; sessions?: number; conversions?: number }>;
    rowCap?: number | null;
    pageSize?: number | null;
  }>(
    `/api/analytics/landing-pages?businessId=${encodeURIComponent(props.businessId)}`,
    "Landing pages",
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <LandingPagesView
        rows={(data?.pages ?? []).map((page, index) => ({
          id: page.id ?? page.path ?? String(index),
          path: page.path ?? "(path not served)",
          sessions: page.sessions === undefined ? "Not served" : String(page.sessions),
          conversions: page.conversions === undefined ? "Not served" : String(page.conversions),
        }))}
        // Passed straight through: absent stays absent, so the view can say the
        // backend supplied no cap rather than printing one from a spec.
        served={{ rowCap: data?.rowCap ?? null, pageSize: data?.pageSize ?? null }}
      />
    </SurfaceStateBoundary>
  );
}

/* --------------------------------------------------------------- shares */

export function CreativeSharesClient(props: ScopeProps) {
  const { data, surface, refresh } = useJson<{ shares?: ServedShare[] }>(
    scoped("/api/creatives/share", props),
    "Shares",
  );
  const [busyToken, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (token: string, mode: "revoke" | "rotate") => {
      setBusy(token);
      setError(null);
      try {
        const response = await fetch(`/api/creatives/share/${encodeURIComponent(token)}`, {
          method: mode === "revoke" ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "revoke"
              ? { businessId: props.businessId }
              : { businessId: props.businessId, action: "rotate" },
          ),
        });
        if (!response.ok) {
          const json = (await response.json().catch(() => null)) as { message?: string } | null;
          setError(json?.message ?? `The share could not be ${mode}d (HTTP ${response.status}).`);
          return;
        }
        refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The share API could not be reached.");
      } finally {
        setBusy(null);
      }
    },
    [props.businessId, refresh],
  );

  const now = new Date();
  return (
    <SurfaceStateBoundary state={surface}>
      <SharesView
        rows={(data?.shares ?? []).map((share) => toShareRow(share, now))}
        busyToken={busyToken}
        error={error}
        onRevoke={(token) => void mutate(token, "revoke")}
        onRotate={(token) => void mutate(token, "rotate")}
      />
    </SurfaceStateBoundary>
  );
}
