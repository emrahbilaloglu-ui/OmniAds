"use client";

/**
 * Google plan data boundary.
 *
 * Reads served recommendations from the existing advisor endpoint. There is no
 * write here and no endpoint that could perform one: this programme adds no
 * Google mutation layer.
 */
import { useEffect, useMemo, useState } from "react";

import { GooglePlanView } from "@/components/zero-base/google/plan-view";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import { resolveGoogleScope, type GoogleAccount, type GoogleSourceState } from "@/lib/zero-base/google/google-contract";
import { buildPlan, type ServedRecommendation } from "@/lib/zero-base/google/manual-plan";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export function GooglePlanClient({
  businessId,
  authorizedAccount,
}: {
  businessId: string;
  /** Presence is server-authoritative; null means no account may be guessed. */
  authorizedAccount?: GoogleAccount | null;
}) {
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [items, setItems] = useState<ServedRecommendation[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [source, setSource] = useState<GoogleSourceState>({
    kind: "unavailable",
    reason: "The plan has not been read yet.",
  });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading plan" });
  const hasAuthorizedScope = authorizedAccount !== undefined;
  const authorizedAccountId = authorizedAccount?.id ?? null;

  useEffect(() => {
    if (hasAuthorizedScope && !authorizedAccountId) {
      setItems([]);
      setStatuses([]);
      setSource({
        kind: "unavailable",
        reason: "Select one assigned Google Ads account before reading this plan.",
      });
      setSurface({ kind: "ready" });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ businessId });
        if (authorizedAccountId) params.set("accountId", authorizedAccountId);
        const response = await fetch(`/api/google-ads/advisor?${params.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setSource({ kind: "unavailable", reason: `The plan could not be read (HTTP ${response.status}).` });
            setSurface({ kind: "ready" });
          }
          return;
        }
        const json = (await response.json()) as {
          accounts?: GoogleAccount[];
          recommendations?: ServedRecommendation[];
          observedAt?: string | null;
        };
        if (cancelled) return;
        setAccounts(json.accounts ?? []);
        setItems(json.recommendations ?? []);
        setStatuses(
          [...new Set((json.recommendations ?? []).map((item) => item.executionStatus).filter(Boolean))] as string[],
        );
        setSource({ kind: "serving", observedAt: json.observedAt ?? null });
        setSurface({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        setSource({
          kind: "unavailable",
          reason: error instanceof Error ? error.message : "The plan could not be reached.",
        });
        setSurface({ kind: "ready" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedAccountId, businessId, hasAuthorizedScope]);

  const scope = useMemo(
    () =>
      hasAuthorizedScope
        ? authorizedAccount
          ? resolveGoogleScope([authorizedAccount])
          : {
              kind: "none" as const,
              reason: "Select one assigned Google Ads account before reading this plan.",
            }
        : resolveGoogleScope(accounts),
    [accounts, authorizedAccount, hasAuthorizedScope],
  );
  const steps = useMemo(() => buildPlan(items), [items]);

  return (
    <SurfaceStateBoundary state={surface}>
      <GooglePlanView scope={scope} source={source} steps={steps} servedStatuses={statuses} />
    </SurfaceStateBoundary>
  );
}
