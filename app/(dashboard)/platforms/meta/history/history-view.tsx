"use client";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Clock3,
  Filter,
  History,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import {
  META_HISTORY_ENTITY_TYPES,
  META_HISTORY_KINDS,
  type MetaHistoryAccount,
  type MetaHistoryHistoricalAccount,
  type MetaHistoryEntry,
  type MetaHistoryEntryStatus,
  type MetaHistoryResponse,
} from "@/lib/meta/history-contract";
import {
  fetchMetaHistoryAccountScopes,
  fetchMetaHistoryPage,
  type MetaHistoryClientFilters,
} from "@/lib/meta/history-client";
import {
  actionFor,
  actorFor,
  historyAccountLabel,
  historyEntityLabel,
  historyLabelFor,
  historySummaryFor,
} from "@/lib/zero-base/meta/history-adapter";
import { useAppStore } from "@/store/app-store";
import {
  DATE_WINDOW_END_PARAM,
  DATE_WINDOW_START_PARAM,
  resolveDateWindowFromParams,
  type SearchParamsLike,
} from "@/lib/dashboard/date-window-url";
import { accountSwitchQuery } from "@/lib/dashboard/account-scope-url";
import {
  DatePicker,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import styles from "./HistoryPage.module.css";

type HistoryMode = "journal" | "replay";

export const META_HISTORY_PARTIAL_REASON =
  "Some history data is unavailable. Try again.";

const EMPTY_FILTERS: MetaHistoryClientFilters = {
  kind: null,
  entity: null,
  label: null,
  outcome: null,
  from: null,
  to: null,
  q: null,
};

/**
 * History uses the shell's reporting window while keeping its own journal
 * filters. The exact URL dates win, so the range shown in the top bar is the
 * range sent to the History API rather than a second, independently editable
 * pair of dates in the page body. Until the shell writes those exact dates,
 * History waits instead of expanding a preset against an account-local clock.
 */
export function historyFiltersForReportingWindow(
  filters: MetaHistoryClientFilters,
  searchParams: SearchParamsLike | null | undefined,
  referenceDate: string,
): MetaHistoryClientFilters | null {
  const start = searchParams?.get(DATE_WINDOW_START_PARAM)?.trim() ?? "";
  const end = searchParams?.get(DATE_WINDOW_END_PARAM)?.trim() ?? "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start > end
  ) {
    return null;
  }
  const resolvedWindow = resolveDateWindowFromParams(
    searchParams,
    referenceDate,
  );
  if (!resolvedWindow) return null;
  return {
    ...filters,
    from: resolvedWindow.start,
    to: resolvedWindow.end,
  };
}

const KIND_LABELS = {
  decisions: "Decisions",
  writes: "Changes",
  responses: "Action results",
  // Wire kind stays `label_flips` (persisted history compatibility); the
  // buyer-facing word is automatic-decision vocabulary — the manual
  // Test/Main label product is gone (D074/D074b), so the surface must not
  // advertise it (D078 R5).
  label_flips: "Decision transitions",
  outcomes: "Outcomes",
  briefs: "Briefs",
  launches: "Launches",
  structures: "Structure changes",
  external_changes: "External changes",
} as const;

const ENTITY_LABELS = {
  account: "Account",
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
  creative: "Creative",
  creative_brief: "Creative brief",
  launch_intent: "Launch",
  recommendation: "Recommendation",
} as const;

const LABEL_OPTIONS = [
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
] as const;

