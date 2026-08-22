"use client";

import { useEffect } from "react";

import { QueryProvider } from "@/providers/query-provider";
import { useAppStore } from "@/store/app-store";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";

/**
 * Supplies the two pieces of the legacy dashboard layout that are not inherited
 * when its preserved page body is mounted inside the canonical `/app/**` shell.
 */
export function LegacyInteriorBridge({ children }: { children: React.ReactNode }) {
  const workspace = useOptionalWorkspaceContext();
  const upsertWorkspaceBusiness = useAppStore(
    (state) => state.upsertWorkspaceBusiness,
  );
  const setHasHydrated = useAppStore((state) => state.setHasHydrated);
  const setAuthBootstrapStatus = useAppStore((state) => state.setAuthBootstrapStatus);

  useEffect(() => {
    if (!workspace?.business) return;
    /**
     * Upsert, not snapshot.
     *
     * This used to call `setWorkspaceSnapshot` with a one-element array holding
     * only the business being rendered — and that action means "this is the
     * complete list", so it REPLACED the store's memberships. Mounting any
     * legacy interior page (Integrations, for one) therefore emptied the
     * workspace switcher down to a single entry, and the operator watched their
     * other workspaces vanish until the next bootstrap put them back.
     *
     * This bridge knows about exactly one business. Upserting says that, and
     * says nothing about the ones it has never seen.
     */
    upsertWorkspaceBusiness(
      workspace.actor.userId,
      {
        id: workspace.business.id,
        name: workspace.business.name,
        // INVARIANTS.md: "Missing currency must not silently become USD, $,
        // TRY, or EUR." This line used to write `?? "USD"`, which minted a
        // provider-money currency the workspace had never configured and
        // handed it to every symbol consumer downstream. A workspace with no
        // configured currency now carries null and renders as unavailable.
        currency: workspace.business.configuredCurrency ?? null,
        timezone: workspace.business.businessTimezone,
      },
      true,
    );
    setHasHydrated(true);
    setAuthBootstrapStatus("ready");
  }, [setAuthBootstrapStatus, setHasHydrated, upsertWorkspaceBusiness, workspace]);

  return <QueryProvider>{children}</QueryProvider>;
}
