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
import type {
  ProviderId,
  ProviderScopeMode,
  WorkspaceContextEnvelope,
  WorkspaceMode,
} from "@/lib/workspace/workspace-context";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";
import { PostureNotice } from "@/components/zero-base/auth/auth-states";
import { DEMO_BUSINESS_COPY, REVIEWER_READ_ONLY_COPY } from "@/lib/zero-base/auth-states";

/** Human names for the scope facts, so the sheet never prints an enum. */
const WORKSPACE_MODE_LABEL: Record<WorkspaceMode, string> = {
  agency: "Agency",
  client: "Client",
  ops: "Ops",
  account: "Account",
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  meta: "Meta",
  google: "Google Ads",
  shopify: "Shopify",
  ga4: "GA4",
  search_console: "Search Console",
};

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
    // Context and provider are facts the envelope already carries; the sheet
    // states them rather than leaving the actor to infer scope from the rail.
    scopeContext: WORKSPACE_MODE_LABEL[envelope.mode],
    // Not yet tracked in the envelope: nothing records which surface the client
    // scope was entered from, so this stays null rather than guessing "Agency
    // Desk" for someone who navigated straight to a bookmark.
    enteredFrom: null,
    providerLabel:
      providerScopeMode === "none" || !envelope.provider
        ? null
        : PROVIDER_LABEL[envelope.provider.id],
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
        {/* Posture is stated on the surface, not only in the rail footer: a
            reviewer who cannot write, or a demo business whose numbers are
            illustrative, must know before they read a chart. */}
        {envelope.actor.reviewerReadOnly ? <PostureNotice text={REVIEWER_READ_ONLY_COPY} /> : null}
        {envelope.actor.demo ? <PostureNotice text={DEMO_BUSINESS_COPY} /> : null}
        {children}
      </AppShell>
    </WorkspaceContextProvider>
  );
}
