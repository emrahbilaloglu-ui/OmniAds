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
  adaptProviderHealth,
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

  const reconnect = useCallback(
    async (provider: string) => {
      setOutcome({ kind: "submitted" });
      const response = await fetch(`/api/integrations?businessId=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, provider, action: "reconnect" }),
      }).catch(() => null);

      // Independent read-back. The POST's own body is an acknowledgement.
      const body = await read();
      const rows = body === null ? null : adaptProviderHealth(body, PROVIDERS);
      const observed =
        rows === null ? null : rows.find((r) => r.provider === provider)?.state.kind === "connected";

      setOutcome(
        resolveCeremony({
          accepted: Boolean(response?.ok),
          acceptError: response?.ok ? null : `The reconnect was refused (HTTP ${response?.status ?? "no response"}).`,
          observed,
          observeError: body === null ? "The confirming read failed." : null,
        }),
      );
      setNonce((v) => v + 1);
    },
    [businessId, read],
  );

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
    fetch(`/api/business-cost-model?businessId=${encodeURIComponent(businessId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: Record<string, unknown> | null) => {
        if (cancelled) return;
        const model = json && typeof json === "object" ? json : {};
        setEconomics([
          {
            key: "targetRoas",
            label: "Target ROAS",
            source: "Cost model",
            consumers: ["Decision engine"],
            value: model.targetRoas === undefined ? null : String(model.targetRoas),
          },
        ]);
        setMode(typeof model.recommendedMode === "string" ? model.recommendedMode : null);
        setSurface({ kind: "ready" });
      })
      .catch(() => setSurface({ kind: "ready" }));
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

    // Separate read: deletion is confirmed only by a read that no longer finds
    // the business. A 200 alone must never say "deleted".
    const check = await fetch(`/api/businesses/${encodeURIComponent(businessId)}`, {
      cache: "no-store",
    }).catch(() => null);
    const observed = check === null ? null : check.status === 404;

    setOutcome(
      resolveCeremony({
        accepted: Boolean(response?.ok),
        acceptError: response?.ok ? null : `The delete was refused (HTTP ${response?.status ?? "no response"}).`,
        observed,
        observeError: check === null ? "The confirming read failed." : null,
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
