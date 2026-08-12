"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { OPS_GROUPS, OPS_NAV } from "@/lib/zero-base/ops/ops-routes";

/** Canonical Ops navigation with a visible current-location state. */
export function OpsNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Ops" data-ops-nav="">
      {OPS_GROUPS.map((group) => {
        const items = OPS_NAV.filter((leaf) => leaf.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} style={{ marginBottom: 14 }}>
            <p
              style={{
                margin: "0 0 4px",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ledger-ink-tertiary)",
              }}
            >
              {group}
            </p>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
              {items.map((leaf) => {
                const current = pathname === leaf.ops || pathname.startsWith(`${leaf.ops}/`);
                return (
                  <li key={leaf.ops}>
                    <Link
                      href={leaf.ops}
                      data-ops-link={leaf.ops}
                      aria-current={current ? "page" : undefined}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        minHeight: 38,
                        padding: "6px 10px",
                        borderLeft: current ? "3px solid var(--ledger-accent-action)" : "3px solid transparent",
                        borderRadius: "var(--ledger-radius-button)",
                        background: current ? "var(--ledger-accent-tint)" : "transparent",
                        color: current ? "var(--ledger-accent-action)" : "var(--ledger-ink-secondary)",
                        fontSize: 13,
                        fontWeight: current ? 650 : 500,
                        lineHeight: "18px",
                        textDecoration: "none",
                      }}
                    >
                      {leaf.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
