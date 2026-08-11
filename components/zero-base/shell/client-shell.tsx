"use client";

/**
 * Client-scope shell wrapper.
 *
 * Splits the server layout (which resolves and authorizes scope) from the
 * client chrome (which needs pathname and viewport). The envelope crosses the
 * boundary as inert data — nothing here can widen the scope it was given.
 */
import { usePathname } from "next/navigation";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import { AppShell } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import { navGroupsFor } from "@/lib/zero-base/navigation";
import type { ProviderScopeMode, WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";

export function ClientShell({
  envelope,
  businessId,
  providerScopeMode,
  children,
}: {
  envelope: WorkspaceContextEnvelope;
  businessId: string;
  providerScopeMode: ProviderScopeMode;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const groups = navGroupsFor("Client");

  const scope: ScopeFacts = {
    businessName: envelope.business?.name ?? null,
    providerAccountLabel:
      providerScopeMode === "none" ? null : (envelope.provider?.selectedAccountLabel ?? null),
    evidenceWindowLabel: envelope.evidence.windowLabel,
    configuredCurrency: envelope.business?.configuredCurrency ?? null,
    currencyProof: envelope.proof.currency,
    businessTimezone: envelope.business?.businessTimezone ?? null,
    timezoneProof: envelope.proof.timezone,
    freshness: envelope.evidence.freshness,
    snapshotAt: envelope.evidence.snapshotAt,
  };

  return (
    <WorkspaceContextProvider value={envelope}>
      <AppShell
        groups={groups}
        businessId={businessId}
        pathname={pathname}
        title={envelope.business?.name ?? "Client"}
        scope={scope}
        railFooter={
          <p style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
            {envelope.actor.name}
            {envelope.actor.reviewerReadOnly ? " · read-only review" : ""}
            {envelope.actor.demo ? " · demo" : ""}
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
