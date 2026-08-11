"use client";

/**
 * The client directory — Flow A.
 *
 * Alphabetical, always. There is no sort control and no "most urgent" tab,
 * because the only ranking worth having would need cross-client money, and
 * cross-client money is precisely what cannot be compared here: currencies
 * differ, freshness differs, and a blended figure is a number nobody should
 * act on. Alphabetical is the answer, not a placeholder for one.
 *
 * The status column shows *activity* — when this client's sources last changed
 * — and says so. It is not a health signal, and an absent timestamp renders as
 * "not recorded" rather than as a reassuring dash that reads like zero.
 *
 * Every Open link carries an allowlisted return state, so coming back lands on
 * the same row the operator left rather than the top of the list.
 */
import { useMemo, useState } from "react";
import Link from "next/link";

import { Collection } from "@/components/zero-base/collections/collection";
import { DataTable } from "@/components/zero-base/collections/data-table";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { buildAgencyReturn, AGENCY_RETURN_PARAM } from "@/lib/workspace/agency-return";
import {
  AGENCY_ACTIVITY_NOTE,
  AGENCY_CURRENCY_NOTE,
  AGENCY_EMPTY_DIRECTORY,
  buildAgencyDirectoryPage,
  type AgencySourceBusiness,
} from "@/lib/zero-base/agency-projection";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export interface ClientDirectoryProps {
  businesses: readonly AgencySourceBusiness[];
  /** Which Agency surface the return link should come back to. */
  returnPath: "/a/desk" | "/a/desk/clients";
  pageSize?: number;
  initialQuery?: string;
  initialCursor?: string | null;
}

export function ClientDirectory({
  businesses,
  returnPath,
  pageSize,
  initialQuery = "",
  initialCursor = null,
}: ClientDirectoryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState<string | null>(initialCursor);

  const page = useMemo(
    () => buildAgencyDirectoryPage(businesses, { cursor, pageSize, query }),
    [businesses, cursor, pageSize, query],
  );

  const state: SurfaceState =
    businesses.length === 0
      ? { kind: "empty", reason: AGENCY_EMPTY_DIRECTORY }
      : { kind: "ready" };

  const hrefFor = (businessId: string) => {
    const returnTo = buildAgencyReturn({
      path: returnPath,
      q: query || null,
      cursor,
      row: businessId,
    });
    return `/c/${businessId}/home?${AGENCY_RETURN_PARAM}=${encodeURIComponent(returnTo)}`;
  };

  return (
    <section>
      <div style={{ maxWidth: 320, marginBottom: 16 }}>
        <TextInput
          label="Find a client"
          value={query}
          placeholder="Name"
          onChange={(event) => {
            setQuery(event.target.value);
            // A new search restarts paging; keeping the old cursor would skip
            // matches that sort before it.
            setCursor(null);
          }}
          hint="Filters the clients on this page by name."
        />
      </div>

      <Collection
        envelope={{
          items: page.items,
          servedCount: page.servedCount,
          totalCount: page.totalCount,
          cap: null,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          disclosure: page.disclosure,
        }}
        state={state}
        // Always passed: at the end of the projection the control disables
        // with its reason rather than disappearing, which would read as the
        // page having broken rather than the list having finished.
        onLoadMore={() => {
          if (page.nextCursor) setCursor(page.nextCursor);
        }}
      >
        <DataTable
          caption="Clients, listed alphabetically"
          rows={page.items}
          rowKey={(row) => row.businessId}
          columns={[
            {
              id: "name",
              header: "Client",
              render: (row) => (
                <Link
                  href={hrefFor(row.businessId)}
                  data-open-client={row.businessId}
                  style={{ color: "var(--ledger-accent-action)", textDecoration: "none" }}
                >
                  {row.name}
                </Link>
              ),
            },
            { id: "role", header: "Your role", render: (row) => row.role },
            {
              id: "currency",
              header: "Currency",
              render: (row) => (
                <span data-currency-configured="">
                  {row.configuredCurrency ?? "Not set"}
                  <span style={{ color: "var(--ledger-ink-tertiary)" }}> (configured)</span>
                </span>
              ),
            },
            {
              id: "activity",
              header: "Last source activity",
              render: (row) =>
                row.sourceUpdatedAt ? (
                  <span data-source-activity="">{row.sourceUpdatedAt}</span>
                ) : (
                  // Not a dash: a dash reads like zero, and "we have never
                  // recorded one" is a different fact.
                  <span data-source-activity="none" style={{ color: "var(--ledger-ink-tertiary)" }}>
                    Not recorded
                  </span>
                ),
            },
          ]}
        />
      </Collection>

      <p style={{ fontSize: 12, lineHeight: "16px", marginTop: 8, color: "var(--ledger-ink-tertiary)" }}>
        {AGENCY_CURRENCY_NOTE} {AGENCY_ACTIVITY_NOTE}
      </p>
    </section>
  );
}
