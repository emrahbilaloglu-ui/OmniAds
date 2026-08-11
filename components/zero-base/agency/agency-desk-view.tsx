"use client";

import Link from "next/link";

import {
  ClientDirectory,
  type AgencyDirectoryPageData,
} from "@/components/zero-base/agency/client-directory";
import { AGENCY_MEMBERSHIP_REVOKED } from "@/lib/zero-base/agency-projection";
import { useSearchParams } from "next/navigation";

/**
 * Agency Desk — Today.
 *
 * A client the operator has just been removed from is not silently missing:
 * returning from it carries `revoked=<id>`, and the desk says what happened
 * instead of leaving them to notice a row has vanished.
 */
export function AgencyDeskView({ initialPage }: { initialPage: AgencyDirectoryPageData }) {
  const searchParams = useSearchParams();
  const revoked = searchParams?.get("revoked") ?? null;
  // Checked against the served page: a revoked client is absent from the
  // authorized query entirely, so it cannot appear here.
  const stillListed = revoked ? initialPage.items.some((row) => row.businessId === revoked) : false;

  return (
    <>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: "0 0 8px" }}>
        Today
      </h2>
      {revoked && !stillListed ? (
        <p
          role="status"
          data-membership-revoked={revoked}
          style={{
            borderRadius: "var(--ledger-radius-card)",
            border: "1px solid var(--ledger-semantic-warn)",
            padding: "10px 14px",
            fontSize: 13,
            lineHeight: "19px",
            color: "var(--ledger-semantic-warn)",
            marginBottom: 16,
          }}
        >
          {AGENCY_MEMBERSHIP_REVOKED}
        </p>
      ) : null}
      <p style={{ fontSize: 13, lineHeight: "19px", color: "var(--ledger-ink-secondary)", margin: "0 0 16px" }}>
        Clients are listed alphabetically. Totals across clients are{" "}
        <Link href="/a/desk/withheld" style={{ color: "var(--ledger-accent-action)" }}>
          withheld for a stated reason
        </Link>
        .
      </p>
      <ClientDirectory initialPage={initialPage} returnPath="/a/desk" />
    </>
  );
}
