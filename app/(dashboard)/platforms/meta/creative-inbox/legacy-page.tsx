"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { buildCreativeStudioTabHrefs } from "@/lib/meta/creative-studio-tab-hrefs";
import type { CreativeRouteWindow } from "@/lib/zero-base/creative/route-scope";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import type {
  CreativeInboxColumnId,
  CreativeStudioInboxCard,
  CreativeStudioInboxColumn,
  CreativeStudioInboxModel,
  CreativeStudioTone,
} from "@/components/creatives/creative-studio-exact-types";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import {
  flattenCreativeStudioBriefingCards,
  scopeCreativeInboxCards,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useAppStore } from "@/store/app-store";

/**
 * Creative Studio — Inbox.
 *
 * ## What this surface stopped claiming
 *
 * It used to draw four columns named Requested / In production / Delivered /
 * Live: a creative-production pipeline. Nothing in this product produces one.
 * Re-provable by grep:
 *
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'workflowStatus|workflow_status|columnId|column_id|stage' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E '\bassignee\b|assigned_to|assignedTo' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'dueAt|due_at|dueDate' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'versionNumber|approvalState|approvedBy|approved_by' app lib components
 *
 * Every live hit belongs to something else — `lib/decision-workflow*` is the
 * DECISION ownership overlay (open/acknowledged/deferred/… on a decision key,
 * and its own header says no transition there can change a decision's label),
 * and every `command_center_*` hit sits under `lib/archive/v1-v2-v21/`.
 * `lib/migrations.ts` declares no workflow table. `/api/creatives/inbox` serves
 * briefing cards plus cache/status/error plumbing and no workflow field.
 *
 * A caption saying "these columns are unavailable" underneath four columns
 * named after a pipeline did not fix that: the headings are the claim. So the
 * headings are gone.
 *
 * ## What it shows instead
 *
 * The real content this surface has always had access to: the scoped creative
 * BRIEFING decision items, in the authority's own three served sections —
 * `actionNow`, `watching`, `healthy`. That is the engine's own grouping of its
 * own output, presented under its own names.
 *
 * Nothing here reclassifies it. No card is moved between sections, no decision
 * or buyerAction is inferred, no label is recomputed: the segment a card lands
 * in is decided entirely by which array of the briefing response it arrived in,
 * and the label and one-line summary on the card are the server's strings
 * rendered verbatim. A section the authority served nothing for shows a real
 * zero; a briefing read that FAILED shows the failure, never an empty board.
 *
 * The request -> version -> approval -> Launchpad handoff workflow remains
 * UNBUILT, and the board says so in its own strip rather than implying it works
 * and has no traffic today.
 */

/** The engine's served sections, in the order the authority serves them. */
const INBOX_SEGMENTS: ReadonlyArray<{
  id: CreativeInboxColumnId;
  name: string;
  tone: CreativeStudioTone;
}> = [
  { id: "action-now", name: "Action now", tone: "warning" },
  { id: "watching", name: "Watching", tone: "info" },
  { id: "healthy", name: "Healthy", tone: "positive" },
];

type InboxCard = BriefingCreativeCard & {
  businessId: string;
  /**
   * Which served briefing section this card arrived in. Assigned from the
   * response's own arrays; never derived from the card's contents.
   */
  briefingSegment: CreativeInboxColumnId;
};

interface CreativeInboxResponse {
  inbox?: InboxCard[];
  /**
   * The briefing authority states when its own inventory could not be read.
   * It publishes this today and this surface ignored it, so an UNAVAILABLE
   * inventory arrived as HTTP 200 with empty lanes and the board drew it as a
   * measured zero — "this account has nothing to act on" when the truth was
   * "we could not read what it has". Live on act_822913786458311.
   */
  canonicalDecisionInventory?: {
    status?: string | null;
    unavailableReason?: string | null;
  } | null;
  source?: {
    measurementReconciliation?: {
      snapshotLatest?: { observedAt?: string | null } | null;
    } | null;
  } | null;
}

export interface MetaCreativeInboxPageProps {
  businessId?: string;
  providerAccountId?: string | null;
  /**
   * The window the canonical route parsed out of `?start`/`?end`, validated on
   * the server.
   *
   * The briefing read this surface performs is not windowed — it is asked for a
   * business and an account — so this never filters anything here and is never
   * captioned as if it did. It exists so the window survives the walk through
   * this surface: the Studio tab links were built with empty bounds, which
   * silently reset the operator's range on the way to the next tab.
   */
  serverDateWindow?: CreativeRouteWindow | null;
}

