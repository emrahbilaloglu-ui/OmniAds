import { redirect } from "next/navigation";
import Link from "next/link";

import { getSessionFromCookies } from "@/lib/auth";
import { isSuperadmin } from "@/lib/admin-auth";
import {
  OPS_GROUPS,
  OPS_NAV,
  OPS_NON_ADMIN_REDIRECT,
  OPS_SHELL_ATTRIBUTE,
  OPS_SURFACE_TOKEN,
} from "@/lib/zero-base/ops/ops-routes";

export const dynamic = "force-dynamic";

/**
 * The Ops shell (H48).
 *
 * The gate is server-side and identical to the legacy admin shell's: no
 * session redirects to login, a signed-in non-admin redirects away. A client
 * check would be a suggestion; this is the boundary, and it runs before any
 * Ops page renders.
 *
 * Ops is a separate product. Its shell carries its own surface token so an Ops
 * event can never be attributed to a buyer session, and nothing in the buyer
 * shell links here.
 */
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies();
  if (!session) redirect("/login");

  const admin = await isSuperadmin(session.user.id);
  if (!admin) redirect(OPS_NON_ADMIN_REDIRECT);

  return (
    <div
      {...{ [OPS_SHELL_ATTRIBUTE]: "" }}
      data-adc-ui="zero-base"
      data-ops-surface={OPS_SURFACE_TOKEN}
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--ledger-bg-canvas)",
        color: "var(--ledger-ink-primary)",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid var(--ledger-border-control)",
          padding: "12px 16px",
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 14, fontWeight: 700 }}>Adsecute Ops</strong>
        <span style={{ fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          Operator console · separate from the buyer product
        </span>
      </header>

      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0, flexWrap: "wrap" }}>
        <nav
          aria-label="Ops"
          data-ops-nav=""
          style={{
            flex: "0 0 auto",
            width: "100%",
            maxWidth: 232,
            borderRight: "1px solid var(--ledger-border-control)",
            padding: 12,
            overflowY: "auto",
          }}
        >
          {OPS_GROUPS.map((group) => {
            const items = OPS_NAV.filter((leaf) => leaf.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} style={{ marginBottom: 14 }}>
                <p
                  style={{
                    margin: "0 0 4px",
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--ledger-ink-tertiary)",
                  }}
                >
                  {group}
                </p>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
                  {items.map((leaf) => (
                    <li key={leaf.ops}>
                      <Link
                        href={leaf.ops}
                        data-ops-link={leaf.ops}
                        style={{
                          display: "block",
                          minHeight: 44,
                          lineHeight: "44px",
                          padding: "0 10px",
                          borderRadius: "var(--ledger-radius-control)",
                          fontSize: 13,
                          color: "var(--ledger-ink-secondary)",
                          textDecoration: "none",
                        }}
                      >
                        {leaf.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <main
          id="ops-main"
          tabIndex={-1}
          style={{ flex: "1 1 420px", minWidth: 0, padding: 16, overflowX: "auto" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
