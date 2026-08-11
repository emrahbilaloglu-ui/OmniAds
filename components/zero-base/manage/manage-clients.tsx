"use client";

/**
 * Data boundaries for the Manage routes.
 *
 * Reconnect and delete each end with an independent read of the resulting
 * state — the POST's own response is never treated as an observation. There is
 * no billing call anywhere here, asserted by a call-site scan.
 */
import { useCallback, useEffect, useState } from "react";

import {
  BusinessView,
  IntegrationsView,
  PlanView,
  TeamView,
} from "@/components/zero-base/manage/manage-views";
import { SurfaceStateBoundary } from "@/components/zero-base/states/surface-state";
import {
  adaptCommercialTarget,
  adaptCostModel,
  adaptProviderHealth,
  adaptRecommendedMode,
  confirmDeletionFromList,
  oauthStartUrl,
  resolveCeremony,
  type CeremonyOutcome,
  type EconomicsField,
  type ProviderHealth,
  type ProviderId,
} from "@/lib/zero-base/manage/manage-contract";
import type { SurfaceState } from "@/lib/zero-base/state-types";

const PROVIDERS: ProviderId[] = ["meta", "google", "shopify", "ga4", "search_console"];

export function IntegrationsClient({ businessId }: { businessId: string }) {
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CeremonyOutcome>({ kind: "unstarted" });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading integrations" });
  const [nonce, setNonce] = useState(0);

  const read = useCallback(async () => {
    const response = await fetch(
      `/api/integrations/status?businessId=${encodeURIComponent(businessId)}`,
      { cache: "no-store" },
    ).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json().catch(() => null)) as unknown;
  }, [businessId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const body = await read();
      if (cancelled) return;
      if (body === null) {
        setReason("Integration status could not be read for this business.");
      } else {
        setProviders(adaptProviderHealth(body, PROVIDERS));
      }
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [read, nonce]);

  /**
   * Reconnecting is an OAuth round trip, not a POST.
   *
   * `/api/integrations` has GET and DELETE only — the previous POST answered
   * 405 every time. The operator leaves for the provider and comes back, so
   * this navigates rather than mutating.
   */
  const reconnect = useCallback(
    (provider: string) => {
      const url = oauthStartUrl({ provider, businessId });
      if (!url) {
        setOutcome({
          kind: "failed",
          detail: `There is no OAuth start route for ${provider}, so a reconnect cannot begin here.`,
        });
        return;
      }
      window.location.assign(url);
    },
    [businessId],
  );

  /**
   * On return from the provider, re-read status and report only what was
   * observed. The redirect having happened is not evidence of anything.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const returned = params.get("reconnected");
    if (!returned) return;
    let cancelled = false;
    (async () => {
      const body = await read();
      if (cancelled) return;
      const rows = body === null ? null : adaptProviderHealth(body, PROVIDERS);
      const observed =
        rows === null ? null : rows.find((r) => r.provider === returned)?.state.kind === "connected";
      setOutcome(
        resolveCeremony({
          accepted: true,
          acceptError: null,
          observed,
          observeError: body === null ? "The confirming read failed." : null,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [read]);

  return (
    <SurfaceStateBoundary state={surface}>
      <IntegrationsView
        providers={providers}
        outcome={outcome}
        unavailableReason={reason}
        onReconnect={(provider) => void reconnect(provider)}
      />
    </SurfaceStateBoundary>
  );
}

export function TeamClient({ businessId, role }: { businessId: string; role: string | null }) {
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string; status: string }>>([]);
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading team" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team/members?businessId=${encodeURIComponent(businessId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { members?: Array<Record<string, unknown>> } | null) => {
        if (cancelled) return;
        setMembers(
          (json?.members ?? []).map((member, index) => ({
            id: String(member.id ?? index),
            name: String(member.name ?? member.email ?? "(not served)"),
            role: String(member.role ?? "Not reported"),
            status: String(member.status ?? "Not reported"),
          })),
        );
        setSurface({ kind: "ready" });
      })
      .catch(() => setSurface({ kind: "ready" }));
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const canManage = role === "admin";
  return (
    <SurfaceStateBoundary state={surface}>
      <TeamView
        members={members}
        canManage={canManage}
        blockedReason={canManage ? null : "Only a business admin can change team membership."}
      />
    </SurfaceStateBoundary>
  );
}

export function BusinessClient({ businessId, role }: { businessId: string; role: string | null }) {
  const [economics, setEconomics] = useState<EconomicsField[]>([]);
  const [recommendedMode, setMode] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CeremonyOutcome>({ kind: "unstarted" });
  const [surface, setSurface] = useState<SurfaceState>({ kind: "loading", label: "Loading business" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const q = `businessId=${encodeURIComponent(businessId)}`;
      // Three different authorities. The cost model carries no target ROAS and
      // no recommended mode; reading them off it produced empty rows forever.
      const [costRaw, commercialRaw, modeRaw] = await Promise.all([
        fetch(`/api/business-cost-model?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`/api/business-commercial-settings?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`/api/business-operating-mode?${q}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (cancelled) return;

      const cost = adaptCostModel(costRaw);
      const commercial = adaptCommercialTarget(commercialRaw);
      const fields: EconomicsField[] = [];

      if (cost) {
        for (const [key, label] of [
          ["cogsPercent", "COGS %"],
          ["shippingPercent", "Shipping %"],
          ["feePercent", "Fees %"],
          ["fixedCost", "Fixed cost"],
        ] as const) {
          fields.push({
            key,
            label,
            source: "Cost model",
            consumers: ["Decision engine", "Reports"],
            value: cost[key] === null ? null : String(cost[key]),
          });
        }
      }
      fields.push({
        key: "targetRoas",
        label: "Target ROAS",
        source: "Commercial settings",
        consumers: ["Decision engine"],
        value: commercial?.targetRoas === null || commercial === null ? null : String(commercial.targetRoas),
      });

      setEconomics(fields);
      setMode(adaptRecommendedMode(modeRaw));
      setSurface({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const remove = useCallback(async () => {
    setOutcome({ kind: "submitted" });
    const response = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    }).catch(() => null);

    // Separate read from the LIST endpoint. `/api/businesses/[businessId]` has
    // no GET, so re-reading it answered 405 every time and the ceremony could
    // never confirm. Absence from the list is the read that can answer.
    const check = await fetch("/api/businesses", { cache: "no-store" }).catch(() => null);
    const listBody = check?.ok ? await check.json().catch(() => null) : null;
    const observed = confirmDeletionFromList({
      listOk: Boolean(check?.ok) && listBody !== null,
      businesses: (listBody as { businesses?: unknown } | null)?.businesses,
      deletedId: businessId,
    });

    setOutcome(
      resolveCeremony({
        accepted: Boolean(response?.ok),
        acceptError: response?.ok ? null : `The delete was refused (HTTP ${response?.status ?? "no response"}).`,
        observed,
        observeError: observed === null ? "The confirming read failed." : null,
      }),
    );
  }, [businessId]);

  return (
    <SurfaceStateBoundary state={surface}>
      <BusinessView
        economics={economics}
        recommendedMode={recommendedMode}
        deleteOutcome={outcome}
        canDelete={role === "admin"}
        onDelete={() => void remove()}
      />
    </SurfaceStateBoundary>
  );
}

/** Static presentation. No billing read, no gating. */
export function PlanClient() {
  return (
    <PlanView
      planName="Adsecute"
      features={[
        "Meta and Google read surfaces",
        "Creative decision surfaces",
        "Reports",
      ]}
    />
  );
}