/**
 * The one sentence the board owes an operator when it has nothing to draw.
 *
 * The old answer reported the workflow as read-and-empty — a MEASUREMENT of a
 * thing nobody measured. The replacements each name exactly what happened: a
 * read that has not finished, a read that failed, a read with no account to run
 * against, or a read that genuinely returned nothing. Only the last is a zero.
 */
const WORKFLOW_UNBUILT =
  "Creative requests, versions, approvals and Launchpad handoff are not built: no request, owner, due date, version or approval is recorded anywhere in this product.";

/**
 * Splits the flattened briefing cards back into the sections they came from.
 *
 * `flattenCreativeStudioBriefingCards` walks `[...actionNow, ...watching,
 * ...healthy]` in that order and keeps the FIRST occurrence of each card key.
 * So the flattened list is three contiguous runs, and the length of each run is
 * exactly the length of the flatten of the corresponding prefix. Re-flattening
 * the prefixes is therefore an exact partition and — crucially — it reuses the
 * authority's own de-duplication rather than reimplementing the key function
 * here, where a drift would silently move cards between segments.
 */
function segmentBriefingCards(
  payload: CreativesBriefingResponse | null,
): Array<{ card: BriefingCreativeCard; segment: CreativeInboxColumnId }> {
  const all = flattenCreativeStudioBriefingCards(payload);
  if (!payload) return [];
  const actionCount = flattenCreativeStudioBriefingCards({
    ...payload,
    watching: [],
    healthy: [],
  }).length;
  const throughWatchingCount = flattenCreativeStudioBriefingCards({
    ...payload,
    healthy: [],
  }).length;
  return all.map((card, index) => ({
    card,
    segment:
      index < actionCount
        ? "action-now"
        : index < throughWatchingCount
          ? "watching"
          : "healthy",
  }));
}

/**
 * Money, never inferred.
 *
 * An unknown currency prints the bare number rather than borrowing a symbol.
 * An unmeasured amount returns null, which the card renders as an em dash; a
 * measured zero returns "0" and stays a zero.
 */
function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      // An unrecognised ISO-shaped code is not a reason to invent one.
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatRatio(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value.toFixed(2)}x`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One served card, rendered as itself.
 *
 * `source` and `note` are the server's own decision label and one-line summary,
 * copied verbatim. Neither is composed, shortened or re-derived here, and
 * nothing on this card is computed from a metric: if the engine served no
 * label, the slot is null and renders as an em dash rather than being filled in
 * from the numbers.
 */
function toStudioCard(
  card: InboxCard,
  tone: CreativeStudioTone,
  id: string,
): CreativeStudioInboxCard {
  const decision = card.decisionCenterRow ?? null;
  return {
    id,
    source: text(decision?.buyerLabel) || null,
    sourceTone: tone,
    name:
      text(card.creativeName) ||
      text(card.name) ||
      text(card.creativeId) ||
      text(card.id),
    note:
      text(decision?.oneLine) ||
      text(card.campaignName) ||
      text(card.campaign) ||
      null,
    facts: [
      { label: "Spend", value: formatMoney(card.spend, card.currency) },
      { label: "ROAS", value: formatRatio(card.roas) },
    ],
  };
}

async function fetchCreativeInbox(
  businessId: string,
  providerAccountId: string,
): Promise<CreativeInboxResponse> {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    decisionCenter: "1",
  });
  const response = await fetch(`/api/creatives/briefing?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (CreativesBriefingResponse & { message?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.message ?? "Creative inbox could not load.");
  }
  return {
    inbox: segmentBriefingCards(payload).map(({ card, segment }) => ({
      ...card,
      businessId,
      briefingSegment: segment,
    })),
    source: {
      measurementReconciliation: {
        snapshotLatest: {
          observedAt:
            payload?.source?.measurementReconciliation?.snapshotLatest
              ?.observedAt ?? null,
        },
      },
    },
  } satisfies CreativeInboxResponse;
}

