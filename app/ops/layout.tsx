import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { isSuperadmin } from "@/lib/admin-auth";
import { OpsNavigation } from "@/components/zero-base/ops/ops-navigation";
import {
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
        background: "var(--ledger-bg-app)",
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
        <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          Operator console · separate from the buyer product
        </span>
      </header>

      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0, flexWrap: "wrap" }}>
        <aside
          style={{
            flex: "0 0 auto",
            width: "100%",
            maxWidth: 232,
            borderRight: "1px solid var(--ledger-border-control)",
            padding: 12,
            overflowY: "auto",
          }}
        >
          <OpsNavigation />
        </aside>

        <main
          id="ops-main"
          data-ops-content=""
          tabIndex={-1}
          style={{ flex: "1 1 420px", minWidth: 0, padding: 16, overflowX: "auto" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
