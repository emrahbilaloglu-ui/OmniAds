"use client";

import { useEffect, useMemo, useState } from "react";

import { KlaviyoExact } from "@/components/klaviyo/KlaviyoExact";
import {
  buildKlaviyoExactModel,
  type KlaviyoFlowSource,
} from "@/components/klaviyo/klaviyo-exact-adapter";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";

interface KlaviyoFlowsResponse {
  flows?: Array<{
    id?: unknown;
    name?: unknown;
    status?: unknown;
    revenue?: unknown;
    openRate?: unknown;
    recipients?: unknown;
  }> | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * `flows: null` from the route — not connected, reconnect required, or the
 * first import has not landed — stays null all the way to the adapter, which
 * is what draws the design's single em-dash row.
 */
function readFlows(payload: KlaviyoFlowsResponse): KlaviyoFlowSource[] | null {
  if (!Array.isArray(payload.flows)) return null;
  const flows: KlaviyoFlowSource[] = [];
  for (const entry of payload.flows) {
    const id = optionalString(entry?.id);
    if (!id) continue;
    flows.push({
      id,
      name: optionalString(entry?.name),
      status: optionalString(entry?.status),
      revenue: optionalString(entry?.revenue),
      openRate: optionalString(entry?.openRate),
      recipients: optionalString(entry?.recipients),
    });
  }
  return flows;
}

/**
 * The one Klaviyo screen, shared by `/platforms/klaviyo`, `/app/klaviyo` and
 * `/c/{businessId}/klaviyo`.
 *
 * `GET /api/klaviyo/flows` serves the design's five columns out of the
 * `klaviyo_flow_metrics` warehouse table. Until a workspace has connected
 * Klaviyo — or while its first import is still pending — the route answers
 * `flows: null` and this hands that null straight to the adapter, which keeps
 * the design's row geometry with an em-dash in every cell. Nothing is seeded
 * and nothing is inferred in the browser.
 */
export function KlaviyoClient({ businessId }: { businessId?: string | null }) {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const activeBusinessId = businessId ?? selectedBusinessId ?? null;
  useBusinessIntegrationsBootstrap(activeBusinessId, { providers: ["klaviyo"] });

  const domain = useIntegrationsStore((state) =>
    activeBusinessId
      ? state.domainsByBusinessId[activeBusinessId]?.klaviyo
      : undefined,
  );

  const [flows, setFlows] = useState<KlaviyoFlowSource[] | null>(null);

  useEffect(() => {
    if (!activeBusinessId) {
      setFlows(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    // A failed or aborted read leaves `flows` null, which renders the em-dash
    // row. Falling back to the previous business's rows would attribute one
    // workspace's revenue to another.
    setFlows(null);
    void fetch(
      `/api/klaviyo/flows?businessId=${encodeURIComponent(activeBusinessId)}`,
      { signal: controller.signal, credentials: "same-origin" },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as KlaviyoFlowsResponse;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        setFlows(readFlows(payload));
      })
      .catch(() => {
        // Deliberately silent and deliberately null: see above.
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeBusinessId]);

  const model = useMemo(
    () => buildKlaviyoExactModel({ domain, flows }),
    [domain, flows],
  );

  return <KlaviyoExact model={model} />;
}
