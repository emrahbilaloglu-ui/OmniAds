"use client";

import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Filter,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import {
  META_HISTORY_ENTITY_TYPES,
  META_HISTORY_KINDS,
  type MetaHistoryAccount,
  type MetaHistoryEntry,
  type MetaHistoryEntryStatus,
  type MetaHistoryResponse,
} from "@/lib/meta/history-contract";
import {
  fetchMetaHistoryAccounts,
  fetchMetaHistoryPage,
  type MetaHistoryClientFilters,
} from "@/lib/meta/history-client";
import { useAppStore } from "@/store/app-store";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import {
  DatePicker,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import styles from "./HistoryPage.module.css";

type HistoryMode = "journal" | "replay";

const EMPTY_FILTERS: MetaHistoryClientFilters = {
  kind: null,
  entity: null,
  label: null,
  from: null,
  to: null,
  q: null,
};

const KIND_LABELS = {
  decisions: "Decisions",
  writes: "Writes",
  responses: "Responses",
  label_flips: "Label flips",
  outcomes: "Outcomes",
  briefs: "Briefs",
  launches: "Launches",
  structures: "Structure inventory",
} as const;

const ENTITY_LABELS = {
  account: "Account",
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
  creative: "Creative",
  creative_brief: "Creative brief",
  launch_intent: "LaunchIntent",
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
  silent_failure: "Silent failure",
  unknown_outcome: "Unknown outcome",
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
  if (fact.availability === "currency_unavailable" || !fact.currency || fact.amount == null) {
    return `${fact.label}: unavailable - currency not persisted`;
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

export function HistoricalReplayChrome({
  date,
  engineVersions,
}: {
  date: string;
  engineVersions: string[];
}) {
  return (
    <section className={styles.replayChrome} aria-label="Historical Replay read-only mode">
      <div className={styles.replayIcon} aria-hidden="true">
        <History size={18} />
      </div>
      <div className={styles.replayCopy}>
        <strong>Historical Replay</strong>
        <span>
          {date} | {engineVersions.length > 0 ? engineVersions.join(" | ") : "persisted snapshots"} | actions disabled
        </span>
        <small>
          Persisted decision snapshots only. Live lanes, current provider status, and write controls are not reconstructed.
        </small>
      </div>
      <span className={styles.readOnlySeal}>
        <ShieldCheck size={14} aria-hidden="true" />
        read only
      </span>
    </section>
  );
}

function CorrelationState({ entry }: { entry: MetaHistoryEntry }) {
  if (entry.correlation.status === "keyed") {
    return (
      <span className={styles.keyedJoin}>
        Keyed join | {entry.correlation.key ?? "persisted key"}
      </span>
    );
  }
  if (entry.correlation.status === "unavailable") {
    return (
      <span className={styles.unavailableJoin}>
        Join unavailable | {entry.correlation.reason ?? "No persisted key is available."}
      </span>
    );
  }
  return <span className={styles.notApplicable}>Join not applicable</span>;
}

export function MetaHistoryEntries({
  entries,
  onOpenReplay,
}: {
  entries: MetaHistoryEntry[];
  onOpenReplay?: (date: string) => void;
}) {
  return (
    <div className={styles.journalList} role="list" aria-label="Meta journal entries">
      <div className={styles.listHeader} aria-hidden="true">
        <span>Time</span>
        <span>Kind</span>
        <span>Entity and event</span>
        <span>Status</span>
        <span>Actor</span>
        <span />
      </div>
      {entries.map((entry) => (
        <article className={styles.journalRow} role="listitem" key={entry.id}>
          <time className={styles.timestamp} dateTime={entry.occurredAt}>
            {formatDateTime(entry.occurredAt)}
          </time>
          <span className={`${styles.kindChip} ${styles[`kind_${entry.kind}`]}`}>
            {KIND_LABELS[entry.kind]}
          </span>
          <div className={styles.entryMain}>
            <div className={styles.entryTitleLine}>
              <strong title={entry.entity.name ?? entry.entity.id}>
                {entry.entity.name ?? entry.entity.id}
              </strong>
              <span>{ENTITY_LABELS[entry.entity.type]}</span>
              {entry.label ? <span>{humanize(entry.label)}</span> : null}
            </div>
            <p>{entry.title}</p>
            {entry.summary ? <small>{entry.summary}</small> : null}
          </div>
          <span className={`${styles.statusChip} ${statusTone(entry.status)}`}>
            {STATUS_LABELS[entry.status]}
          </span>
          <span className={styles.actor}>
            {entry.actor.availability === "available"
              ? entry.actor.name ?? entry.actor.id
              : entry.actor.availability === "unavailable"
                ? "Actor unavailable"
                : "System"}
          </span>
          <div className={styles.rowCommands}>
            {entry.replay && onOpenReplay ? (
              <button
                type="button"
                className={styles.iconTextButton}
                onClick={() => onOpenReplay(entry.replay?.date ?? "")}
                title={`Open Historical Replay for ${entry.replay.date}`}
              >
                <History size={14} aria-hidden="true" />
                Replay
              </button>
            ) : null}
          </div>
          <details className={styles.entryDetails}>
            <summary>Receipt and provenance</summary>
            <div className={styles.detailGrid}>
              <div>
                <span>Source</span>
                <strong>{entry.provenance.source}</strong>
              </div>
              <div>
                <span>Persisted ID</span>
                <strong>{entry.identity.sourceId}</strong>
              </div>
              <div>
                <span>Account scope</span>
                <strong>{humanize(entry.provenance.accountScopeBasis)}</strong>
              </div>
              <div>
                <span>Provenance</span>
                <strong>{humanize(entry.provenance.attribution)}</strong>
              </div>
            </div>
            <CorrelationState entry={entry} />
            {entry.money.length > 0 ? (
              <div className={styles.moneyFacts}>
                {entry.money.map((_, index) => (
                  <span key={`${entry.id}:money:${index}`}>{formatMoneyFact(entry, index)}</span>
                ))}
              </div>
            ) : null}
            <p className={styles.identityLimit}>{entry.identity.limitation}</p>
            {entry.detail ? (
              <pre className={styles.rawDetail}>{JSON.stringify(entry.detail, null, 2)}</pre>
            ) : null}
          </details>
        </article>
      ))}
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
  referenceDate,
}: {
  draft: MetaHistoryClientFilters;
  onChange: (next: MetaHistoryClientFilters) => void;
  onApply: () => void;
  onReset: () => void;
  referenceDate: string;
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
            onChange={(event) => onChange({ ...draft, q: event.target.value || null })}
            placeholder="Name, ID, event"
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
              kind: (event.target.value || null) as MetaHistoryClientFilters["kind"],
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
              entity: (event.target.value || null) as MetaHistoryClientFilters["entity"],
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
          onChange={(event) => onChange({ ...draft, label: event.target.value || null })}
        >
          <option value="">All labels</option>
          {LABEL_OPTIONS.map((label) => (
            <option key={label} value={label}>
              {humanize(label)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.datePickerField}>
        <DatePicker
          label="From"
          value={draft.from}
          maxDate={draft.to ?? referenceDate}
          referenceDate={referenceDate}
          onChange={(value) => onChange({ ...draft, from: value })}
          testId="meta-history-from-date"
          className="w-full"
        />
      </div>
      <div className={styles.datePickerField}>
        <DatePicker
          label="To"
          value={draft.to}
          minDate={draft.from ?? undefined}
          maxDate={referenceDate}
          referenceDate={referenceDate}
          onChange={(value) => onChange({ ...draft, to: value })}
          testId="meta-history-to-date"
          className="w-full"
          align="end"
        />
      </div>
      <div className={styles.filterCommands}>
        <button type="button" className={styles.secondaryButton} onClick={onReset}>
          <RotateCcw size={15} aria-hidden="true" />
          Reset
        </button>
        <button type="button" className={styles.primaryButton} onClick={onApply}>
          <Filter size={15} aria-hidden="true" />
          Apply
        </button>
      </div>
    </section>
  );
}

export default function MetaHistoryView() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;
  const [accounts, setAccounts] = useState<MetaHistoryAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [mode, setMode] = useState<HistoryMode>("journal");
  const [replayDate, setReplayDate] = useState(todayIsoDate);
  const [draftFilters, setDraftFilters] = useState<MetaHistoryClientFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<MetaHistoryClientFilters>(EMPTY_FILTERS);
  const [payload, setPayload] = useState<MetaHistoryResponse | null>(null);
  const [entries, setEntries] = useState<MetaHistoryEntry[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [newerPageCursors, setNewerPageCursors] = useState<Array<string | null>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!selectedBusinessId) {
      setAccounts([]);
      setSelectedAccountId("");
      return;
    }
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountsError(null);
    setAccounts([]);
    setSelectedAccountId("");
    fetchMetaHistoryAccounts({ businessId: selectedBusinessId, signal: controller.signal })
      .then((nextAccounts) => {
        if (controller.signal.aborted) return;
        setAccounts(nextAccounts);
        const search = new URLSearchParams(window.location.search);
        const requestedAccount = search.get("providerAccountId");
        const account =
          nextAccounts.find((item) => item.id === requestedAccount) ?? nextAccounts[0] ?? null;
        setSelectedAccountId(account?.id ?? "");
        const requestedMode = search.get("mode");
        const requestedReplayDate = search.get("replayDate");
        if (requestedMode === "replay" && /^\d{4}-\d{2}-\d{2}$/.test(requestedReplayDate ?? "")) {
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
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setAccountsError(
          requestError instanceof Error ? requestError.message : "Assigned accounts unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setAccountsLoading(false);
      });
    return () => controller.abort();
  }, [business?.timezone, selectedBusinessId]);

  const requestFilters = useMemo<MetaHistoryClientFilters>(
    () =>
      mode === "replay"
        ? {
            kind: "decisions",
            entity: null,
            label: null,
            from: replayDate,
            to: replayDate,
            q: null,
          }
        : filters,
    [filters, mode, replayDate],
  );

  useEffect(() => {
    if (!selectedBusinessId || !selectedAccountId) {
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
        setError(requestError instanceof Error ? requestError.message : "Meta History unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken, requestFilters, selectedAccountId, selectedBusinessId]);

  const loadOlder = useCallback(async () => {
    if (!selectedBusinessId || !selectedAccountId || !nextCursor || loadingMore) return;
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
      setError(requestError instanceof Error ? requestError.message : "Older entries unavailable.");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, pageCursor, requestFilters, selectedAccountId, selectedBusinessId]);

  const loadNewer = useCallback(async () => {
    if (!selectedBusinessId || !selectedAccountId || newerPageCursors.length === 0 || loadingMore) {
      return;
    }
    const requestedCursor = newerPageCursors[newerPageCursors.length - 1] ?? null;
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
      setError(requestError instanceof Error ? requestError.message : "Newer entries unavailable.");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, newerPageCursors, requestFilters, selectedAccountId, selectedBusinessId]);

  if (!selectedBusinessId || !business) return <BusinessEmptyState />;
  const decisionsHref = buildMetaScopedHref("/platforms/meta", {
    businessId: selectedBusinessId,
    providerAccountId: selectedAccountId,
  });

  const selectedAccount = accounts.find((item) => item.id === selectedAccountId) ?? null;
  const selectedAccountTimeZone = selectedAccount?.timezone || business?.timezone || "UTC";
  const selectedAccountReferenceDate = getTodayIsoForTimeZone(selectedAccountTimeZone);
  const historyState =
    accountsLoading || loading
      ? "loading"
      : accountsError || error
        ? "error"
        : selectedAccountId && payload
          ? "ready"
          : selectedAccountId
            ? "idle"
            : "account_required";
  const engineVersions = Array.from(
    new Set(
      entries
        .map((entry) => entry.replay?.engineVersion ?? null)
        .filter((value): value is string => Boolean(value)),
    ),
  );

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

  return (
    <main
      className={`${styles.page} ${mode === "replay" ? styles.replayPage : ""}`}
      data-testid="meta-history-page"
      data-history-state={historyState}
    >
      <header className={styles.pageHeader}>
        <div className={styles.breadcrumbs}>
          <Link href={decisionsHref}>Meta Decisions</Link>
          <span>/</span>
          <span>History</span>
        </div>
        <div className={styles.titleRow}>
          <div>
            <h1>Meta History</h1>
            <p>{business.name} | persisted decision and execution journal</p>
          </div>
          <span className={styles.authBadge}>
            <ShieldCheck size={14} aria-hidden="true" />
            authenticated | read only
          </span>
        </div>
        <div className={styles.scopeRow}>
          <div className={styles.scopeIdentity}>
            <Database size={16} aria-hidden="true" />
            <span>
              <small>Business</small>
              <strong>{business.name}</strong>
            </span>
          </div>
          <label className={styles.accountField}>
            <span>Meta account</span>
            <select
              aria-label="Meta account for History"
              value={selectedAccountId}
              disabled={accountsLoading || accounts.length === 0}
              onChange={(event) => {
                const accountId = event.target.value;
                const account = accounts.find((item) => item.id === accountId) ?? null;
                const accountToday = getTodayIsoForTimeZone(
                  account?.timezone || business?.timezone || "UTC",
                );
                const nextReplayDate = replayDate > accountToday ? accountToday : replayDate;
                setSelectedAccountId(accountId);
                if (nextReplayDate !== replayDate) setReplayDate(nextReplayDate);
                updateHistoryLocation({
                  mode,
                  providerAccountId: accountId,
                  replayDate: nextReplayDate,
                });
              }}
            >
              {accountsLoading ? <option value="">Loading assigned accounts</option> : null}
              {!accountsLoading && accounts.length === 0 ? (
                <option value="">No assigned Meta account</option>
              ) : null}
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.name ? `${account.name} | ${account.id}` : account.id}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.currencyScope}>
            <small>Currency scope</small>
            <strong>{selectedAccount?.currency ?? "Unavailable"}</strong>
          </div>
          <div className={styles.modeSwitch} aria-label="History mode">
            <button
              type="button"
              className={mode === "journal" ? styles.modeActive : ""}
              aria-pressed={mode === "journal"}
              onClick={() => changeMode("journal")}
            >
              <Archive size={15} aria-hidden="true" />
              Journal
            </button>
            <button
              type="button"
              className={mode === "replay" ? styles.modeActive : ""}
              aria-pressed={mode === "replay"}
              onClick={() => changeMode("replay")}
            >
              <History size={15} aria-hidden="true" />
              Historical Replay
            </button>
          </div>
        </div>
      </header>

      {accountsError ? (
        <section className={styles.errorBand} role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{accountsError}</span>
        </section>
      ) : null}

      {mode === "replay" ? (
        <>
          <HistoricalReplayChrome date={replayDate} engineVersions={engineVersions} />
          <section className={styles.replayControls} aria-label="Replay date">
            <DatePicker
              label="Snapshot date"
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
          referenceDate={selectedAccountReferenceDate}
          onApply={() => setFilters({ ...draftFilters })}
          onReset={() => {
            setDraftFilters(EMPTY_FILTERS);
            setFilters(EMPTY_FILTERS);
          }}
        />
      )}

      {payload ? (
        <details className={styles.limitations}>
          <summary>
            <AlertTriangle size={15} aria-hidden="true" />
            Identity and join limits
          </summary>
          <div>
            {payload.limitations.map((limitation) => (
              <p key={limitation.code}>{limitation.message}</p>
            ))}
          </div>
        </details>
      ) : null}

      <section className={styles.journalSection} aria-labelledby="history-results-title">
        <div className={styles.resultsHeader}>
          <div>
            <h2 id="history-results-title">
              {mode === "replay" ? `Snapshots | ${replayDate}` : "Journal"}
            </h2>
            <p>
              {selectedAccount
                ? `${selectedAccount.name ?? selectedAccount.id} | ${selectedAccount.id}`
                : "Select an assigned Meta account"}
            </p>
          </div>
          {payload ? (
            <span className={styles.resultCount}>
              {payload.page.returned} shown · {payload.page.nextCursor ? "more available" : "end of results"} · page {newerPageCursors.length + 1}
            </span>
          ) : null}
        </div>

        {loading ? <LoadingRows /> : null}
        {!loading && error ? (
          <div className={styles.errorState} role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>Meta History unavailable</strong>
              <p>{error}</p>
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
        {!loading && !error && selectedAccountId && entries.length === 0 ? (
          <div className={styles.emptyState}>
            <Clock3 size={22} aria-hidden="true" />
            <strong>
              {mode === "replay" ? "No persisted snapshot for this date" : "No journal entries match"}
            </strong>
            <p>
              {mode === "replay"
                ? "Replay does not compute missing history or reconstruct live state."
                : "The selected account and filters returned no keyed persisted rows."}
            </p>
          </div>
        ) : null}
        {!loading && entries.length > 0 ? (
          <MetaHistoryEntries entries={entries} onOpenReplay={openReplay} />
        ) : null}
        {!loading && !error && (nextCursor || newerPageCursors.length > 0) ? (
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
              {loadingMore ? <RefreshCw className={styles.spin} size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
              {loadingMore ? "Loading" : "Older"}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
