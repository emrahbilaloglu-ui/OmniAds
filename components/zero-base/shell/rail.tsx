"use client";

/**
 * The 232 px navigation rail.
 *
 * B02 is the constraint that shapes this: at a short viewport the rail must
 * still show its footer identity row, and the nav area — not the whole rail —
 * takes the scroll. A rail that scrolls as one block pushes the identity row
 * off-screen, so the nav is `overflow-y: auto` inside a flex column and the
 * footer is a sibling that cannot be scrolled away.
 *
 * Modules the actor cannot reach are absent, never disabled teasers.
 */
import Link from "next/link";

import { navHref, railLabel, type NavGroup } from "@/lib/zero-base/navigation";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export const RAIL_WIDTH = 232;

export interface RailProps {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
  /** Footer identity row — must remain visible at any viewport height. */
  footer: React.ReactNode;
}

export function Rail({ groups, businessId, pathname, footer }: RailProps) {
  const copy = useCopy();
  return (
    <nav
      aria-label={copy.primary}
      data-rail=""
      style={{
        width: RAIL_WIDTH,
        flex: `0 0 ${RAIL_WIDTH}px`,
        // 232px is the drawn width, so the 1px border has to live inside it —
        // content-box sizing makes the rail 233px and shifts every column.
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        // Fills the viewport so the footer can sit at the bottom of it.
        height: "100%",
        background: "var(--ledger-bg-surface)",
        borderRight: "1px solid var(--ledger-border-subtle)",
      }}
    >
      <div
        data-rail-nav=""
        style={{
          // Only this area scrolls. The footer below is a sibling.
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 8px",
        }}
      >
        {groups.map((group) => (
          <div key={group.id} style={{ marginBottom: 12 }}>
            <p
              // Group headings are presentation: they label the set without
              // adding a landmark a screen reader has to step through.
              aria-hidden="true"
              style={{
                margin: "0 0 4px",
                padding: "0 8px",
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
                      aria-current={current ? "page" : undefined}
                      style={{
                        display: "block",
                        padding: "8px 8px",
                        minHeight: 24,
                        fontSize: 13,
                        lineHeight: "19px",
                        borderRadius: "var(--ledger-radius-input)",
                        textDecoration: "none",
                        color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-primary)",
                        background: current ? "var(--ledger-accent-tint)" : "transparent",
                        borderLeft: current
                          ? "3px solid var(--ledger-accent-action)"
                          : "3px solid transparent",
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
      </div>
      <div
        data-rail-footer=""
        style={{
          flex: "0 0 auto",
          padding: 12,
          borderTop: "1px solid var(--ledger-border-subtle)",
        }}
      >
        {footer}
      </div>
    </nav>
  );
}
