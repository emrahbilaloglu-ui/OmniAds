"use client";

/**
 * The client directory — Flow A.
 *
 * The browser receives one bounded page and asks the server for the next. It
 * never holds the full authorized client list: an earlier version did exactly
 * that and sliced it in a `useMemo`, which is client pagination wearing a
 * server pagination label, and it shipped every client's name to the page
 * regardless of what was drawn.
 *
 * Alphabetical, always. There is no sort control and no "most urgent" tab,
 * because the only ranking worth having would need cross-client money, and
 * cross-client money is precisely what cannot be compared here: currencies
 * differ, freshness differs, and a blended figure is a number nobody should
 * act on. Ordering is owned by SQL, so the client never re-sorts and cannot
 * disagree with the cursor.
 *
 * Search filters the rows already served, exactly as the plan specifies. It is
 * not a query: making it one would turn a scan aid into an unbounded
 * cross-client search over names the actor has not paged to.
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
  normalizeBusinessName,
  type AgencyClientRow,
} from "@/lib/zero-base/agency-projection";
import type { SurfaceState } from "@/lib/zero-base/state-types";

export interface AgencyDirectoryPageData {
  items: AgencyClientRow[];
  servedCount: number;
  totalCount: number | null;
  nextCursor: string | null;
  truncated: boolean;
  disclosure: string | null;
}

export interface ClientDirectoryProps {
  /** The first page, rendered on the server. Never the whole list. */
  initialPage: AgencyDirectoryPageData;
  /** Which Agency surface the return link should come back to. */
  returnPath: "/a/desk" | "/a/desk/clients";
  initialQuery?: string;
  /** Cursor this view was restored to, carried back into return links. */
  restoredCursor?: string | null;
  pageSize?: number;
  /** Injected in tests; defaults to the adopted agency route. */
  fetchPage?: (cursor: string, pageSize?: number) => Promise<AgencyDirectoryPageData>;
}

async function fetchNextPage(cursor: string, pageSize?: number): Promise<AgencyDirectoryPageData> {
  const params = new URLSearchParams({ contract: "zero-base.v1", cursor });
  if (pageSize) params.set("pageSize", String(pageSize));
  const response = await fetch(`/api/agency-today?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`directory page failed: ${response.status}`);
  return (await response.json()) as AgencyDirectoryPageData;
}

export function ClientDirectory({
  initialPage,
  returnPath,
  initialQuery = "",
  restoredCursor = null,
  pageSize,
  fetchPage = fetchNextPage,
}: ClientDirectoryProps) {
  const [query, setQuery] = useState(initialQuery);
  // Accumulated served rows, in server order. Appended to, never re-sorted.
  const [rows, setRows] = useState<AgencyClientRow[]>(initialPage.items);
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor);
  // The cursor that produced the last appended page, so a return link points
  // at the page the row is actually on.
  const [pageCursor, setPageCursor] = useState<string | null>(restoredCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = normalizeBusinessName(query);
    if (!needle) return rows;
    return rows.filter((row) => normalizeBusinessName(row.name).includes(needle));
  }, [rows, query]);

  // Three different situations, three different sentences. An empty table with
  // headers and no rows says none of them: the operator cannot tell whether
  // they have no clients, no matches, or should keep paging.
  const state: SurfaceState =
    rows.length === 0
      ? { kind: "empty", reason: AGENCY_EMPTY_DIRECTORY }
      : visible.length === 0
        ? {
            kind: "empty",
            reason:
              cursor === null
                ? `No client matches “${query}”.`
                : `No match for “${query}” among the ${rows.length} clients loaded so far. Load more to search further.`,
          }
        : { kind: "ready" };

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    const requested = cursor;
    try {
      const next = await fetchPage(requested, pageSize);
      setRows((current) => {
        // Defensive append: the server order is total, but a duplicate here
        // would be a silent correctness bug rather than a visible one.
        const seen = new Set(current.map((row) => row.businessId));
        return [...current, ...next.items.filter((row) => !seen.has(row.businessId))];
      });
      setPageCursor(requested);
      setCursor(next.nextCursor);
    } catch {
      setError("Could not load more clients. Nothing already shown was lost.");
    } finally {
      setLoading(false);
    }
  }

  const hrefFor = (businessId: string) => {
    const returnTo = buildAgencyReturn({
      path: returnPath,
      q: query || null,
      cursor: pageCursor,
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
          onChange={(event) => setQuery(event.target.value)}
          hint="Filters the clients already loaded on this page."
        />
      </div>

      <Collection
        envelope={{
          items: visible,
          servedCount: visible.length,
          totalCount: initialPage.totalCount,
          cap: null,
          nextCursor: cursor,
          truncated: cursor !== null,
          disclosure:
            query && visible.length !== rows.length
              ? `Showing ${visible.length} of ${rows.length} loaded clients matching “${query}”.`
              : cursor !== null && initialPage.totalCount !== null
                ? `Showing ${rows.length} of ${initialPage.totalCount} clients.`
                : null,
        }}
        state={state}
        // Always passed: at the end of the directory the control disables with
        // its reason rather than disappearing, which would read as the page
        // having broken rather than the list having finished.
        onLoadMore={() => {
          void loadMore();
        }}
        loadingMore={loading}
      >
        <DataTable
          caption="Clients, listed alphabetically"
          rows={visible}
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

      {error ? (
        <p role="alert" data-directory-error="" style={{ fontSize: 12, marginTop: 8, color: "var(--ledger-semantic-danger)" }}>
          {error}
        </p>
      ) : null}

      <p style={{ fontSize: 12, lineHeight: "16px", marginTop: 8, color: "var(--ledger-ink-tertiary)" }}>
        {AGENCY_CURRENCY_NOTE} {AGENCY_ACTIVITY_NOTE}
      </p>
    </section>
  );
}
