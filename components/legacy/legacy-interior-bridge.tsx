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
  const setWorkspaceSnapshot = useAppStore((state) => state.setWorkspaceSnapshot);
  const setHasHydrated = useAppStore((state) => state.setHasHydrated);
  const setAuthBootstrapStatus = useAppStore((state) => state.setAuthBootstrapStatus);

  useEffect(() => {
    if (!workspace?.business) return;
    setWorkspaceSnapshot(
      workspace.actor.userId,
      [
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
      ],
      workspace.business.id,
    );
    setHasHydrated(true);
    setAuthBootstrapStatus("ready");
  }, [setAuthBootstrapStatus, setHasHydrated, setWorkspaceSnapshot, workspace]);

  return <QueryProvider>{children}</QueryProvider>;
}
