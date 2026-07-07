"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
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
    isScopeLoading || isInboxLoading ? "Loading" : `${cards.length} decisions`;

  return (
    <main className="min-h-screen bg-neutral-50 px-8 py-8 text-neutral-900">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-500">
            Platforms · Meta
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Creative Priority Inbox
          </h1>
        </div>
        <div className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-600">
          {countLabel}
        </div>
      </div>

      {errors.length > 0 ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
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
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm text-neutral-500">
          Loading workspace...
        </div>
      ) : businessIds.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm text-neutral-500">
          No businesses are available for creative priorities.
        </div>
      ) : isInboxLoading ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm text-neutral-500">
          Loading creative priorities...
        </div>
      ) : inboxQuery.isError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          Creative inbox unavailable.
        </div>
      ) : cards.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-5 text-sm text-neutral-500">
          No creative priorities are available.
        </div>
      ) : (
        <div className="grid gap-3">
          {cards.map((card) => (
            <article
              key={`${card.businessId}:${cardId(card)}`}
              className="rounded-lg border border-neutral-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {businessNameById.get(card.businessId) ?? card.businessId}
                  </div>
                  <div className="mt-1 font-semibold text-neutral-950">
                    {cardName(card)}
                  </div>
                  <div className="mt-1 text-[12px] text-neutral-500">
                    {cardCampaign(card)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Priority
                  </div>
                  <div className="font-mono text-sm font-semibold">
                    {formatNullableNumber(card.priorityScore?.score, 2)}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-neutral-600">
                <span className="rounded border border-neutral-200 px-2 py-1">
                  {card.primary?.label ?? card.label ?? "Review"}
                </span>
                <span className="rounded border border-neutral-200 px-2 py-1">
                  {/* Cross-business list: each card renders in its own
                      account currency; unknown currency falls back to the
                      legacy formatter rather than asserting USD. */}
                  Spend {formatNullableMoney(card.spend, card.currency ?? null)}
                </span>
                <span className="rounded border border-neutral-200 px-2 py-1">
                  ROAS {formatNullableNumber(card.roas, 2)}
                </span>
                <span className="rounded border border-neutral-200 px-2 py-1">
                  Confidence {formatNullablePercent(card.confidence)}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
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
