"use client";

import { useMemo } from "react";

import { KlaviyoExact } from "@/components/klaviyo/KlaviyoExact";
import { buildKlaviyoExactModel } from "@/components/klaviyo/klaviyo-exact-adapter";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";

/**
 * The one Klaviyo screen, shared by `/platforms/klaviyo`, `/app/klaviyo` and
 * `/c/{businessId}/klaviyo`.
 *
 * Klaviyo serves no lifecycle data today: `app/api/oauth/klaviyo/start` answers
 * 501 rather than fabricating a connection, and no reporting route exists. The
 * adapter is handed `flows: null` for that reason, and renders the design's row
 * geometry with an em-dash in every cell. The moment a reporting route lands,
 * this is the only line that changes.
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

  const model = useMemo(
    () => buildKlaviyoExactModel({ domain, flows: null }),
    [domain],
  );

  return <KlaviyoExact model={model} />;
}
