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
  footer,
  initialOpen = false,
}: {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
  footer: React.ReactNode;
  /** Drawer-open is a real, addressable state, not only a click outcome. */
  initialOpen?: boolean;
}) {
  const copy = useCopy();
  const [open, setOpen] = useState(initialOpen);
  const [filter, setFilter] = useState("");

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
        title={copy.navigation}
        side="bottom"
        closeCtl="live:nav-drawer close"
      >
        <label style={{ display: "grid", gap: 4, fontSize: 12, marginBottom: 8 }}>
          {copy.findAnything}
          <input
            type="search"
            data-ctl="live:SCOPE-11 search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{
              minHeight: 44,
              padding: "8px 10px",
              borderRadius: "var(--ledger-radius-input)",
              border: "1px solid var(--ledger-border-control)",
              background: "var(--ledger-bg-surface)",
              color: "var(--ledger-ink-primary)",
            }}
          />
        </label>
        <nav aria-label={copy.primary} data-nav-drawer="">
          {groups.map((group) => (
            <div key={group.id} style={{ marginTop: 12 }}>
              <p
                aria-hidden="true"
                style={{
                  margin: "0 0 4px",
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: "16px",
                  letterSpacing: "0.04em",
                  color: "var(--ledger-ink-tertiary)",
                }}
              >
                {group.label}
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {group.items
                  .filter((item) =>
                    filter.trim()
                      ? railLabel(item.label).toLowerCase().includes(filter.trim().toLowerCase())
                      : true,
                  )
                  .map((item) => {
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
                          padding: "0 8px",
                          fontSize: 13,
                          lineHeight: "19px",
                          borderRadius: "var(--ledger-radius-input)",
                          textDecoration: "none",
                          color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                          background: current ? "var(--ledger-accent-tint)" : "transparent",
                        }}
                      >
                        {railLabel(item.label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
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
