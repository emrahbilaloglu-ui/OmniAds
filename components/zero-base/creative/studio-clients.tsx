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
  buildCreateBriefRequest,
  canCreateBrief,
  toBriefRow,
  toShareRow,
  type ServedBrief,
  type ServedShare,
} from "@/lib/zero-base/creative/studio-adapters";
import { BUYER_ACKNOWLEDGEMENT_VALUE } from "@/lib/zero-base/creative/share-acknowledgement";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

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
    if (!url) {
      setData(null);
      setSurface({
        kind: "unavailable",
        reason: `${label} needs a provider account. Choose one from the scope bar.`,
        code: "SCOPE-03",
      });
      return;
    }
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

function scoped(
  base: string,
  scope: ScopeProps,
  extra: Record<string, string> = {},
  requireAccount = true,
): string | null {
  if (requireAccount && !scope.providerAccountId) return null;
  const params = new URLSearchParams({
    businessId: scope.businessId,
    start: scope.start,
    end: scope.end,
    ...extra,
  });
  if (scope.providerAccountId) params.set("providerAccountId", scope.providerAccountId);
  return `${base}?${params.toString()}`;
}

/**
 * The creatives list this business's studio surfaces hang off.
 *
 * The account and window ride along so "back" returns to the same scope the
 * operator left, rather than a re-defaulted one.
 */
function creativesListHref(scope: ScopeProps): string {
  const params = new URLSearchParams({ start: scope.start, end: scope.end });
  if (scope.providerAccountId) params.set("providerAccountId", scope.providerAccountId);
  return `/c/${encodeURIComponent(scope.businessId)}/creative/performance?${params.toString()}`;
}

/* ---------------------------------------------------------------- briefs */

export function CreativeBriefsClient(
  props: ScopeProps & {
    /** Lineage from the URL. A brief is derived from a decision snapshot. */
    creativeId?: string | null;
    snapshotId?: string | null;
    trigger?: string | null;
  },
) {
  const { data, surface, refresh } = useJson<{ briefs?: ServedBrief[] }>(
    scoped("/api/meta/creative-briefs", props),
    "Creative briefs",
  );
  const [error, setError] = useState<string | null>(null);

  const lineage = {
    creativeId: props.creativeId ?? null,
    accountId: props.providerAccountId,
    snapshotId: props.snapshotId ?? null,
    trigger: props.trigger ?? null,
  };
  const gate = canCreateBrief(lineage);

  const create = useCallback(
    async (content: { keep: string; change: string; next: string }) => {
      // Blocked before any POST: the route's lineage is a decision snapshot,
      // and posting without one earns a 400 the operator cannot act on.
      const check = canCreateBrief(lineage);
      if (!check.ok) {
        setError(check.reason);
        return;
      }
      setError(null);
      const body = {
        ...buildCreateBriefRequest({
          lineage,
          content,
          idempotencyKey: crypto.randomUUID(),
        }),
        businessId: props.businessId,
      };
      const response = await fetch("/api/meta/creative-briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!response?.ok) {
        const json = (await response?.json().catch(() => null)) as { message?: string } | null;
        setError(json?.message ?? "The brief could not be created.");
        return;
      }
      // Read back rather than assuming: the list is the record.
      refresh();
    },
    [lineage, props.businessId, refresh],
  );

  return (
    <SurfaceStateBoundary state={surface}>
      <BriefsView
        rows={(data?.briefs ?? []).map(toBriefRow)}
        // Without this the view falls back to "/", which is the marketing
        // landing page, not the creatives this brief came from.
        backHref={creativesListHref(props)}
        canCreate={gate.ok}
        createBlockedReason={gate.ok ? null : gate.reason}
        error={error}
        onCreate={() => void create({ keep: "", change: "", next: "" })}
      />
    </SurfaceStateBoundary>
  );
}

/* ----------------------------------------------------------------- inbox */

export function CreativeInboxClient(props: ScopeProps) {
  const copy = useCopy();
  const inboxParams = new URLSearchParams({ businessIds: props.businessId });
  const { data, surface } = useJson<{
    errors?: Array<{ businessId: string; status: number; error: string }>;
    inbox?: Array<{
      id: string;
      creativeName?: string | null;
      name?: string | null;
      campaignName?: string | null;
      campaign?: string | null;
      adsetName?: string | null;
      adset?: string | null;
    }>;
  }>(
    `/api/creatives/inbox?${inboxParams.toString()}`,
    "Creative inbox",
  );
  const rows: SourcedRow[] = (data?.inbox ?? []).map((item) => ({
    id: item.id,
    label: item.creativeName ?? item.name ?? item.id,
    detail: [item.campaignName ?? item.campaign, item.adsetName ?? item.adset]
      .filter(Boolean)
      .join(" · ") || null,
    source: "Creative briefing",
  }));
  return (
    <SurfaceStateBoundary state={surface}>
      <SourcedListView
        title={copy.creativeInbox}
        rows={rows}
        emptyReason="Nothing is waiting in the inbox for this window."
        unavailableReason={
          data?.errors?.length
            ? `Creative briefing is unavailable (${data.errors[0]?.error ?? "read failed"}).`
            : null
        }
      />
    </SurfaceStateBoundary>
  );
}

