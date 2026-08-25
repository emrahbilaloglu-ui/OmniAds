"use client";

/**
 * The client boundary Meta History was missing.
 *
 * `HistoryView` has always drawn a server-side search box, an outcome filter, a
 * pager and a per-row Replay control — and the route is a server component, so
 * it could not hand any of them a function. Four of the surface's five declared
 * live controls therefore never rendered at all: the page printed "More exist
 * beyond this page" above a table with no way to ask for them, and every row's
 * Replay cell read "Not available".
 *
 * This owns only the state those controls need. The reads stay server-side
 * through `/api/meta/history`, which keeps its own access gate, so search still
 * queries the whole projection rather than filtering the loaded page — a
 * page-local search would answer "no matches" for a row two pages further on.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import type { HistoryDateWindow } from "@/lib/meta/history-date-window";
import { fetchMetaHistoryPage } from "@/lib/meta/history-client";
import {
  isMetaHistoryEntityType,
  isMetaHistoryKind,
  isMetaHistoryOutcomeFilter,
} from "@/lib/meta/history-contract";
import {
  toHistoryPage,
  type HistoryPage,
} from "@/lib/zero-base/meta/history-adapter";

const OUTCOME_ALL = "all";
/** The controls' word for "no filter". Never a member of either vocabulary. */
const FILTER_ALL = "all";

