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
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--ledger-border-subtle)" }}>
            {footer}
          </div>
        </nav>
      </ZeroBaseSheet>
    </>
  );
}