const STATUS_LABELS: Record<MetaHistoryEntryStatus, string> = {
  published: "Published",
  recorded: "Recorded",
  pending: "Pending",
  verified_success: "Verified",
  failed: "Failed",
  silent_failure: "Needs review",
  unknown_outcome: "Needs review",
  open: "Open",
  resolved: "Resolved",
  closed: "Closed",
  improved: "Improved",
  regressed: "Regressed",
  flat: "Flat",
  inconclusive: "Inconclusive",
  positive: "Positive",
  negative: "Negative",
  neutral: "Neutral",
  observed: "Observed",
  draft: "Draft",
  reviewed: "Reviewed",
  prepared: "Prepared",
  validation_blocked: "Validation blocked",
  write_blocked: "Write blocked",
  ready: "Ready",
  executing: "Executing",
  succeeded: "Succeeded",
  partially_succeeded: "Partially succeeded",
  unknown: "Unknown",
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function humanize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusTone(status: MetaHistoryEntryStatus) {
  if (
    status === "failed" ||
    status === "silent_failure" ||
    status === "negative" ||
    status === "write_blocked"
  ) {
    return styles.statusDanger;
  }
  if (
    status === "pending" ||
    status === "unknown_outcome" ||
    status === "inconclusive" ||
    status === "regressed" ||
    status === "validation_blocked" ||
    status === "executing" ||
    status === "partially_succeeded" ||
    status === "unknown"
  ) {
    return styles.statusCaution;
  }
  if (
    status === "verified_success" ||
    status === "improved" ||
    status === "positive" ||
    status === "resolved" ||
    status === "reviewed" ||
    status === "prepared" ||
    status === "ready" ||
    status === "succeeded"
  ) {
    return styles.statusPositive;
  }
  return styles.statusNeutral;
}

function formatMoneyFact(entry: MetaHistoryEntry, index: number) {
  const fact = entry.money[index];
  if (!fact) return null;
  if (
    fact.availability === "currency_unavailable" ||
    !fact.currency ||
    fact.amount == null
  ) {
    return `${fact.label}: currency unavailable`;
  }
  return `${fact.label}: ${new Intl.NumberFormat("en", {
    style: "currency",
    currency: fact.currency,
    maximumFractionDigits: 2,
  }).format(fact.amount)}`;
}

function updateHistoryLocation(input: {
  mode: HistoryMode;
  providerAccountId?: string | null;
  replayDate?: string | null;
}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("mode", input.mode);
  if (input.providerAccountId) {
    url.searchParams.set("providerAccountId", input.providerAccountId);
  }
  if (input.mode === "replay" && input.replayDate) {
    url.searchParams.set("replayDate", input.replayDate);
  } else {
    url.searchParams.delete("replayDate");
  }
  window.history.replaceState(null, "", url);
}

function updateHistoryAccountLocation(providerAccountId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.search = accountSwitchQuery(url.search, providerAccountId).toString();
  window.history.replaceState(null, "", url);
}

function historyAccountOptionLabel(
  account: MetaHistoryAccount | MetaHistoryHistoricalAccount,
): string {
  return `${historyAccountLabel(account)} · ID ${account.id}`;
}

export function HistoricalReplayChrome({
  date,
}: {
  date: string;
  engineVersions: string[];
}) {
  return (
    <section className={styles.replayChrome} aria-label="Past decisions">
      <div className={styles.replayIcon} aria-hidden="true">
        <History size={18} />
      </div>
      <div className={styles.replayCopy}>
        <strong>Past decisions</strong>
        <span>{date}</span>
        <small>Review decisions recorded on this date.</small>
      </div>
      <span className={styles.readOnlySeal}>Actions unavailable</span>
    </section>
  );
}

export function MetaHistoryEntries({
  entries,
  onOpenReplay,
}: {
  entries: MetaHistoryEntry[];
  onOpenReplay?: (date: string) => void;
}) {
  return (
    <div className={styles.journalList} role="list" aria-label="Meta activity">
      <div className={styles.listHeader} aria-hidden="true">
        <span>Time</span>
        <span>Type</span>
        <span>Activity</span>
        <span>Status</span>
        <span>By</span>
        <span />
      </div>
      {entries.map((entry) => {
        const summary = historySummaryFor(entry);
        const actor = actorFor(entry);
        const entityLabel = historyEntityLabel(entry);
        const label = historyLabelFor(entry);
        const entityType = ENTITY_LABELS[entry.entity.type];
        const showEntityType =
          entityLabel.toLowerCase() !== `unnamed ${entityType.toLowerCase()}`;
        const action = actionFor(entry);
        return (
          <article className={styles.journalRow} role="listitem" key={entry.id}>
            <time className={styles.timestamp} dateTime={entry.occurredAt}>
              {formatDateTime(entry.occurredAt)}
            </time>
            <span
              className={`${styles.kindChip} ${styles[`kind_${entry.kind}`]}`}
            >
              {KIND_LABELS[entry.kind]}
            </span>
            <div className={styles.entryMain}>
              <div className={styles.entryTitleLine}>
                <strong>{action}</strong>
                {showEntityType ? <span>{entityType}</span> : null}
                {label ? <span>{label}</span> : null}
              </div>
              {summary ? <small>{summary}</small> : null}
              {entry.money.length > 0 ? (
                <div className={styles.moneyFacts}>
                  {entry.money.map((_, index) => (
                    <span key={`${entry.id}:money:${index}`}>
                      {formatMoneyFact(entry, index)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <span
              className={`${styles.statusChip} ${statusTone(entry.status)}`}
            >
              {STATUS_LABELS[entry.status]}
            </span>
            <span className={styles.actor}>{actor ?? "Not recorded"}</span>
            <div className={styles.rowCommands}>
              {entry.replay && onOpenReplay ? (
                <button
                  type="button"
                  className={styles.iconTextButton}
                  onClick={() => onOpenReplay(entry.replay?.date ?? "")}
                  title={`Review decisions from ${entry.replay.date}`}
                >
                  <History size={14} aria-hidden="true" />
                  Review
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className={styles.loadingRows} aria-label="Loading Meta History">
      {Array.from({ length: 7 }, (_, index) => (
        <div className={styles.loadingRow} key={index}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function HistoryFilters({
  draft,
  onChange,
  onApply,
  onReset,
}: {
  draft: MetaHistoryClientFilters;
  onChange: (next: MetaHistoryClientFilters) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  return (
    <section className={styles.filterBand} aria-label="History filters">
      <label className={styles.searchField}>
        <span>Search</span>
        <div>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={draft.q ?? ""}
            onChange={(event) =>
              onChange({ ...draft, q: event.target.value || null })
            }
            placeholder="Campaign, ad or action"
          />
        </div>
      </label>
      <label>
        <span>Kind</span>
        <select
          value={draft.kind ?? ""}
          onChange={(event) =>
            onChange({
              ...draft,
              kind: (event.target.value ||
                null) as MetaHistoryClientFilters["kind"],
            })
          }
        >
          <option value="">All kinds</option>
          {META_HISTORY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Entity</span>
        <select
          value={draft.entity ?? ""}
          onChange={(event) =>
            onChange({
              ...draft,
              entity: (event.target.value ||
                null) as MetaHistoryClientFilters["entity"],
            })
          }
        >
          <option value="">All entities</option>
          {META_HISTORY_ENTITY_TYPES.map((entity) => (
            <option key={entity} value={entity}>
              {ENTITY_LABELS[entity]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Label</span>
        <select
          value={draft.label ?? ""}
          onChange={(event) =>
            onChange({ ...draft, label: event.target.value || null })
          }
        >
          <option value="">All labels</option>
          {LABEL_OPTIONS.map((label) => (
            <option key={label} value={label}>
              {humanize(label)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.filterCommands}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onReset}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Reset
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onApply}
        >
          <Filter size={15} aria-hidden="true" />
          Apply
        </button>
      </div>
    </section>
  );
}

export default function MetaHistoryView() {
  const searchParams = useSearchParams();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const business =
    businesses.find((item) => item.id === selectedBusinessId) ?? null;
  const [accounts, setAccounts] = useState<MetaHistoryAccount[]>([]);
  const [historicalAccounts, setHistoricalAccounts] = useState<
    MetaHistoryHistoricalAccount[] | null
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [mode, setMode] = useState<HistoryMode>("journal");
  const [replayDate, setReplayDate] = useState(todayIsoDate);
  const [draftFilters, setDraftFilters] =
    useState<MetaHistoryClientFilters>(EMPTY_FILTERS);
  const [filters, setFilters] =
    useState<MetaHistoryClientFilters>(EMPTY_FILTERS);
  const [payload, setPayload] = useState<MetaHistoryResponse | null>(null);
  const [entries, setEntries] = useState<MetaHistoryEntry[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [newerPageCursors, setNewerPageCursors] = useState<
    Array<string | null>
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const clearAccountBoundState = useCallback((referenceDate: string) => {
    setMode("journal");
    setReplayDate(referenceDate);
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPayload(null);
    setEntries([]);
    setPageCursor(null);
    setNewerPageCursors([]);
    setNextCursor(null);
    setLoading(false);
    setLoadingMore(false);
    setError(null);
  }, []);
  const selectedAccount =
    accounts.find((item) => item.id === selectedAccountId) ??
    (historicalAccounts ?? []).find((item) => item.id === selectedAccountId) ??
    null;
  const selectedHistoricalAccount =
    (historicalAccounts ?? []).find((item) => item.id === selectedAccountId) ??
    null;
  const requestedAccountUnavailable = Boolean(
    selectedAccountId && !selectedAccount,
  );
  const selectedAccountTimeZone =
    selectedAccount?.timezone || business?.timezone || "UTC";
  const selectedAccountReferenceDate = getTodayIsoForTimeZone(
    selectedAccountTimeZone,
  );
  const reportingQuery = searchParams?.toString() ?? "";
  const journalFilters = useMemo(
    () =>
      historyFiltersForReportingWindow(
        filters,
        new URLSearchParams(reportingQuery),
        selectedAccountReferenceDate,
      ),
    [filters, reportingQuery, selectedAccountReferenceDate],
  );
  const awaitingReportingWindow =
    mode === "journal" && Boolean(selectedAccountId) && !journalFilters;

  // Whole journal sources are dropped while their migrations are pending, and
  // the route says so in its limitations. A journal missing sources is
  // incomplete, not settled, so it must not read as the full record.
  const omittedSources =
    payload?.limitations.some(
      (limitation) => limitation.code === "optional_source_unavailable",
    ) ?? false;

  /**
   * A demo workspace records no provider-action journal, so its zero rows are
   * an absence of evidence rather than a measured zero. The route says so, but
   * saying it only inside the collapsed limits disclosure let the page render
   * "0 shown · end of results" and "No journal entries match" — the exact
   * false-zero claim the limitation exists to deny.
   */
  const demoJournalNotRecorded =
    payload?.limitations.find(
      (limitation) => limitation.code === "demo_journal_not_recorded",
    ) ?? null;

  // One freshness contract across every Tier-0 surface. Derived from the
  // state this surface already has, so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "meta_decisions",
    // A first read with nothing on screen is "we do not know yet"; a reload
    // with entries already shown is "checking for newer".
    // The assigned-accounts read decides whether the journal can be read at
    // all. Excluding it meant that when it failed the page showed "No accounts
    // assigned" while the bar said "ready" -- a configuration problem
    // presented as a settled fact.
    isLoading:
      (loading || accountsLoading || awaitingReportingWindow) && !payload,
    isFetching:
      loading || accountsLoading || loadingMore || awaitingReportingWindow,
    error: error ?? accountsError,
    // The journal is a cursor read, so the newest entry it served is the
    // honest as-of. Claiming "now" would report the age of the request rather
    // than the age of the record; measuredAsOf refuses anything that is not an
    // instant, so a malformed row leaves the age unknown instead of guessing.
    asOf: measuredAsOf(entries[0]?.occurredAt ?? null),
    businessId: payload?.scope.businessId ?? selectedBusinessId ?? null,
    partialReason: omittedSources ? META_HISTORY_PARTIAL_REASON : null,
    // The journal already knows how to re-read itself; without this the
    // surface named a terminal failure and offered no way out of it.
    onRetry: () => setReloadToken((value) => value + 1),
  });

  useEffect(() => {
    if (!selectedBusinessId) {
      setAccounts([]);
      setHistoricalAccounts([]);
      setSelectedAccountId("");
      clearAccountBoundState(todayIsoDate());
      return;
    }
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountsError(null);
    setAccounts([]);
    setHistoricalAccounts([]);
    setSelectedAccountId("");
    clearAccountBoundState(getTodayIsoForTimeZone(business?.timezone || "UTC"));
    fetchMetaHistoryAccountScopes({
      businessId: selectedBusinessId,
      signal: controller.signal,
    })
      .then(
        ({ accounts: nextAccounts, historicalAccounts: nextHistorical }) => {
          if (controller.signal.aborted) return;
          setAccounts(nextAccounts);
          setHistoricalAccounts(nextHistorical);
          const search = new URLSearchParams(window.location.search);
          const requestedAccount =
            search.get("providerAccountId")?.trim() || null;
          // A deep link may name a deselected historical scope; the picker
          // honours it read-only. When the historical read FAILED (null) the
          // requested id is still honoured — the journal endpoint answers
          // fail-closed unavailable rather than this view guessing.
          const account = requestedAccount
            ? (nextAccounts.find((item) => item.id === requestedAccount) ??
              (nextHistorical ?? []).find(
                (item) => item.id === requestedAccount,
              ) ??
              null)
            : nextAccounts.length === 1
              ? nextAccounts[0]!
              : null;
          const resolvedAccountId = requestedAccount ?? account?.id ?? "";
          setSelectedAccountId(resolvedAccountId);
          const requestedMode = search.get("mode");
          const requestedReplayDate = search.get("replayDate");
          if (
            resolvedAccountId &&
            requestedMode === "replay" &&
            /^\d{4}-\d{2}-\d{2}$/.test(requestedReplayDate ?? "")
          ) {
            const accountToday = getTodayIsoForTimeZone(
              account?.timezone || business?.timezone || "UTC",
            );
            setMode("replay");
            setReplayDate(
              (requestedReplayDate as string) > accountToday
                ? accountToday
                : (requestedReplayDate as string),
            );
          }
        },
      )
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setAccountsError(
          requestError instanceof Error
            ? requestError.message
            : "Assigned accounts unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setAccountsLoading(false);
      });
    return () => controller.abort();
  }, [business?.timezone, clearAccountBoundState, selectedBusinessId]);

  const requestFilters = useMemo<MetaHistoryClientFilters | null>(
    () =>
      mode === "replay"
        ? {
            kind: "decisions",
            entity: null,
            label: null,
            outcome: null,
            from: replayDate,
            to: replayDate,
            q: null,
          }
        : journalFilters,
    [journalFilters, mode, replayDate],
  );

  useEffect(() => {
    if (!selectedBusinessId || !selectedAccountId || !requestFilters) {
      setPayload(null);
      setEntries([]);
      setPageCursor(null);
      setNewerPageCursors([]);
      setNextCursor(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPageCursor(null);
    setNewerPageCursors([]);
    fetchMetaHistoryPage({
      businessId: selectedBusinessId,
      providerAccountId: selectedAccountId,
      filters: requestFilters,
      signal: controller.signal,
    })
      .then((nextPayload) => {
        if (controller.signal.aborted) return;
        setPayload(nextPayload);
        setEntries(nextPayload.entries);
        setNextCursor(nextPayload.page.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setEntries([]);
        setNextCursor(null);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Meta History unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken, requestFilters, selectedAccountId, selectedBusinessId]);

  const loadOlder = useCallback(async () => {
    if (
      !selectedBusinessId ||
      !selectedAccountId ||
      !requestFilters ||
      !nextCursor ||
      loadingMore
    )
      return;
    const requestedCursor = nextCursor;
    setLoadingMore(true);
    setError(null);
    try {
      const nextPayload = await fetchMetaHistoryPage({
        businessId: selectedBusinessId,
        providerAccountId: selectedAccountId,
        filters: requestFilters,
        cursor: requestedCursor,
      });
      setPayload(nextPayload);
      setEntries(nextPayload.entries);
      setNewerPageCursors((current) => [...current, pageCursor]);
      setPageCursor(requestedCursor);
      setNextCursor(nextPayload.page.nextCursor);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Older entries unavailable.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [
    loadingMore,
    nextCursor,
    pageCursor,
    requestFilters,
    selectedAccountId,
    selectedBusinessId,
  ]);

  const loadNewer = useCallback(async () => {
    if (
      !selectedBusinessId ||
      !selectedAccountId ||
      !requestFilters ||
      newerPageCursors.length === 0 ||
      loadingMore
    ) {
      return;
    }
    const requestedCursor =
      newerPageCursors[newerPageCursors.length - 1] ?? null;
    setLoadingMore(true);
    setError(null);
    try {
      const nextPayload = await fetchMetaHistoryPage({
        businessId: selectedBusinessId,
        providerAccountId: selectedAccountId,
        filters: requestFilters,
        cursor: requestedCursor ?? undefined,
      });
      setPayload(nextPayload);
      setEntries(nextPayload.entries);
      setNewerPageCursors((current) => current.slice(0, -1));
      setPageCursor(requestedCursor);
      setNextCursor(nextPayload.page.nextCursor);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Newer entries unavailable.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [
    loadingMore,
    newerPageCursors,
    requestFilters,
    selectedAccountId,
    selectedBusinessId,
  ]);

  if (!selectedBusinessId || !business) return <BusinessEmptyState />;
  const historyState =
    accountsLoading || loading
      ? "loading"
      : accountsError || error
        ? "error"
        : awaitingReportingWindow
          ? "loading"
          : selectedAccountId && payload
            ? "ready"
            : selectedAccountId
              ? "idle"
              : "account_required";
  const changeMode = (nextMode: HistoryMode) => {
    const nextReplayDate =
      replayDate > selectedAccountReferenceDate
        ? selectedAccountReferenceDate
        : replayDate;
    setMode(nextMode);
    setError(null);
    if (nextMode === "replay" && nextReplayDate !== replayDate) {
      setReplayDate(nextReplayDate);
    }
    updateHistoryLocation({
      mode: nextMode,
      providerAccountId: selectedAccountId,
      replayDate: nextReplayDate,
    });
  };

  const openReplay = (date: string) => {
    if (!date) return;
    setReplayDate(date);
    setMode("replay");
    updateHistoryLocation({
      mode: "replay",
      providerAccountId: selectedAccountId,
      replayDate: date,
    });
  };
  const changeAccount = (accountId: string) => {
    const account =
      accounts.find((item) => item.id === accountId) ??
      (historicalAccounts ?? []).find((item) => item.id === accountId) ??
      null;
    const accountToday = getTodayIsoForTimeZone(
      account?.timezone || business?.timezone || "UTC",
    );
    clearAccountBoundState(accountToday);
    setSelectedAccountId(accountId);
    updateHistoryAccountLocation(accountId);
  };
  const availableAccountCount =
    accounts.length + (historicalAccounts?.length ?? 0);

  return (
    <main
      className={`${styles.page} ${mode === "replay" ? styles.replayPage : ""}`}
      data-testid="meta-history-page"
      data-history-state={historyState}
    >
      <header className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <div>
            <h1>History</h1>
            <p>{business.name} · Meta decisions and changes</p>
          </div>
        </div>
        <div className={styles.scopeRow}>
          <label className={styles.accountField}>
            <span>Meta account</span>
            <select
              aria-label="Meta account for History"
              value={selectedAccountId}
              disabled={accountsLoading || Boolean(accountsError)}
              onChange={(event) => changeAccount(event.target.value)}
            >
              {accountsLoading ? (
                <option value="">Loading assigned accounts</option>
              ) : null}
              {!accountsLoading && accountsError ? (
                <option value="">Meta accounts unavailable</option>
              ) : null}
              {!accountsLoading &&
              !accountsError &&
              !selectedAccountId &&
              availableAccountCount > 0 ? (
                <option value="">Select account</option>
              ) : null}
              {!accountsLoading &&
              !accountsError &&
              accounts.length === 0 &&
              (historicalAccounts?.length ?? 0) === 0 ? (
                <option value="">No assigned Meta account</option>
              ) : null}
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {historyAccountOptionLabel(account)}
                </option>
              ))}
              {requestedAccountUnavailable ? (
                <option value={selectedAccountId}>
                  Requested account unavailable
                </option>
              ) : null}
              {historicalAccounts && historicalAccounts.length > 0 ? (
                <optgroup label="Past accounts">
                  {historicalAccounts.map((account) => (
                    <option value={account.id} key={account.id}>
                      {historyAccountOptionLabel(account) + " · past"}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            {selectedHistoricalAccount ? (
              <small
                data-testid="historical-account-scope-note"
                className={styles.historicalScopeNote}
              >
                This account is no longer assigned. Its past activity remains
                available here.
              </small>
            ) : null}
            {historicalAccounts === null ? (
              <small
                data-testid="historical-scope-unavailable"
                className={styles.historicalScopeNote}
                role="status"
              >
                Past account details are temporarily unavailable.
              </small>
            ) : null}
          </label>
          <div className={styles.modeSwitch} aria-label="History mode">
            <button
              type="button"
              className={mode === "journal" ? styles.modeActive : ""}
              aria-pressed={mode === "journal"}
              onClick={() => changeMode("journal")}
            >
              <Archive size={15} aria-hidden="true" />
              Activity
            </button>
            <button
              type="button"
              className={mode === "replay" ? styles.modeActive : ""}
              aria-pressed={mode === "replay"}
              onClick={() => changeMode("replay")}
            >
              <History size={15} aria-hidden="true" />
              Past decisions
            </button>
          </div>
        </div>
      </header>

      {accountsError ? (
        <section className={styles.errorBand} role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>Meta accounts are temporarily unavailable.</span>
        </section>
      ) : null}

      {mode === "replay" ? (
        <>
          <HistoricalReplayChrome date={replayDate} engineVersions={[]} />
          <section className={styles.replayControls} aria-label="Replay date">
            <DatePicker
              label="Date"
              value={replayDate}
              maxDate={selectedAccountReferenceDate}
              referenceDate={selectedAccountReferenceDate}
              allowClear={false}
              testId="meta-history-replay-date"
              align="end"
              className="w-full"
              onChange={(value) => {
                const date = value || selectedAccountReferenceDate;
                setReplayDate(date);
                updateHistoryLocation({
                  mode: "replay",
                  providerAccountId: selectedAccountId,
                  replayDate: date,
                });
              }}
            />
          </section>
        </>
      ) : (
        <HistoryFilters
          draft={draftFilters}
          onChange={setDraftFilters}
          onApply={() => setFilters({ ...draftFilters })}
          onReset={() => {
            setDraftFilters(EMPTY_FILTERS);
            setFilters(EMPTY_FILTERS);
          }}
        />
      )}

      <section
        className={styles.journalSection}
        aria-labelledby="history-results-title"
      >
        <div className={styles.resultsHeader}>
          <div>
            <h2 id="history-results-title">
              {mode === "replay"
                ? `Past decisions · ${replayDate}`
                : "Activity"}
            </h2>
          </div>
          {payload ? (
            <span className={styles.resultCount}>
              {payload.page.returned} shown
            </span>
          ) : null}
        </div>

        {loading || (awaitingReportingWindow && !accountsError && !error) ? (
          <LoadingRows />
        ) : null}
        {!loading && error ? (
          <div className={styles.errorState} role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>Meta History unavailable</strong>
              <p>History could not load. Please try again.</p>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : null}
        {!loading &&
        !accountsLoading &&
        !accountsError &&
        !selectedAccountId &&
        availableAccountCount > 0 ? (
          <div
            className={styles.emptyState}
            data-testid="history-account-required"
          >
            <Clock3 size={22} aria-hidden="true" />
            <strong>Select a Meta account</strong>
            <p>Choose an account above to view its history.</p>
          </div>
        ) : null}
        {!loading &&
        !awaitingReportingWindow &&
        !error &&
        selectedAccountId &&
        entries.length === 0 ? (
          <div
            className={styles.emptyState}
            role={demoJournalNotRecorded ? "status" : undefined}
          >
            <Clock3 size={22} aria-hidden="true" />
            <strong>
              {demoJournalNotRecorded
                ? "Demo activity is unavailable"
                : mode === "replay"
                  ? "No decisions for this date"
                  : "No activity matches"}
            </strong>
            <p>
              {demoJournalNotRecorded
                ? "This demo workspace does not record Meta activity."
                : mode === "replay"
                  ? "Choose another date to review past decisions."
                  : "Try another account or clear the filters."}
            </p>
          </div>
        ) : null}
        {!loading && !awaitingReportingWindow && entries.length > 0 ? (
          <MetaHistoryEntries entries={entries} onOpenReplay={openReplay} />
        ) : null}
        {!loading &&
        !awaitingReportingWindow &&
        !error &&
        (nextCursor || newerPageCursors.length > 0) ? (
          <div className={styles.loadMoreRow}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={loadingMore || newerPageCursors.length === 0}
              onClick={loadNewer}
            >
              <ChevronUp size={15} aria-hidden="true" />
              Newer
            </button>
            <span>Page {newerPageCursors.length + 1}</span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={loadingMore || !nextCursor}
              onClick={loadOlder}
            >
              {loadingMore ? (
                <RefreshCw
                  className={styles.spin}
                  size={15}
                  aria-hidden="true"
                />
              ) : (
                <ChevronDown size={15} aria-hidden="true" />
              )}
              {loadingMore ? "Loading" : "Older"}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
