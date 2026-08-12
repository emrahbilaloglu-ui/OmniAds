"use client";

import { usePathname } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

/**
 * Agency chrome. No context bar: Agency spans clients, so there is no single
 * business, account, currency or timezone to state — and inventing a blended
 * one would be the exact fiction the design forbids.
 */
export function AgencyShell({
  envelope,
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  children: React.ReactNode;
}) {
  const copy = useCopy();
  const pathname = usePathname() ?? "";
  return (
    <WorkspaceContextProvider value={envelope}>
      <AppShell
        groups={navGroupsFor("Agency")}
        businessId={null}
        pathname={pathname}
        workspaceMode="agency"
        workspaceName={copy.agency}
        title={`Agency · ${copy.agency}`}
        scope={null}
        railFooter={
          <UserMenu
            name={envelope.actor.name}
            rail
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
