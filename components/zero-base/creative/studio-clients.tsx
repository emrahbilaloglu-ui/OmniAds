"use client";

/**
 * Data boundaries for the five creative studio routes.
 *
 * Each reads its existing endpoint and renders the served answer. The share
 * client owns the only mutations here — revoke and rotate — and both go to the
 * existing share API rather than a new one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

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
/*
 * The Studio's own share machinery, imported rather than reimplemented.
 *
 * These four decide what a share tier may carry, how a row is shaped for it,
 * and what the public page compares against. A second copy here would be a
 * second answer to "what may a buyer see", which is the one question the tier
 * exists to have a single answer to.
 */
import {
  computeCreativeShareBenchmarks,
  mapApiRowToUiRow,
  toCreatorTier0SharedCreative,
  toSharedCreative,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import { resolveCreativeStudioSharePolicy } from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import { DEFAULT_TOP_METRIC_IDS } from "@/components/creatives/creatives-top-section-support";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type { ShareAudience } from "@/components/creatives/shareCreativeTypes";
import type { SurfaceState } from "@/lib/zero-base/state-types";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

interface ScopeProps {
  businessId: string;
  providerAccountId: string | null;
  start: string;
  end: string;
  /**
   * Why minting a share is refused, read on the server.
   *
   * Non-null exactly when `/api/creatives/share` would refuse the POST, so the
   * ledger states the same fact the server would rather than leaving an absent
   * control to imply one.
   */
  shareMintRefusalReason?: string | null;
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

/**
 * The three reasons this ledger can refuse a mint, and none of them is "this
 * screen does not do that".
 *
 * It used to be exactly that: the create path built a payload with
 * `creatives: []`, the server requires at least one, and rather than sending a
 * guaranteed 400 the screen disabled the control and pointed the operator at
 * the Creative Studio. That sentence is gone because the reason is gone — the
 * ledger now reads the same creatives the Performance tab reads and mints from
 * a ticked selection.
 *
 * What is left are three real conditions, each with its own sentence, because
 * "the gate is shut", "this account served nothing" and "the read failed" send
 * an operator to three different places.
 */
const SHARE_NEEDS_CREATIVES = "A share needs at least one creative.";
const SHARE_NO_CREATIVES_SERVED =
  "No creatives were served for this account and window, so there is nothing to put in a share. Widen the window or choose another account.";
const SHARE_CREATIVES_UNREAD =
  "The creatives for this account could not be read, so a share cannot be built from them yet.";

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

  /**
   * What there is to share, read from the same endpoint the Performance tab
   * reads.
   *
   * This screen could list, rotate and revoke but never mint, because it had no
   * creative selection to send and the server refuses a snapshot holding none.
   * The selection is the missing half, and it comes from `/api/meta/creatives`
   * under this surface's own scope rather than from a second source of truth:
   * a share must hold rows the operator could see on the Performance tab in the
   * same account and window.
   *
   * `requireAccount` is true — an unscoped read would offer creatives from
   * whichever account the server happened to pick, and a share is a claim about
   * ONE account.
   */
  const creativesRead = useJson<{ rows?: MetaCreativeApiRow[] }>(
    scoped("/api/meta/creatives", props, { groupBy: "creative", format: "all", sort: "spend" }),
    "Creatives",
  );
  const selectable = useMemo(
    () => (creativesRead.data?.rows ?? []).map(mapApiRowToUiRow),
    [creativesRead.data],
  );
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    );
  }, []);

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
   * Mint a share from the ticked rows.
   *
   * The payload is built the same way the Creative Studio's own share modal
   * builds it — `resolveCreativeStudioSharePolicy` decides which metrics a tier
   * may carry, `toSharedCreative` / `toCreatorTier0SharedCreative` shape each
   * row for that tier, and `computeCreativeShareBenchmarks` supplies the
   * comparison the public page draws. None of that is re-derived here: a
   * second policy would be a second answer to what a buyer is allowed to see,
   * and the whole point of the tier is that there is only one.
   *
   * `snapshotOnly` is true because this is a frozen snapshot, and
   * `anonymizeCampaignNames` because this payload has no campaign-name field to
   * offer — the same explicit choice the Studio makes.
   */
  const create = useCallback(
    async (input: {
      title: string;
      audience: ShareAudience;
      expiresAt: string;
      creativeIds: readonly string[];
    }) => {
      const rows = selectable.filter((row) => input.creativeIds.includes(row.id));
      if (rows.length === 0) {
        setError(SHARE_NEEDS_CREATIVES);
        return;
      }
      setBusy("new");
      setError(null);
      try {
        const policy = resolveCreativeStudioSharePolicy({
          audience: input.audience,
          selectedMetricIds: DEFAULT_TOP_METRIC_IDS,
          buyerDecisionLanguage: false,
          allowCsv: false,
          anonymizeCampaignNames: true,
        });
        const response = await fetch("/api/creatives/share", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            businessId: props.businessId,
            providerAccountId: props.providerAccountId,
            title: input.title,
            dateRange: `${props.start} - ${props.end}`,
            expiresAt: input.expiresAt,
            metrics: policy.metrics,
            audience: input.audience,
            ...(input.audience === "buyer"
              ? { acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE }
              : {}),
            presetId: "creative-shares",
            presetLabel: "Shares ledger",
            includeCampaignNames: policy.includeCampaignNames,
            includeDecisionLanguage: policy.includeDecisionLanguage,
            allowCsv: policy.allowCsv,
            snapshotOnly: true,
            filters: ["Shares ledger", "selected creatives"],
            selectedRowIds: rows.map((row) => row.id),
            totalRows: selectable.length,
            benchmarks: computeCreativeShareBenchmarks(selectable),
            creatives: rows.map((row) =>
              policy.creatorTier0 ? toCreatorTier0SharedCreative(row) : toSharedCreative(row),
            ),
          }),
        });
        if (!response.ok) {
          const json = (await response.json().catch(() => null)) as { message?: string } | null;
          // The server's own sentence, including the gate's 503, rather than a
          // status code the operator cannot act on.
          setError(json?.message ?? `The share could not be created (HTTP ${response.status}).`);
          return;
        }
        setSelectedIds([]);
        refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The share API could not be reached.");
      } finally {
        setBusy(null);
      }
    },
    [props.businessId, props.providerAccountId, props.start, props.end, refresh, selectable],
  );

  /**
   * Why minting is refused, when it is — in the order the reasons matter.
   *
   * A shut gate outranks an empty account: telling an operator "no creatives
   * were served" while the mint path is switched off product-wide would send
   * them looking at their data for a problem that is in the deployment.
   */
  const mintRefusal =
    props.shareMintRefusalReason ??
    (creativesRead.surface.kind === "ready" && selectable.length === 0
      ? SHARE_NO_CREATIVES_SERVED
      : creativesRead.surface.kind === "ready"
        ? null
        : SHARE_CREATIVES_UNREAD);

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
         * Offered only when it can succeed. The gate is the server's decision
         * and is restated here so the refusal is visible before the form rather
         * than after it; a read that could not serve any creatives is this
         * screen's own reason, and it is a different sentence because it is a
         * different problem.
         */
        onCreate={mintRefusal ? undefined : (input) => void create(input)}
        selection={{ creatives: selectable, selectedIds, onToggle: toggleSelected }}
        /*
         * Precedence: the gate first, because a shut gate is why nothing can be
         * minted ANYWHERE; then this account's own emptiness. Rotation and
         * revocation stay live under both: withdrawing a link that already
         * exists must never wait on a rollout flag.
         */
        createRefusalReason={mintRefusal}
        onRevoke={(token) => void mutate(token, "revoke")}
        onRotate={(token) => void mutate(token, "rotate")}
      />
    </SurfaceStateBoundary>
  );
}
