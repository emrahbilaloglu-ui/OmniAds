"use client";

import { useEffect, useMemo, useState } from "react";
import { StudioTabRow } from "@/components/creatives/StudioTabRow";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Inbox } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import {
  cardCampaign,
  cardId,
  cardName,
} from "@/components/creatives/briefing/card-utils";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import {
  flattenCreativeStudioBriefingCards,
  scopeCreativeInboxCards,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import { useAppStore } from "@/store/app-store";

type InboxCard = BriefingCreativeCard & {
  businessId: string;
};

interface CreativeInboxResponse {
  inbox?: InboxCard[];
  errors?: Array<{ businessId: string; status: number; error: string }>;
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
    inbox: flattenCreativeStudioBriefingCards(payload).map((card) => ({
      ...card,
      businessId,
    })),
    errors: [],
  } satisfies CreativeInboxResponse;
}

export default function MetaCreativeInboxPage() {
  const searchParams = useSearchParams();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const selectedBusiness = businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const requestedProviderAccountId =
    searchParams?.get("providerAccountId")?.trim() ?? "";
  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", selectedBusinessId],
    enabled: workspaceResolved && Boolean(selectedBusinessId),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () => fetchMetaHistoryAccounts({ businessId: selectedBusinessId ?? "" }),
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const [selectedProviderAccountId, setSelectedProviderAccountId] = useState(
    requestedProviderAccountId,
  );
  const providerAccountId =
    selectedProviderAccountId ||
    (providerAccounts.length === 1 ? providerAccounts[0]!.id : "");

  useEffect(() => {
    setSelectedProviderAccountId((current) => {
      if (current && providerAccounts.some((account) => account.id === current)) return current;
      if (
        requestedProviderAccountId &&
        providerAccounts.some((account) => account.id === requestedProviderAccountId)
      ) {
        return requestedProviderAccountId;
      }
      return "";
    });
  }, [providerAccounts, requestedProviderAccountId, selectedBusinessId]);

  const routeScope = {
    businessId: selectedBusinessId,
    providerAccountId,
  };

  const inboxQuery = useQuery({
    queryKey: ["creative-account-inbox", selectedBusinessId, providerAccountId],
    enabled:
      workspaceResolved &&
      Boolean(selectedBusinessId) &&
      Boolean(providerAccountId),
    staleTime: 30 * 1000,
    queryFn: () =>
      fetchCreativeInbox(selectedBusinessId ?? "", providerAccountId),
  });
  const cards = inboxQuery.data?.inbox ?? [];
  const errors = (inboxQuery.data?.errors ?? []).filter(
    (error) => error.businessId === selectedBusinessId,
  );
  const scoped = useMemo(
    () =>
      selectedBusinessId && providerAccountId
        ? scopeCreativeInboxCards(cards, {
            businessId: selectedBusinessId,
            providerAccountId,
          })
        : {
            cards: [] as InboxCard[],
            excludedBusinessCount: 0,
            excludedAccountCount: 0,
            missingAccountCount: cards.filter((card) => !resolveCardAccountId(card)).length,
          },
    [cards, providerAccountId, selectedBusinessId],
  );
  const scopedCards = scoped.cards;
  const isScopeLoading = !workspaceResolved;
  const isInboxLoading =
    workspaceResolved &&
    Boolean(selectedBusinessId) &&
    Boolean(providerAccountId) &&
    (inboxQuery.isLoading || (!inboxQuery.data && inboxQuery.isFetching));
  const countLabel =
    isScopeLoading || providerAccountsQuery.isLoading || isInboxLoading
      ? "Loading"
      : !providerAccountId
        ? "Withheld"
        : `${scopedCards.length} items`;
  const inboxState =
    isScopeLoading || providerAccountsQuery.isLoading || isInboxLoading
      ? "loading"
      : providerAccountsQuery.isError || inboxQuery.isError
        ? "error"
        : providerAccountId
          ? "ready"
          : "account_required";

  if (workspaceResolved && !selectedBusinessId) return <BusinessEmptyState />;

  return (
    <main
      className="ad-final"
      data-testid="creative-inbox-studio-page"
      data-inbox-state={inboxState}
    >
      <div className="flex w-full flex-col gap-4">
          <StudioTabRow active="inbox" />
        <header className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="crumbs">Platforms · <b>Meta</b> · Creative Studio</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <h1 className="page-title">Creative Inbox</h1>
                <span className="chip chip--info">Read-only · account scoped</span>
              </div>
              <p className="mt-1 max-w-3xl text-[13px] text-[var(--muted)]">
                Review server-supplied creative priorities for {selectedBusiness?.name ?? "the selected business"} and one Meta account. Execution remains in <Link href={buildMetaScopedHref("/platforms/meta", routeScope)}>Decisions</Link>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2 text-[11px] text-[var(--muted)]">
                Account
                <select
                  value={providerAccountId}
                  onChange={(event) => {
                    const nextProviderAccountId = event.target.value;
                    if (typeof window !== "undefined") {
                      const url = new URL(window.location.href);
                      if (nextProviderAccountId) {
                        url.searchParams.set("providerAccountId", nextProviderAccountId);
                      } else {
                        url.searchParams.delete("providerAccountId");
                      }
                      window.history.replaceState(null, "", url);
                    }
                    setSelectedProviderAccountId(nextProviderAccountId);
                  }}
                  className="max-w-[190px] border-0 bg-transparent font-mono text-[11px] text-[var(--ink)] outline-none"
                  aria-label="Select Meta account for Creative Inbox"
                  disabled={providerAccountsQuery.isLoading}
                >
                  <option value="">
                    {providerAccountsQuery.isLoading
                      ? "Loading accounts"
                      : providerAccounts.length === 0
                        ? "Unavailable"
                        : "Select account"}
                  </option>
                  {providerAccounts.map((account) => (
                    <option key={account.id} value={account.id}>{accountLabel(account)}</option>
                  ))}
                </select>
              </label>
              <span className="chip chip--ghost">
                <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
                {countLabel}
              </span>
              <Link className="btn btn--sm" href={buildMetaScopedHref("/platforms/meta", routeScope)}>Decisions</Link>
            </div>
          </div>
        </header>

      {errors.length > 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[12px] text-[var(--warn)]">
          <AlertTriangle
            className="mr-1 inline-block"
            size={14}
            aria-hidden="true"
          />
          The selected account briefing source failed; any loaded cards remain read-only.
        </div>
      ) : null}

      {isScopeLoading ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Loading workspace...
        </div>
      ) : !selectedBusinessId ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Select a business to load creative priorities.
        </div>
      ) : providerAccountsQuery.isError ? (
        <div className="rounded-[var(--r)] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-5 text-sm text-[var(--danger)]">
          Assigned Meta accounts could not load. Creative Inbox remains withheld.
        </div>
      ) : providerAccountsQuery.isLoading ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Loading assigned Meta accounts...
        </div>
      ) : providerAccounts.length === 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-5 text-sm text-[var(--warn)]">
          Meta account identity is unavailable. Inbox items stay hidden until an assigned provider account is present.
        </div>
      ) : !providerAccountId ? (
        <div className="rounded-[var(--r)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] p-5 text-sm text-[var(--warn)]" data-testid="creative-inbox-account-required">
          Select one assigned Meta ad account. Creative priorities and counts remain withheld until the provider scope is explicit.
        </div>
      ) : isInboxLoading ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Loading creative priorities...
        </div>
      ) : inboxQuery.isError ? (
        <div className="rounded-[var(--r)] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-5 text-sm text-[var(--danger)]">
          Creative inbox unavailable.
        </div>
      ) : scopedCards.length === 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          No creative priorities are available for account {providerAccountId}.
        </div>
      ) : (
        <div className="grid gap-3">
          {scopedCards.map((card) => (
            <article
              key={`${card.businessId}:${cardId(card)}`}
              className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    {card.providerAccountId ?? card.accountId ?? "Account unavailable"}
                  </div>
                  <div className="mt-1 font-semibold text-[var(--ink)]">
                    {cardName(card)}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--muted)]">
                    {cardCampaign(card)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    Decision context
                  </div>
                  <div className="text-[12px] font-semibold text-[var(--ink)]">
                    {card.decisionCenterRow?.priority ?? "Priority unavailable"}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-[var(--muted)]">
                <span className="chip chip--ghost">
                  {card.primary?.label ?? card.label ?? "Review"}
                </span>
                <span className="chip chip--ghost">
                  {/* Cross-business list: each card renders in its own
                      account currency; unknown currency falls back to the
                      legacy formatter rather than asserting USD. */}
                  Spend {formatNullableMoney(card.spend, card.currency ?? null)}
                </span>
                <span className="chip chip--ghost">
                  ROAS {formatNullableNumber(card.roas, 2)}
                </span>
                <span className="chip chip--ghost">
                  Confidence {card.decisionCenterRow?.confidenceBand ?? "unavailable"}
                </span>
                <Link
                  className="chip chip--info"
                  href={`/platforms/meta?businessId=${encodeURIComponent(card.businessId)}&providerAccountId=${encodeURIComponent(providerAccountId)}&creativeId=${encodeURIComponent(card.creativeId ?? card.id)}`}
                >
                  Open Decisions
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      {scoped.missingAccountCount > 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--warn-bd)] bg-[var(--warn-bg)] px-3 py-2 text-[11.5px] text-[var(--warn)]">
          {scoped.missingAccountCount} {scoped.missingAccountCount === 1 ? "item was" : "items were"} withheld because provider account identity is missing.
        </div>
      ) : null}
      </div>
    </main>
  );
}

function resolveCardAccountId(card: BriefingCreativeCard): string {
  return card.providerAccountId?.trim() || card.accountId?.trim() || card.metaAccountId?.trim() || "";
}

function accountLabel(account: MetaHistoryAccount): string {
  const name = account.name?.trim();
  const currency = account.currency?.trim();
  return [name || account.id, currency].filter(Boolean).join(" · ");
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatNullableNumber(value: number | null | undefined, digits: number) {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : numeric.toFixed(digits);
}

function formatNullableMoney(value: number | null | undefined, currency: string | null) {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : formatMoney(numeric, currency);
}
