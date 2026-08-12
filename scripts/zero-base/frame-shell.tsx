/**
 * WP-26 / G10 — the real shell, around every shelled frame.
 *
 * The frame harness used to hand-write `<div data-adc-ui>` and `<main>` into a
 * template string and render only the leaf fragment inside it. That is why
 * nearly every frame was a substitution: the rail, top bar, context bar, skip
 * link and drawer — the majority of what the accepted artboards actually draw —
 * were never rendered at all. A capture of that proves the leaf compiles, not
 * that the product looks like the design.
 *
 * This mounts the genuine `AppShell` instead. `ClientShell` and its siblings are
 * thin data-resolving wrappers that need a router and a workspace envelope;
 * `AppShell` is the canonical chrome itself, so the harness supplies the same
 * resolved inputs those wrappers would and mounts the real thing.
 */
import React from "react";

import { AppShell, isNarrowWidth } from "@/components/zero-base/shell/app-shell";
import { UserMenu } from "@/components/zero-base/shell/user-menu";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import { navGroupsFor, type NavContext } from "@/lib/zero-base/navigation";
import type { ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";

/** Which shell a frame sits in. `none` is for unauthenticated surfaces. */
export type FrameShell = NavContext | "Account" | "none";

/** The frame's scope, fixed so captures are deterministic. */
export const FRAME_SCOPE: ScopeFacts = {
  scopeContext: "Client",
  enteredFrom: "Agency Desk",
  providerLabel: "Meta (Google Ads also assigned)",
  businessName: "Halcyon Supply Co.",
  providerAccountLabel: "act_298410771 · Halcyon Main",
  evidenceWindowLabel: "Jul 13 – Aug 9",
  configuredCurrency: "USD",
  currencyProof: "proven",
  businessTimezone: "America/New_York",
  timezoneProof: "aligned",
  freshness: "fresh",
  snapshotAt: "2026-08-09T06:00:00Z",
};

/** A scope whose timezone disagrees — the context bar's warned posture. */
export const FRAME_SCOPE_WARNED: ScopeFacts = {
  ...FRAME_SCOPE,
  timezoneProof: "disagreement",
  freshness: "stale",
};

export interface FrameShellOptions {
  shell: FrameShell;
  /** Path the rail marks as current. */
  pathname: string;
  title: string;
  width: number;
  scope?: ScopeFacts | null;
  drawerOpen?: boolean;
  scopeSheetOpen?: boolean;
  language?: "en" | "tr";
}



export function withFrameShell(
  options: FrameShellOptions,
  children: React.ReactNode,
): React.ReactElement {
  const language = options.language ?? "en";

  if (options.shell === "none") {
    // Unauthenticated surfaces genuinely have no rail, no context bar and no
    // user menu. Wrapping them in chrome would be the same lie in reverse.
    return (
      <ZeroBaseCopyProvider language={language}>
        {/* The canonical root still applies. A login page has no rail, but it
            has Ledger tokens — without the root attribute they do not resolve
            and the surface renders with legacy colours. */}
        <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }} data-frame-unshelled="">
          {children}
        </div>
      </ZeroBaseCopyProvider>
    );
  }

  const context: NavContext = options.shell === "Account" ? "Client" : options.shell;
  const businessId = context === "Ops" ? null : "biz";

  return (
    <ZeroBaseCopyProvider language={language}>
      <AppShell
        groups={navGroupsFor(context)}
        businessId={businessId}
        pathname={options.pathname}
        workspaceMode={context === "Client" ? "client" : context === "Agency" ? "agency" : "account"}
        workspaceName={context === "Client" ? FRAME_SCOPE.businessName ?? "Halcyon Supply Co." : context === "Agency" ? "Agency" : "Operations"}
        title={options.title}
        scope={options.scope === undefined ? FRAME_SCOPE : options.scope}
        initialNarrow={isNarrowWidth(options.width)}
        initialDrawerOpen={options.drawerOpen ?? false}
        initialScopeOpen={options.scopeSheetOpen ?? false}
        agencyReturn={{ href: "/a/desk?q=&cursor=c1&row=biz-0", label: "← Agency Desk" }}
        scopePickers={{
          onSwitchScope: () => {},
          onSwitchBusiness: () => {},
          onPickAccount: () => {},
          onPickWindow: () => {},
        }}
        railFooter={
          <p
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: "16px",
              color: "var(--ledger-ink-tertiary)",
            }}
          >
            Dana Whitfield
          </p>
        }
        topBarActions={<UserMenu name="Dana Whitfield" onLogout={() => {}} />}
      >
        {children}
      </AppShell>
    </ZeroBaseCopyProvider>
  );
}
