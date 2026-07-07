"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";

export type TriageScopeType = "creative" | "campaign" | "adset" | "account" | string;
export type TriageAction = "deferred" | "undeferred";

interface TriageStateEntry {
  scopeId: string;
  action: string;
}

export interface ParsedTriageState {
  deferredIds: Set<string>;
  deferredCount: number;
}

interface UseDeferStateOptions {
  businessId?: string | null;
  scopeType?: TriageScopeType;
  snapshotDate?: string | null;
  onError?: (message: string) => void;
}

interface TriageEventInput {
  businessId: string;
  scopeType: TriageScopeType;
  scopeId: string;
  action: TriageAction;
  reappearAt?: string | null;
  snapshotDate?: string | null;
}

type FetchLike = typeof fetch;

export function reappearAt24h(now = new Date()) {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export function buildTriageEventBody(input: TriageEventInput) {
  return {
    businessId: input.businessId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    action: input.action,
    ...(input.reappearAt ? { reappearAt: input.reappearAt } : {}),
    ...(input.snapshotDate ? { snapshotDate: input.snapshotDate } : {}),
  };
}

export function parseTriageState(payload: unknown, scopeType: TriageScopeType = "creative"): ParsedTriageState {
  if (!payload || typeof payload !== "object") {
    return { deferredIds: new Set(), deferredCount: 0 };
  }
  const record = payload as Record<string, unknown>;
  const deferredCount = typeof record.deferredCount === "number" ? record.deferredCount : null;
  const candidates = [
    record.rows,
    record.state,
    record.items,
    record.latest,
    record.latestActions,
    record.latestByScopeId,
  ];
  const entries = candidates.flatMap((candidate) => normalizeTriageEntries(candidate));
  const deferredIds = new Set<string>();

  for (const entry of entries) {
    const entryScopeType = entry.scopeType || entry.scope_type || scopeType;
    const entryScopeId = entry.scopeId || entry.scope_id || entry.id;
    const action = entry.action || entry.latestAction || entry.latest_action;
    if (entryScopeType !== scopeType || typeof entryScopeId !== "string") continue;
    if (action === "deferred") deferredIds.add(entryScopeId);
    if (action === "undeferred") deferredIds.delete(entryScopeId);
  }

  return {
    deferredIds,
    deferredCount: deferredCount ?? deferredIds.size,
  };
}

export function nextDeferredIds(
  current: Set<string>,
  id: string,
  action: TriageAction,
) {
  const next = new Set(current);
  if (action === "deferred") {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

async function fetchTriageState(businessId: string, scopeType?: string) {
  const params = new URLSearchParams({ businessId });
  // Without the scope the API returns the cross-scope global state and its
  // deferredCount double-counts across creative/campaign/adset chips.
  if (scopeType) params.set("scopeType", scopeType);
  const response = await fetch(`/api/triage/state?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `Triage state failed (${response.status})`);
  }
  return payload;
}

export async function postTriageEvent(input: TriageEventInput, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl("/api/triage/event", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify(buildTriageEventBody(input)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `Triage event failed (${response.status})`);
  }
  return payload;
}

export function useDeferState(options: UseDeferStateOptions = {}) {
  const businessId = options.businessId?.trim() ?? "";
  const scopeType = options.scopeType ?? "creative";
  const snapshotDate = options.snapshotDate ?? null;
  const onError = options.onError;
  const [deferredIds, setDeferredIds] = useState<Set<string>>(new Set());
  const [deferredCount, setDeferredCount] = useState(0);

  const triageStateQuery = useQuery({
    queryKey: ["triage-state", businessId, scopeType],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    queryFn: () => fetchTriageState(businessId, scopeType),
  });

  useEffect(() => {
    if (!triageStateQuery.data) return;
    const parsed = parseTriageState(triageStateQuery.data, scopeType);
    setDeferredIds(parsed.deferredIds);
    setDeferredCount(parsed.deferredCount);
  }, [scopeType, triageStateQuery.data]);

  const applyDeferredIds = useCallback((next: Set<string>) => {
    setDeferredIds(next);
    setDeferredCount(next.size);
  }, []);

  const rollback = useCallback(
    (previous: Set<string>, message: string) => {
      applyDeferredIds(previous);
      onError?.(message);
    },
    [applyDeferredIds, onError],
  );

  const defer = useCallback(
    async (id: string) => {
      if (!businessId || !id) return;
      const previous = new Set(deferredIds);
      const next = nextDeferredIds(deferredIds, id, "deferred");
      applyDeferredIds(next);
      try {
        await postTriageEvent({
          businessId,
          scopeType,
          scopeId: id,
          action: "deferred",
          reappearAt: reappearAt24h(),
          snapshotDate,
        });
      } catch (error) {
        rollback(previous, error instanceof Error ? error.message : "Defer failed.");
      }
    },
    [applyDeferredIds, businessId, deferredIds, rollback, scopeType, snapshotDate],
  );

  const undefer = useCallback(
    async (id: string) => {
      if (!businessId || !id) return;
      const previous = new Set(deferredIds);
      const next = nextDeferredIds(deferredIds, id, "undeferred");
      applyDeferredIds(next);
      try {
        await postTriageEvent({
          businessId,
          scopeType,
          scopeId: id,
          action: "undeferred",
          snapshotDate,
        });
      } catch (error) {
        rollback(previous, error instanceof Error ? error.message : "Undo defer failed.");
      }
    },
    [applyDeferredIds, businessId, deferredIds, rollback, scopeType, snapshotDate],
  );

  const clearDeferred = useCallback(async () => {
    const ids = [...deferredIds];
    applyDeferredIds(new Set());
    await Promise.all(ids.map((id) => undefer(id)));
  }, [applyDeferredIds, deferredIds, undefer]);

  return useMemo(
    () => ({
      deferredIds,
      deferredCount,
      isDeferred: (id: string) => deferredIds.has(id),
      defer,
      undefer,
      clearDeferred,
    }),
    [clearDeferred, defer, deferredCount, deferredIds, undefer],
  );
}

interface DeferChipProps {
  id: string;
  deferred?: boolean;
  onUndo?: (id: string) => void;
  className?: string;
}

export function DeferChip({
  id,
  deferred = true,
  onUndo,
  className,
}: DeferChipProps) {
  if (!deferred) return null;

  return (
    <div
      className={[
        "mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-neutral-50 border border-neutral-200 text-[11px] text-neutral-600",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Clock className="inline-block shrink-0" size={12} aria-hidden="true" />
      Reappears tomorrow 9am ·{" "}
      <button
        type="button"
        className="text-blue-600 hover:underline"
        data-action="undefer"
        data-id={id}
        onClick={() => onUndo?.(id)}
      >
        Undo
      </button>
    </div>
  );
}

function normalizeTriageEntries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([scopeId, entry]) =>
      entry && typeof entry === "object"
        ? { scopeId, ...(entry as Record<string, unknown>) }
        : { scopeId, action: String(entry) },
    );
  }
  return [];
}