/* ---------------------------------------------------------------- copies */

export function CreativeCopiesClient(props: ScopeProps) {
  const copy = useCopy();
  const { data, surface } = useJson<{
    rows?: Array<{
      id: string;
      copy_text?: string | null;
      name?: string | null;
      campaign_name?: string | null;
      account_name?: string | null;
      copy_source?: string | null;
    }>;
  }>(
    scoped("/api/meta/copies", props),
    "Creative copies",
  );
  const rows: SourcedRow[] = (data?.rows ?? []).map((item) => ({
    id: item.id,
    label: item.copy_text ?? item.name ?? item.id,
    detail: [item.campaign_name, item.account_name].filter(Boolean).join(" · ") || null,
    source: item.copy_source ?? null,
  }));
  return (
    <SurfaceStateBoundary state={surface}>
      <SourcedListView
        title={copy.creativeCopies}
        rows={rows}
        emptyReason="No copy was served for this window."
      />
    </SurfaceStateBoundary>
  );
}

/* -------------------------------------------------------- landing pages */

export function CreativeLandingPagesClient(props: ScopeProps) {
  const { data, surface } = useJson<{
    pages?: Array<{ id?: string; path?: string; sessions?: number; purchases?: number; purchaseCvr?: number }>;
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
          conversions:
            page.purchases === undefined
              ? "Not served"
              : `${page.purchases}${page.purchaseCvr === undefined ? "" : ` · ${(page.purchaseCvr * 100).toFixed(2)}% CVR`}`,
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
  /**
   * `grants`, not `shares`.
   *
   * `/api/creatives/share` has always answered `{ grants, capability }`. This
   * read `data?.shares`, a key the endpoint never sends, so the ledger rendered
   * as an empty list **on every account** — a proven-empty claim over a payload
   * that had the rows in it all along. Plan §5.1 finding 15.
   *
   * `capability` is read for the same reason: `canReadLedger: false` means the
   * ledger could not be read, and rendering that as "no shares" is D8's
   * degraded-as-empty defect. It now produces a degraded state with the
   * server's own message.
   */
  const { data, surface, refresh } = useJson<{
    grants?: ServedShare[];
    capability?: { canReadLedger?: boolean; canWrite?: boolean; status?: string };
    message?: string;
  }>(scoped("/api/creatives/share", props, {}, false), "Shares");
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

  /**
   * Create a share.
   *
   * A buyer share carries the acknowledgement the server requires; without it
   * the POST is a 400 by design, so the UI sends it explicitly rather than
   * hoping. Creator shares do not carry it, matching the server contract.
   */
  const create = useCallback(
    async (input: { title: string; audience: "buyer" | "creator"; expiresAt: string }) => {
      setBusy("new");
      setError(null);
      try {
        const response = await fetch("/api/creatives/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: props.businessId,
            providerAccountId: props.providerAccountId,
            title: input.title,
            dateRange: `${props.start}..${props.end}`,
            expiresAt: input.expiresAt,
            metrics: [],
            creatives: [],
            audience: input.audience,
            ...(input.audience === "buyer"
              ? { acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE }
              : {}),
          }),
        });
        if (!response.ok) {
          const json = (await response.json().catch(() => null)) as { message?: string } | null;
          setError(json?.message ?? `The share could not be created (HTTP ${response.status}).`);
          return;
        }
        refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The share API could not be reached.");
      } finally {
        setBusy(null);
      }
    },
    [props.businessId, props.providerAccountId, props.start, props.end, refresh],
  );

  const now = new Date();
  /**
   * A ledger that could not be read is degraded, not empty.
   *
   * The endpoint answers 200 with `grants: []` and `canReadLedger: false` when
   * the share table's migration is pending. Rendering that as an empty ledger
   * tells the operator they have never shared anything, which is a claim about
   * their own history made from a failed read.
   */
  const ledgerUnreadable =
    surface.kind === "ready" && data?.capability?.canReadLedger === false;
  const effectiveSurface: SurfaceState = ledgerUnreadable
    ? {
        kind: "unavailable",
        reason:
          data?.message ??
          "The share ledger could not be read, so existing shares are not listed. This is not an empty ledger.",
        code: "schema_not_ready",
      }
    : surface;

  return (
    <SurfaceStateBoundary state={effectiveSurface}>
      <SharesView
        rows={(data?.grants ?? []).map((share) => toShareRow(share, now))}
        busyToken={busyToken}
        error={error}
        /*
         * Minting is refused here, not offered and then rejected.
         *
         * `create` below builds a payload with `creatives: []`, and the server
         * requires at least one — so every create issued from this ledger was a
         * guaranteed 400 after the operator filled in a title, an audience and
         * an expiry. Selection happens in the Creative Studio share flow. The
         * function is kept so the path is one prop away once this screen has a
         * selection to send.
         */
        onCreate={undefined}
        onRevoke={(token) => void mutate(token, "revoke")}
        onRotate={(token) => void mutate(token, "rotate")}
      />
    </SurfaceStateBoundary>
  );
}
