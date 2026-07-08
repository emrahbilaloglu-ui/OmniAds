"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Inbox } from "lucide-react";
import Link from "next/link";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import {
  cardCampaign,
  cardId,
  cardName,
} from "@/components/creatives/briefing/card-utils";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import { useAppStore } from "@/store/app-store";

type InboxCard = BriefingCreativeCard & {
  businessId: string;
};

interface CreativeInboxResponse {
  inbox?: InboxCard[];
  errors?: Array<{ businessId: string; status: number; error: string }>;
}

async function fetchCreativeInbox(businessIds: string[]) {
  const params = new URLSearchParams({
    businessIds: businessIds.join(","),
    limit: "50",
  });
  const response = await fetch(`/api/creatives/inbox?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | CreativeInboxResponse
    | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "Creative inbox could not load.",
    );
  }
  return payload ?? { inbox: [], errors: [] };
}

export default function MetaCreativeInboxPage() {
  const businesses = useAppStore((state) => state.businesses);
  const workspaceResolved = useAppStore((state) => state.workspaceResolved);
  const businessNameById = useMemo(
    () => new Map(businesses.map((business) => [business.id, business.name])),
    [businesses],
  );
  const businessIds = useMemo(
    () => businesses.map((business) => business.id).filter(Boolean),
    [businesses],
  );
  const inboxQuery = useQuery({
    queryKey: ["creative-cross-business-inbox", businessIds],
    enabled: workspaceResolved && businessIds.length > 0,
    staleTime: 30 * 1000,
    queryFn: () => fetchCreativeInbox(businessIds),
  });
  const cards = inboxQuery.data?.inbox ?? [];
  const errors = inboxQuery.data?.errors ?? [];
  const isScopeLoading = !workspaceResolved;
  const isInboxLoading =
    workspaceResolved &&
    businessIds.length > 0 &&
    (inboxQuery.isLoading || (!inboxQuery.data && inboxQuery.isFetching));
  const countLabel =
    isScopeLoading || isInboxLoading ? "Loading" : `${cards.length} items`;

  return (
    <main className="ad-final px-4 py-4" data-testid="creative-inbox-studio-page">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <header className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="crumbs">Platforms · <b>Meta</b> · Creative Studio</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <h1 className="page-title">Creative Priority Inbox</h1>
                <span className="chip chip--info">Read-only cross-business triage</span>
              </div>
              <p className="mt-1 max-w-3xl text-[13px] text-[var(--muted)]">
                Review server-supplied creative priority items across businesses. Execution
                decisions remain in <Link href="/platforms/meta">Decisions</Link>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip chip--ghost">
                <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
                {countLabel}
              </span>
              <Link className="btn btn--sm" href="/platforms/meta/creatives">Library</Link>
              <Link className="btn btn--sm" href="/platforms/meta/copies">Copy</Link>
              <Link className="btn btn--sm" href="/platforms/meta/landing-pages">Landing pages</Link>
              <Link className="btn btn--sm" href="/platforms/meta/audiences">Audiences</Link>
              <Link className="btn btn--sm" href="/platforms/meta">Decisions</Link>
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
          {errors.length} business briefing source failed; loaded cards remain
          read-only.
        </div>
      ) : null}

      {isScopeLoading ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Loading workspace...
        </div>
      ) : businessIds.length === 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          No businesses are available for creative priorities.
        </div>
      ) : isInboxLoading ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          Loading creative priorities...
        </div>
      ) : inboxQuery.isError ? (
        <div className="rounded-[var(--r)] border border-[var(--danger-bd)] bg-[var(--danger-bg)] p-5 text-sm text-[var(--danger)]">
          Creative inbox unavailable.
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
          No creative priorities are available.
        </div>
      ) : (
        <div className="grid gap-3">
          {cards.map((card) => (
            <article
              key={`${card.businessId}:${cardId(card)}`}
              className="rounded-[var(--r)] border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    {businessNameById.get(card.businessId) ?? card.businessId}
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
                    Priority
                  </div>
                  <div className="font-mono text-sm font-semibold">
                    {formatNullableNumber(card.priorityScore?.score, 2)}
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
                  Confidence {formatNullablePercent(card.confidence)}
                </span>
                <Link
                  className="chip chip--info"
                  href={`/platforms/meta?businessId=${encodeURIComponent(card.businessId)}`}
                >
                  Open Decisions
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      </div>
    </main>
  );
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

function formatNullablePercent(value: number | null | undefined) {
  const numeric = finiteNumber(value);
  return numeric === null ? "—" : `${numeric.toFixed(0)}%`;
}