export function HistoryClient({
  businessId,
  providerAccountId,
  dateWindow,
  initialPage,
  pageLimit,
}: {
  businessId: string;
  providerAccountId: string;
  /**
   * The window the shell states, resolved ONCE on the server by
   * `lib/dashboard/date-window-url` and handed down verbatim.
   *
   * Every read this component issues — the debounced refetch, the return to
   * unfiltered defaults, and each "Load more" page — sends these same two
   * dates. They used to be sent as `from: null, to: null`, so the table
   * underneath a shell that said "Last 7 days" was the entire journal back to
   * the beginning of the account; changing the window changed the caption and
   * nothing else.
   *
   * It is a prop rather than a second URL read on purpose. A client-side
   * resolver would be a fourth reader of the same parameters, free to disagree
   * with the server about which days the rows on screen were read for — the
   * precise failure `date-window-url` exists to end.
   *
   * It is no longer nullable. A URL that states nothing usable resolves to the
   * shell's own default preset on the server and arrives here marked
   * `source: "default"`, which the view prints — so the journal is always read
   * for a window the operator can see, and never for "everything ever recorded"
   * underneath a chip naming four weeks.
   */
  dateWindow: HistoryDateWindow;
  initialPage: HistoryPage;
  pageLimit: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState(OUTCOME_ALL);
  /*
   * WP12 item 9. The read model has always parsed `kind` and `entity`, and
   * every caller passed `null`, so nine event families and eight entity types
   * arrived as one undifferentiated stream with no way to ask for one of them.
   * Both are server filters for the same reason `q` and `outcome` are: a
   * page-local filter answers "no matches" for a row two pages further on.
   */
  const [kindFilter, setKindFilter] = useState(FILTER_ALL);
  const [entityFilter, setEntityFilter] = useState(FILTER_ALL);
  const [failure, setFailure] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // A slow read must never be able to overwrite a newer one, or typing quickly
  // leaves the table showing results for a query the operator has moved past.
  const requestRef = useRef(0);

  // One comparable value for "which window these rows were read for". The
  // window is two strings, and comparing the object identity would re-read on
  // every render.
  const windowStart = dateWindow.start;
  const windowEnd = dateWindow.end;
  const windowKey = `${windowStart}..${windowEnd}`;

  const read = useCallback(
    async (input: {
      nextQuery: string;
      nextOutcome: string;
      nextKind: string;
      nextEntity: string;
      cursor: string | null;
      append: boolean;
    }) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      try {
        const payload = await fetchMetaHistoryPage({
          businessId,
          providerAccountId,
          filters: {
            kind: isMetaHistoryKind(input.nextKind) ? input.nextKind : null,
            entity: isMetaHistoryEntityType(input.nextEntity)
              ? input.nextEntity
              : null,
            label: null,
            // `outcome`, never `label`: they are different columns, and sending
            // "failed" as a label would silently match nothing.
            outcome: isMetaHistoryOutcomeFilter(input.nextOutcome)
              ? input.nextOutcome
              : null,
            // The stated window travels on every read, including each
            // "Load more" page: a cursor paged with no window would append
            // rows from outside the window onto rows read inside it, and one
            // table would then hold two different questions' answers.
            from: windowStart,
            to: windowEnd,
            q: input.nextQuery.trim() || null,
          },
          cursor: input.cursor,
          limit: pageLimit,
        });
        if (requestRef.current !== requestId) return;
        const next = toHistoryPage(payload);
        setFailure(null);
        setPage((current) =>
          input.append
            ? { ...next, rows: [...current.rows, ...next.rows] }
            : next,
        );
      } catch (error) {
        if (requestRef.current !== requestId) return;
        // The rows already on screen stay: they were really read, and blanking
        // them would hide the journal because one follow-up read failed.
        setFailure(
          error instanceof Error
            ? error.message
            : "The Meta journal could not be read.",
        );
      }
    },
    [businessId, pageLimit, providerAccountId, windowEnd, windowStart],
  );

  // What the rows on screen were actually read for. It starts at the defaults
  // because the server already delivered that exact page (page.tsx), so the
  // mount must not re-read it.
  const lastReadRef = useRef({
    query: "",
    outcome: OUTCOME_ALL,
    kind: FILTER_ALL,
    entity: FILTER_ALL,
    window: windowKey,
  });

  // Debounced so a typed word is one server read rather than one per keystroke.
  //
  // The skip compares against the last *read*, not against the defaults.
  // Guarding on "the filters are empty" meant clearing the search box, or
  // setting Outcome back to "all", returned without reading: the previous
  // filtered rows stayed on screen with no filter applied, so the table claimed
  // to be the whole journal while showing a search result — and the next
  // "Load more" paged an unfiltered cursor onto those filtered rows, mixing two
  // result sets in one table. A transition back to the default is a transition
  // like any other and must issue its own unfiltered read.
  //
  // The window is compared here too. When the shell moves the date range the
  // server re-renders this route and hands down a new `dateWindow`, but the
  // rows already in state were read for the previous one; without this the
  // table kept showing them, so the surface answered the old question under the
  // new caption. A window change is not typing, so it is not debounced — the
  // operator moved a control, and the rows on screen are known-stale until the
  // new read lands.
  useEffect(() => {
    if (
      lastReadRef.current.query === query &&
      lastReadRef.current.outcome === outcomeFilter &&
      lastReadRef.current.kind === kindFilter &&
      lastReadRef.current.entity === entityFilter &&
      lastReadRef.current.window === windowKey
    ) {
      return;
    }
    const windowChanged = lastReadRef.current.window !== windowKey;
    const timer = setTimeout(
      () => {
        lastReadRef.current = {
          query,
          outcome: outcomeFilter,
          kind: kindFilter,
          entity: entityFilter,
          window: windowKey,
        };
        void read({
          nextQuery: query,
          nextOutcome: outcomeFilter,
          nextKind: kindFilter,
          nextEntity: entityFilter,
          // Page one of the new window. Reusing the cursor would page into the
          // old window's result set.
          cursor: null,
          append: false,
        });
      },
      windowChanged ? 0 : 300,
    );
    return () => clearTimeout(timer);
  }, [entityFilter, kindFilter, outcomeFilter, query, read, windowKey]);

  const replayId = searchParams.get("replay");

  const setReplayParam = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("replay", id);
    else params.delete("replay");
    const search = params.toString();
    // `replace`, not `push`: opening evidence is a selection, not a step the
    // operator should have to press Back through.
    startTransition(() => {
      router.replace(`${pathname}${search ? `?${search}` : ""}`, {
        scroll: false,
      });
    });
  };

  return (
    <HistoryView
      rows={page.rows}
      // The same two dates every read above was issued with. Printing them is
      // what keeps a fallback window from being a silent one.
      dateWindow={dateWindow}
      disclosure={page.disclosure}
      limitations={
        failure ? [...page.limitations, failure] : page.limitations
      }
      accountLabel={page.accountLabel}
      query={query}
      onQueryChange={setQuery}
      outcomeFilter={outcomeFilter}
      onOutcomeFilterChange={setOutcomeFilter}
      kindFilter={kindFilter}
      onKindFilterChange={setKindFilter}
      entityFilter={entityFilter}
      onEntityFilterChange={setEntityFilter}
      onLoadMore={
        page.nextCursor
          ? () =>
              void read({
                nextQuery: query,
                nextOutcome: outcomeFilter,
                // Every filter travels on the "Load more" read too. A cursor
                // paged without them appends unfiltered rows onto filtered
                // ones, and one table then holds two questions' answers.
                nextKind: kindFilter,
                nextEntity: entityFilter,
                cursor: page.nextCursor,
                append: true,
              })
          : undefined
      }
      onReplay={setReplayParam}
      initialReplayId={replayId}
    />
  );
}
