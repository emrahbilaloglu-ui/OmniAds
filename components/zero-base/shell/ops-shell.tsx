"use client";

import { usePathname } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

/**
 * Ops chrome.
 *
 * No context bar: Ops is platform-wide rather than client-scoped, so there is
 * no business, account, currency or timezone to state. Buyer navigation is
 * never rendered here and Ops items never appear in a buyer rail.
 */
export function OpsShell({
  envelope,
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  return (
    <WorkspaceContextProvider value={envelope}>
      <AppShell
        groups={navGroupsFor("Ops")}
        businessId={null}
        pathname={pathname}
        title="Ops"
        scope={null}
        railFooter={
          <p style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
            {envelope.actor.name}
          </p>
        }
        topBarActions={
          <UserMenu
            name={envelope.actor.name}
            onLogout={() => {
              window.location.href = "/logout";
            }}
          />
        }
      >
        {children}
      </AppShell>
    </WorkspaceContextProvider>
  );
}
