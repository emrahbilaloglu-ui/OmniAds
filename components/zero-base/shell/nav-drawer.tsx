"use client";

/**
 * Mobile navigation drawer.
 *
 * The complete rail, not a reduced version of it — the same groups and the
 * same items, at 44 px targets. A mobile nav that omits modules teaches the
 * user those modules do not exist on their phone.
 *
 * Trap, Escape, scrim and focus return all come from the sheet primitive, so
 * this cannot drift from the dialog behaviour the rest of the app uses.
 */
import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseSheet } from "@/components/zero-base/primitives/overlays";
import { navHref, railLabel, type NavGroup } from "@/lib/zero-base/navigation";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function NavDrawer({
  groups,
  businessId,
  pathname,
  workspaceMode = businessId ? "client" : "agency",
  workspaceName = "Workspace",
  footer,
  scopeControls,
  onSwitchScope,
  initialOpen = false,
}: {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
  workspaceMode?: "agency" | "client" | "account";
  workspaceName?: string;
  footer: React.ReactNode;
  /**
   * Scope affordances, above the navigation.
   *
   * Where the operator is takes precedence over where they could go: changing
   * business changes what every link below leads to, so the design places these
   * first rather than at the end of a list that has to be scrolled past.
   */
  scopeControls?: React.ReactNode;
  /** Opens the scoped context picker from the account card's disclosure affordance. */
  onSwitchScope?: () => void;
  /** Drawer-open is a real, addressable state, not only a click outcome. */
  initialOpen?: boolean;
}) {
  const copy = useCopy();
  const [open, setOpen] = useState(initialOpen);
  const isClient = workspaceMode === "client";

  return (
    <>
      <Button
        variant="secondary"
        primaryTarget
        aria-expanded={open}
        aria-label={copy.openNavigation}
        onClick={() => setOpen(true)}
        data-nav-drawer-trigger=""
        data-ctl="live:nav-drawer"
      >
        {copy.menu}
      </Button>
      <ZeroBaseSheet
        open={open}
        onOpenChange={setOpen}
        title={copy.brandName}
        side="left"
        closeCtl="live:nav-drawer close"
      >
        {isClient ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 34px", alignItems: "stretch", minHeight: 54, margin: "10px 0 8px", border: "1px solid var(--ledger-border-control)", borderRadius: "var(--ledger-radius-button)", background: "var(--ledger-bg-surface)", overflow: "hidden" }}>
          <a href="/select-business" data-ctl="live:AUTH-10 business-switcher" style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", alignItems: "center", gap: 8, minHeight: 44, padding: "3px 8px", color: "var(--ledger-ink-primary)", textDecoration: "none" }}>
            <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 6, background: "var(--ledger-accent-action)", color: "var(--ledger-bg-surface)", fontSize: 12, fontWeight: 700 }}>{workspaceName.slice(0,2).toUpperCase()}</span>
            <span style={{ minWidth: 0 }}><strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{workspaceName}</strong><small style={{ display: "block", color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>{copy.switchBusiness}</small></span>
          </a>
          <button type="button" aria-label={copy.switchScope} data-ctl="live:AUTH-10 scope-switch" onClick={onSwitchScope} style={{ border: 0, borderLeft: "1px solid var(--ledger-border-subtle)", background: "transparent", color: "var(--ledger-ink-primary)", cursor: "pointer" }}>▾</button>
          </div>
        ) : null}
        {scopeControls}
        <nav aria-label={copy.primary} data-nav-drawer="">
          {groups.map((group) => {
            const active = group.items.some((item) => { const href = navHref(item.url, businessId); return pathname === href || pathname.startsWith(`${href}/`); });
            const firstHref = navHref(group.items[0]?.url ?? "#", businessId);
            const flat = isClient && group.id === "manage";
            const home = isClient && group.id === "home";
            return (
            <div key={group.id} style={{ marginTop: group.id === "home" ? 8 : 10 }}>
              {isClient && !flat && !home ? (
                <button type="button" onClick={() => { window.location.href = firstHref; setOpen(false); }} data-ctl="live:nav" style={{ display: "flex", alignItems: "center", width: "100%", minHeight: 44, padding: "0 10px", border: 0, borderLeft: active ? "3px solid var(--ledger-accent-action)" : "3px solid transparent", borderRadius: "var(--ledger-radius-input)", background: active ? "var(--ledger-accent-tint)" : "transparent", color: active ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                  {group.id === "creative" ? "Creative Intelligence" : group.label}
                </button>
              ) : (
                <p aria-hidden="true" style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, lineHeight: "16px", letterSpacing: "0.04em", color: "var(--ledger-ink-tertiary)" }}>{group.label}</p>
              )}
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {group.items.map((item) => {
                  const href = navHref(item.url, businessId);
                  const current = href === pathname;
                  return (
                    <li key={item.leaf}>
                      <Link
                        href={href}
                        data-ctl="live:nav"
                        aria-current={current ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          // 44px targets in the drawer, per the design.
                          minHeight: 44,
                          padding: isClient && !flat ? "0 12px 0 26px" : "0 8px",
                          fontSize: 13,
                          lineHeight: "19px",
                          borderRadius: "var(--ledger-radius-input)",
                          textDecoration: "none",
                          color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                          background: current ? "var(--ledger-accent-tint)" : "transparent",
                        }}
                      >
                        {home ? "Home" : railLabel(item.label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );})}
          {/* Sticky, for the same reason the rail's footer is a non-scrolling
              sibling: the identity row and the scope affordances must stay
              reachable however long the nav list is. They were scrolling out
              of the sheet entirely. */}
          <div
            style={{
              position: "sticky",
              bottom: 0,
              marginTop: 16,
              paddingTop: 12,
              background: "var(--ledger-bg-surface)",
              borderTop: "1px solid var(--ledger-border-subtle)",
            }}
          >
            {footer}
          </div>
        </nav>
      </ZeroBaseSheet>
    </>
  );
}
