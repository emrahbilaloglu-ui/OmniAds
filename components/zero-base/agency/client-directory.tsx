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
 *
 * Rows are held as page *segments* rather than one flat list, because each row
 * has to remember which page it arrived on. A single mutable "current cursor"
 * looks equivalent and is not: after loading page 2, every page-1 row would
 * start advertising a return to page 2, where that row does not exist. Segments
 * make the provenance immutable — appending a page cannot alter what an earlier
 * row carries.
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
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

function membershipLabel(role: string): string {
  return role.replaceAll("_", " ");
}

function sourceActivityLabel(value: string | null): string {
  if (!value) return "No source activity";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours >= 20 ? "Stale — " : "Updated "}${elapsedHours}h ago`;
  return `No update since ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp)}`;
}

export interface AgencyDirectoryPageData {
  items: AgencyClientRow[];
  servedCount: number;
  totalCount: number | null;
  nextCursor: string | null;
  truncated: boolean;
  disclosure: string | null;
}

/** One served page and the cursor that produced it. */
interface PageSegment {
  /** Cursor that fetched this page; null for the first page. */
  cursor: string | null;
  items: AgencyClientRow[];
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
  const copy = useCopy();
  const [query, setQuery] = useState(initialQuery);
  // Served pages in arrival order. Each keeps the cursor that produced it, so
  // a row's return state is fixed the moment it is served.
  const [segments, setSegments] = useState<PageSegment[]>([
    { cursor: restoredCursor, items: initialPage.items },
  ]);
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => segments.flatMap((segment) => segment.items), [segments]);

  // businessId → the cursor of the page it arrived on. Built from the
  // segments, so it cannot drift from them.
  const cursorByRow = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const segment of segments) {
      for (const row of segment.items) map.set(row.businessId, segment.cursor);
    }
    return map;
  }, [segments]);

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
      setSegments((current) => {
        // Defensive append: the server order is total, but a duplicate here
        // would be a silent correctness bug rather than a visible one.
        const seen = new Set(current.flatMap((segment) => segment.items.map((row) => row.businessId)));
        const fresh = next.items.filter((row) => !seen.has(row.businessId));
        if (fresh.length === 0) return current;
        // Appended as its own segment: existing segments are untouched, so no
        // already-served row can have its return state rewritten.
        return [...current, { cursor: requested, items: fresh }];
      });
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
      // This row's own page, not whichever page was loaded most recently.
      cursor: cursorByRow.get(businessId) ?? null,
      row: businessId,
    });
    return `/c/${businessId}/home?${AGENCY_RETURN_PARAM}=${encodeURIComponent(returnTo)}`;
  };

  return (
    <section data-agency-directory="" style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 320, flex: "1 1 240px" }}>
        <TextInput
          label={copy.findAClient}
          data-ctl="live:SCOPE-11 client-search"
          value={query}
          placeholder={copy.name}
          onChange={(event) => setQuery(event.target.value)}
          hint={copy.filtersLoadedClients}
        />
        </div>
        <span style={{ border: "1px solid var(--ledger-border-subtle)", borderRadius: 999, padding: "5px 10px", font: "12px/1.2 var(--font-mono, monospace)", color: "var(--ledger-ink-secondary)" }}>
          Showing {rows.length}{initialPage.totalCount == null ? " loaded" : ` of ${initialPage.totalCount} clients`}{cursor === null ? " — complete list" : ""}
        </span>
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
        loadMoreCtl="live:AGENCY-04 load-more"
      >
        <DataTable
          collection="clients"
          caption={copy.clientsAlphabetical}
          rows={visible}
          rowKey={(row) => row.businessId}
          columns={[
            {
              id: "name",
              header: "Client · your membership",
              render: (row) => (
                <span style={{ display: "grid", gap: 1 }}>
                  <strong style={{ color: "var(--ledger-ink-primary)", fontSize: 13 }}>{row.name}</strong>
                  <span style={{ color: "var(--ledger-ink-secondary)", font: "12px/1.3 var(--font-mono, monospace)", textTransform: "lowercase" }}>
                    {membershipLabel(row.role)}
                  </span>
                </span>
              ),
            },
            {
              id: "meta-connection",
              header: "Meta connection",
              render: (row) => (
                <span style={{ color: row.metaConnectionStatus === "connected" ? "var(--ledger-semantic-ok)" : "var(--ledger-ink-secondary)", fontWeight: 650, whiteSpace: "nowrap" }}>
                  <span aria-hidden="true">● </span>{row.metaConnectionStatus === "connected" ? "Connected" : "Not connected"}
                </span>
              ),
            },
            {
              id: "meta-accounts",
              header: "Meta accts",
              render: (row) => (row.selectedMetaAccountCount ?? 0) > 0 ? `${row.selectedMetaAccountCount} selected` : "—",
            },
            {
              id: "activity",
              header: "Source activity (warehouse)",
              render: (row) => (
                <span
                  data-source-activity={row.sourceUpdatedAt ? "" : "none"}
                  style={{ color: row.sourceUpdatedAt ? "var(--ledger-ink-primary)" : "var(--ledger-ink-secondary)", whiteSpace: "nowrap" }}
                >
                  {sourceActivityLabel(row.sourceUpdatedAt)}
                </span>
              ),
            },
            {
              id: "currency",
              header: "Configured currency",
              render: (row) => (
                <span data-currency-configured="">
                  {row.configuredCurrency ? `${row.configuredCurrency} · configured` : "Not set"}
                </span>
              ),
            },
            {
              id: "open",
              header: "",
              render: (row) => (
                <Link
                  href={hrefFor(row.businessId)}
                  data-open-client={row.businessId}
                  data-ctl="live:AGENCY-04 open-client"
                  data-el="flow-a-direction-enter"
                  aria-label={`Open ${row.name}`}
                  style={{ color: "var(--ledger-accent-action)", textDecoration: "none", fontWeight: 700, whiteSpace: "nowrap" }}
                >
                  Open →
                </Link>
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
        Connection and freshness facts are Meta-specific. {AGENCY_CURRENCY_NOTE} {AGENCY_ACTIVITY_NOTE}
      </p>
    </section>
  );
}
