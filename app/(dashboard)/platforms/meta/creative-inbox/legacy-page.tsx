"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { buildCreativeStudioTabHrefs } from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { CreativeStudioExact } from "@/components/creatives/CreativeStudioExact";
import { buildCreativeStudioTabCounts } from "@/components/creatives/creative-studio-tab-counts";
import type {
  CreativeStudioInboxColumn,
  CreativeStudioInboxModel,
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

type InboxCard = BriefingCreativeCard & {
  businessId: string;
};

interface CreativeInboxResponse {
  inbox?: InboxCard[];
  errors?: Array<{ businessId: string; status: number; error: string }>;
  source?: {
    measurementReconciliation?: {
      snapshotLatest?: { observedAt?: string | null } | null;
    } | null;
  } | null;
}

export interface MetaCreativeInboxPageProps {
  businessId?: string;
  providerAccountId?: string | null;
}

const EMPTY_WORKFLOW_COLUMNS: CreativeStudioInboxColumn[] = [
  { id: "requested", name: "Requested", tone: "warning", cards: [] },
  { id: "in-production", name: "In production", tone: "info", cards: [] },
  { id: "delivered", name: "Delivered", tone: "automation", cards: [] },
  { id: "live", name: "Live", tone: "positive", cards: [] },
];

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
    inbox: flattenCreativeStudioBriefingCards(payload).map((card) => ({
      ...card,
      businessId,
    })),
    errors: [],
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
  const errors = (inboxQuery.data?.errors ?? []).filter(
    (error) => error.businessId === businessId,
  );
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
    partialReason: (inboxQuery.data?.errors ?? []).length
      ? "Some accounts could not be read; this inbox is incomplete"
      : null,
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

  const state = scopeLoading
    ? "loading"
    : scopeError || inboxQuery.isError || errors.length > 0
      ? "error"
      : !providerAccountId
        ? "account_required"
        : inboxLoading
          ? "loading"
          : scoped.cards.length > 0
            ? "ready"
            : "empty";
  const message = scopeLoading
    ? "Loading assigned Meta account scope."
    : scopeError
      ? errorMessage(
          providerAccountsQuery.error,
          "Assigned Meta accounts could not load.",
        )
      : !providerAccountId
        ? "Select one assigned Meta account to load the creative workflow."
        : inboxLoading
          ? "Loading creative workflow."
          : inboxQuery.isError
            ? errorMessage(inboxQuery.error, "Creative inbox is unavailable.")
            : errors.length > 0
              ? "The selected account briefing source failed; workflow items remain withheld."
              : scoped.cards.length > 0
                ? `${scoped.cards.length} scoped decision ${scoped.cards.length === 1 ? "item is" : "items are"} available, but workflow status, owner, and due date are not supplied. No card is assigned to a workflow column.`
                : "No workflow items are available for this account.";
  const model: CreativeStudioInboxModel = {
    state,
    message:
      scoped.missingAccountCount > 0
        ? `${message} ${scoped.missingAccountCount} ${scoped.missingAccountCount === 1 ? "item was" : "items were"} withheld because provider account identity is missing.`
        : message,
    columns: EMPTY_WORKFLOW_COLUMNS,
    // Upload has no backend contract. Omitting the callback keeps Browse files
    // visibly disabled and prevents a local-only success path.
    onBrowseFiles: undefined,
  };
  const tabHrefs = buildCreativeStudioTabHrefs({
    pathname,
    businessId,
    providerAccountId,
    start: "",
    end: "",
  });

  if (scopeResolved && !businessId) return <BusinessEmptyState />;

  return (
    <div data-inbox-state={state} data-testid="creative-inbox-studio-page">
      <CreativeStudioExact
        activeTab="inbox"
        // Every scoped card is awaiting triage: this surface serves no workflow
        // status, owner or due date, so no card is in a column yet. The count is
        // the number of scoped decision items, and only once they are served.
        counts={buildCreativeStudioTabCounts({
          inbox: state === "ready" || state === "empty" ? scoped.cards.length : null,
        })}
        inbox={model}
        tabHrefs={tabHrefs}
      />
    </div>
  );
}