function resolveCardAccountId(card: BriefingCreativeCard): string {
  return (
    card.providerAccountId?.trim() ||
    card.accountId?.trim() ||
    card.metaAccountId?.trim() ||
    ""
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export default function MetaCreativeInboxPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  serverDateWindow = null,
}: MetaCreativeInboxPageProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const storeBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const hasAuthorizedBusinessScope = authorizedBusinessId !== undefined;
  const hasAuthorizedProviderScope = authorizedProviderAccountId !== undefined;
  const businessId = hasAuthorizedBusinessScope
    ? authorizedBusinessId?.trim() ?? ""
    : storeBusinessId ?? "";
  const scopeResolved = hasAuthorizedBusinessScope || workspaceResolved;
  const requestedProviderAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : searchParams?.get("providerAccountId")?.trim() ?? "";
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled:
      scopeResolved && Boolean(businessId) && !hasAuthorizedProviderScope,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const discoveredProviderAccountId =
    (selectedProviderAccountId &&
    providerAccounts.some((account) => account.id === selectedProviderAccountId)
      ? selectedProviderAccountId
      : "") ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");
  const providerAccountId = hasAuthorizedProviderScope
    ? authorizedProviderAccountId?.trim() ?? ""
    : discoveredProviderAccountId;

  useEffect(() => {
    if (hasAuthorizedProviderScope) return;
    setSelectedProviderAccountId((current) => {
      if (current && providerAccounts.some((account) => account.id === current)) {
        return current;
      }
      if (
        requestedProviderAccountId &&
        providerAccounts.some((account) => account.id === requestedProviderAccountId)
      ) {
        return requestedProviderAccountId;
      }
      return "";
    });
  }, [
    businessId,
    hasAuthorizedProviderScope,
    providerAccounts,
    requestedProviderAccountId,
  ]);

  const inboxQuery = useQuery({
    queryKey: ["creative-account-inbox", businessId, providerAccountId],
    enabled: scopeResolved && Boolean(businessId) && Boolean(providerAccountId),
    staleTime: 30 * 1000,
    queryFn: () => fetchCreativeInbox(businessId, providerAccountId),
  });
  const cards = inboxQuery.data?.inbox ?? [];
  const scoped = useMemo(
    () =>
      businessId && providerAccountId
        ? scopeCreativeInboxCards(cards, { businessId, providerAccountId })
        : {
            cards: [] as InboxCard[],
            excludedBusinessCount: 0,
            excludedAccountCount: 0,
            missingAccountCount: cards.filter(
              (card) => !resolveCardAccountId(card),
            ).length,
          },
    [businessId, cards, providerAccountId],
  );
  const scopeLoading =
    !scopeResolved ||
    (!hasAuthorizedProviderScope && providerAccountsQuery.isLoading);
  const scopeError =
    !hasAuthorizedProviderScope && providerAccountsQuery.isError;
  const inboxLoading =
    scopeResolved &&
    Boolean(businessId) &&
    Boolean(providerAccountId) &&
    (inboxQuery.isLoading || (!inboxQuery.data && inboxQuery.isFetching));

  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: scopeLoading || inboxLoading,
    isFetching:
      inboxQuery.isFetching ||
      (!hasAuthorizedProviderScope && providerAccountsQuery.isFetching),
    error: inboxQuery.error ?? providerAccountsQuery.error,
    // This surface reads ONE account from ONE authority. That read either
    // succeeds or throws; there is no partial. A per-account error list used to
    // be carried here from the multi-business /api/creatives/inbox shape, but
    // this page has never called that route, so the list was always empty and
    // the "incomplete" signal could never fire.
    partialReason: null,
    asOf: measuredAsOf(
      inboxQuery.data?.source?.measurementReconciliation?.snapshotLatest
        ?.observedAt ?? null,
    ),
    businessId: businessId || null,
    onRetry: () => {
      if (!hasAuthorizedProviderScope && providerAccountsQuery.isError) {
        void providerAccountsQuery.refetch();
      }
      if (businessId && providerAccountId) void inboxQuery.refetch();
    },
  });

  // The authority publishes when its OWN inventory could not be read. A 200
  // with empty lanes over an unavailable inventory is a read failure wearing
  // a success's clothes, and drawing it as an empty board asserts a measured
  // zero the account never produced.
  const inventory = inboxQuery.data?.canonicalDecisionInventory ?? null;
  const inventoryUnavailable =
    typeof inventory?.status === "string" &&
    inventory.status.trim().toLowerCase() === "unavailable";
  const inventoryUnavailableReason =
    inventory?.unavailableReason?.trim() || null;
  const readFailed = scopeError || inboxQuery.isError || inventoryUnavailable;
  const state = scopeLoading
    ? "loading"
    : readFailed
      ? "error"
      : !providerAccountId
        ? "account_required"
        : inboxLoading
          ? "loading"
          : scoped.cards.length > 0
            ? "ready"
            : "empty";

  /**
   * Every rendered card traces to a served briefing card, and only to that.
   *
   * The segment comes off the card's own `briefingSegment`, which was stamped
   * from the response array it arrived in. A card whose segment is unreadable
   * is dropped rather than parked in a default column, because a default would
   * be this surface deciding something the engine did not say.
   */
  const columns: CreativeStudioInboxColumn[] = useMemo(() => {
    const usedIds = new Set<string>();
    return INBOX_SEGMENTS.map((segment) => ({
      ...segment,
      cards: scoped.cards
        .filter((card) => card.briefingSegment === segment.id)
        .map((card) => {
          const base = text(card.id) || text(card.creativeId) || segment.id;
          let id = base;
          let suffix = 2;
          while (usedIds.has(id)) id = `${base}#${suffix++}`;
          usedIds.add(id);
          return toStudioCard(card, segment.tone, id);
        }),
    }));
  }, [scoped.cards]);

  const servedCount = scoped.cards.length;
  const message = scopeLoading
    ? "Loading assigned Meta account scope."
    : scopeError
      ? errorMessage(
          providerAccountsQuery.error,
          "Assigned Meta accounts could not load.",
        )
      : !providerAccountId
        ? `Select one assigned Meta account to read the creative decision items served for it. ${WORKFLOW_UNBUILT}`
        : inboxLoading
          ? "Reading the creative briefing authority."
          : inboxQuery.isError
            ? // A failed read is not an empty board.
              `${errorMessage(inboxQuery.error, "The creative briefing authority is unavailable.")} These segments are unavailable, not empty.`
            : inventoryUnavailable
              ? // The request succeeded and the ANSWER says it could not read
                // the inventory. Reporting the served zero here would turn the
                // authority's own "unknown" into this surface's "none".
                `The creative briefing authority could not read this account's decision inventory${
                  inventoryUnavailableReason ? ` (${inventoryUnavailableReason})` : ""
                }. These segments are unavailable, not empty. ${WORKFLOW_UNBUILT}`
              : // A genuine zero from the authority stays a zero.
                `The creative briefing authority served no decision items for this account. ${WORKFLOW_UNBUILT}`;

  const model: CreativeStudioInboxModel = {
    state,
    message:
      scoped.missingAccountCount > 0
        ? `${message} ${scoped.missingAccountCount} ${scoped.missingAccountCount === 1 ? "item was" : "items were"} withheld because provider account identity is missing.`
        : message,
    columns,
  };
  // Pass the arriving window straight through. Empty bounds here meant every
  // link out of the Inbox dropped the range the operator came in with, so
  // Assets -> Inbox -> Copies quietly reset the window mid-walk. The Inbox
  // invents nothing: with no window in the URL the links carry none, exactly as
  // before.
  const tabHrefs = buildCreativeStudioTabHrefs({
    pathname,
    businessId,
    providerAccountId,
    start: serverDateWindow?.start ?? "",
    end: serverDateWindow?.end ?? "",
  });

  if (scopeResolved && !businessId) return <BusinessEmptyState />;

  return (
    // `data-inbox-state` describes the BRIEFING READ, which is the only source
    // this surface has: loading, failed, no account, served with items, served
    // with none.
    <div data-inbox-state={state} data-testid="creative-inbox-studio-page">
      <CreativeStudioExact
        activeTab="inbox"
        // The chip now states a MEASUREMENT: how many scoped decision items
        // this tab is showing. It was withheld while the board drew a workflow
        // queue nobody measured; the board no longer claims a queue, so the
        // number is a fact about what is on the tab. `null` while the read is
        // loading, failed or unscoped keeps the em dash — the chip's own "not
        // served" rendering — and a measured zero draws no chip at all, which
        // is the reference's own behaviour for a zero.
        counts={buildCreativeStudioTabCounts({
          inbox: state === "ready" || state === "empty" ? servedCount : null,
        })}
        inbox={model}
        tabHrefs={tabHrefs}
      />
    </div>
  );
}
