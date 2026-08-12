"use client";

import Link from "next/link";

import { isNavHrefActive, navHref, railLabel, type NavGroup } from "@/lib/zero-base/navigation";

/**
 * The rail names product modules; this row names the leaves inside the active
 * module. Keeping both levels visible avoids a 25-item rail while preserving a
 * direct route to every working surface.
 */
export function ModuleNavigation({
  groups,
  businessId,
  pathname,
}: {
  groups: readonly NavGroup[];
  businessId: string | null;
  pathname: string;
}) {
  const group = groups.find((candidate) =>
    candidate.items.some((item) => {
      const href = navHref(item.url, businessId);
      return isNavHrefActive(href, pathname);
    }),
  );

  if (!businessId || !group || group.id === "home" || group.id === "manage" || group.items.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label={`${group.label} pages`}
      data-module-navigation={group.id}
      style={{
        display: "flex",
        flex: "0 0 auto",
        minHeight: 37,
        padding: "0 16px",
        gap: 4,
        overflowX: "auto",
        background: "var(--ledger-bg-surface)",
        borderBottom: "1px solid var(--ledger-border-subtle)",
      }}
    >
      {group.items.map((item) => {
        const href = navHref(item.url, businessId);
        const current = isNavHrefActive(href, pathname);
        return (
          <Link
            key={item.leaf}
            href={href}
            aria-current={current ? "page" : undefined}
            data-ctl={group.id === "meta" ? "live:nav" : "live:tab"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              flex: "0 0 auto",
              minHeight: 36,
              padding: "0 9px",
              borderBottom: current ? "2px solid var(--ledger-accent-action)" : "2px solid transparent",
              color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
              textDecoration: "none",
              fontSize: 12,
              fontWeight: current ? 600 : 500,
              whiteSpace: "nowrap",
            }}
          >
            {railLabel(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}
