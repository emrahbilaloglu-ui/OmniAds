"use client";

/**
 * Meta History (H19).
 *
 * Two honesty rules the design is explicit about:
 *
 * - a replayed window is permanently marked. Replayed rows were recomputed
 *   after the fact and did not drive the decisions taken at the time, so the
 *   banner is not dismissible — dismissing it would let a later reader treat a
 *   reconstruction as a contemporaneous record.
 * - an entry with no recorded actor says so. Attributing it to "System" is a
 *   claim about who acted, and the truth is that nobody knows.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { REPLAY_BANNER, actorLabel } from "@/lib/zero-base/meta/automation-posture";
import type { HistoryRow } from "@/lib/zero-base/meta/history-adapter";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export type { HistoryRow };

export function HistoryView({
  rows,
  disclosure,
  limitations,
  accountLabel,
  unavailableReason,
  query = "",
  onQueryChange,
  outcomeFilter = "all",
  onOutcomeFilterChange,
  onLoadMore,
  onReplay,
  onClose,
}: {
  rows: readonly HistoryRow[];
  /** Search is server-side against the history projection, not a local filter
   *  over the loaded page — a page-local search silently answers "no matches"
   *  for a row that exists two pages further on. */
  query?: string;
  onQueryChange?: (query: string) => void;
  outcomeFilter?: string;
  onOutcomeFilterChange?: (value: string) => void;
  /** Absent at the end of the projection. */
  onLoadMore?: () => void;
  onReplay?: (id: string) => void;
  /** Closes the history overlay; the selection stays in the URL. */
  onClose?: () => void;
  /** Names the page cap. Absence of a disclosure is never "this is everything". */
  disclosure?: string | null;
  limitations?: readonly string[];
  accountLabel?: string | null;
  unavailableReason?: string | null;
}) {
  const t = useCopy();
  const copy = useCopy();
  const anyReplayed = rows.some((row) => row.replayed);

  if (unavailableReason) {
    return (
      <div data-history-surface="">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.metaHistory}</h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }

  return (
    <div data-history-surface="">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.metaHistory}</h1>
        {onClose ? (
          <Button variant="secondary" data-ctl="live:close" onClick={onClose}>
            {copy.close}
          </Button>
        ) : null}
      </div>
      {accountLabel ? (
        <p data-history-account="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          Account {accountLabel}
        </p>
      ) : null}

      {anyReplayed ? (
        // No dismiss control: the caveat has to outlive the reader's attention.
        <p
          role="status"
          data-replay-banner=""
          data-el="replay-banner"
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: "var(--ledger-radius-card)",
            border: "1px solid var(--ledger-semantic-warn)",
            fontSize: 13,
            lineHeight: "19px",
            color: "var(--ledger-semantic-warn)",
          }}
        >
          {REPLAY_BANNER}
        </p>
      ) : null}


      {limitations && limitations.length > 0 ? (
        <ul data-history-limitations="" style={{ margin: "8px 0 0", paddingLeft: 16 }}>
          {limitations.map((item) => (
            <li key={item} style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {item}
            </li>
          ))}
        </ul>
      ) : null}

      {onQueryChange || onOutcomeFilterChange ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 16 }}>
          {onQueryChange ? (
            <div style={{ maxWidth: 280, flex: "1 1 220px" }}>
              <TextInput
                label={copy.searchHistory}
                data-ctl="live:META-HIST-05 search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                hint={copy.historySearchIsServerSide}
              />
            </div>
          ) : null}
      {disclosure ? (
        <p data-history-disclosure="" data-el="history-gap" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {disclosure}
        </p>
      ) : null}
          {onOutcomeFilterChange ? (
            <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
              {copy.outcome}
              <select
                data-ctl="live:META-HIST-05 filter"
                value={outcomeFilter}
                onChange={(event) => onOutcomeFilterChange(event.target.value)}
                style={{ minHeight: 44, padding: "6px 8px" }}
              >
                {["all", "confirmed", "failed", "unsettled"].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <DataTable
          collection="history"
          caption={copy.metaActionHistory}
          rows={[...rows]}
          rowKey={(row) => row.id}
          columns={[
            { id: "occurredAt", header: "When", render: (row) => row.occurredAt },
            { id: "action", header: "Action", render: (row) => row.action },
            { id: "outcome", header: "Outcome", render: (row) => row.outcome },
            {
              id: "actor",
              header: "Actor",
              render: (row) => (
                <span data-actor={row.id} data-actor-known={row.actor ? "yes" : "no"}>
                  {actorLabel(row.actor)}
                </span>
              ),
            },
            {
              id: "provenance",
              header: "Provenance",
              render: (row) =>
                row.replayed ? (
                  <span data-replayed={row.id} style={{ color: "var(--ledger-semantic-warn)" }}>
                    {t.replayed}
                  </span>
                ) : (
                  <span data-recorded={row.id}>{t.recordedAtTheTime}</span>
                ),
            },
            {
              id: "replay",
              header: "Replay",
              render: (row) =>
                onReplay ? (
                  <Button
                    variant="secondary"
                    data-ctl="live:META-HIST-06 replay"
                    onClick={() => onReplay(row.id)}
                  >
                    {t.replay}
                  </Button>
                ) : (
                  <span style={{ color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>
                    {t.notAvailable}
                  </span>
                ),
            },
          ]}
        />
        {onLoadMore ? (
          <Button
            variant="secondary"
            data-ctl="live:META-HIST-05 cursor"
            onClick={onLoadMore}
            style={{ marginTop: 8 }}
          >
            {copy.loadMore}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
