"use client";

import Link from "next/link";

import {
  ClientDirectory,
  type AgencyDirectoryPageData,
} from "@/components/zero-base/agency/client-directory";
import { AGENCY_MEMBERSHIP_REVOKED } from "@/lib/zero-base/agency-projection";
import { useSearchParams } from "next/navigation";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

/**
 * Agency Desk — Today.
 *
 * A client the operator has just been removed from is not silently missing:
 * returning from it carries `revoked=<id>`, and the desk says what happened
 * instead of leaving them to notice a row has vanished.
 */
export function AgencyDeskView({
  initialPage,
  returnedFrom = null,
}: {
  initialPage: AgencyDirectoryPageData;
  /** The client just returned from, when this is a Flow A return. */
  returnedFrom?: { name: string; href: string } | null;
}) {
  const copy = useCopy();
  const searchParams = useSearchParams();
  const revoked = searchParams?.get("revoked") ?? null;
  // Checked against the served page: a revoked client is absent from the
  // authorized query entirely, so it cannot appear here.
  const stillListed = revoked ? initialPage.items.some((row) => row.businessId === revoked) : false;

  return (
    // A return is a state the whole desk is in, not a line at the top of it:
    // the client that was left is the reason every row below is being read.
    <div
      data-agency-desk=""
      data-el={returnedFrom ? "flow-a-direction-return" : undefined}
      style={{ display: "flex", flexDirection: "column" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: 0 }}>{copy.today}</h2>
        <span style={{ fontSize: 12, color: "var(--ledger-ink-secondary)" }}>Client readiness · sorted alphabetically</span>
      </div>
      {/* A return states where it came back from and offers the way back in.
          Landing silently on the desk loses the operator's place. */}
      {returnedFrom ? (
        <p
          data-el="agency-return"
          data-flow-a-direction="return"
          style={{ margin: "0 0 12px", fontSize: 12, lineHeight: "18px" }}
        >
          <span>Returned from {returnedFrom.name}.</span>{" "}
          <Link href={returnedFrom.href} style={{ color: "var(--ledger-accent-action)" }}>
            {copy.goBackToClient}
          </Link>
        </p>
      ) : null}
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
      <p data-desk-order="explainer" style={{ margin: "0 0 12px", fontSize: 13, lineHeight: "19px" }}>
        Connection and freshness facts are Meta-specific. Currency is shown as configured — it is not proof of any row&apos;s money.{" "}
        <Link href="/a/desk/withheld" data-ctl="live:AGENCY-02 withheld-explainer" style={{ color: "var(--ledger-accent-action)", fontWeight: 650 }}>
          {copy.whatsWithheldAndWhy} →
        </Link>
      </p>
      <ClientDirectory initialPage={initialPage} returnPath="/a/desk" />
      <div
        data-el="withheld-tile"
        data-desk-order="tile"
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 14, border: "1px solid var(--ledger-semantic-warn)", background: "var(--ledger-bg-surface)", borderRadius: "var(--ledger-radius-card)", padding: "13px 16px", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-secondary)", margin: "0 0 16px" }}
      >
        <strong style={{ color: "var(--ledger-semantic-warn)", whiteSpace: "nowrap" }}>{copy.withheldSafety}</strong>
        <span>{copy.clientsAlphabeticalWithheld} Cross-client spend, revenue, ROAS, severity, anomalies, policy incidents and pending-work counts are never shown or used to rank this list.</span>
      </div>
    </div>
  );
}
