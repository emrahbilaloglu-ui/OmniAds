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

  useEffect(() => {
    if (!workspace?.business) return;
    setWorkspaceSnapshot(
      workspace.actor.userId,
      [
        {
          id: workspace.business.id,
          name: workspace.business.name,
          currency: workspace.business.configuredCurrency ?? "USD",
          timezone: workspace.business.businessTimezone,
        },
      ],
      workspace.business.id,
    );
  }, [setWorkspaceSnapshot, workspace]);

  return <QueryProvider>{children}</QueryProvider>;
}
