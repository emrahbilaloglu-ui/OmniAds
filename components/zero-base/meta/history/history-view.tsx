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
import { useState } from "react";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { REPLAY_BANNER, actorLabel } from "@/lib/zero-base/meta/automation-posture";
import type { HistoryRow } from "@/lib/zero-base/meta/history-adapter";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import legacyStyles from "@/components/zero-base/legacy-workspace-interior.module.css";

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
  initialReplayId = null,
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
  /** Opens the replay inspector for addressable evidence frames and deep links. */
  initialReplayId?: string | null;
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
  const [replayId, setReplayId] = useState<string | null>(initialReplayId);
  const replayRow = rows.find((row) => row.id === replayId) ?? null;

  if (unavailableReason) {
    return (
      <div data-history-surface="" className={legacyStyles.workspace}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.metaHistory}</h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }

  return (
    <div
      data-history-surface=""
      data-history-layout=""
      className={legacyStyles.workspace}
      style={{ display: "grid", gridTemplateColumns: replayRow ? "minmax(0, 1fr) 360px" : "1fr", gap: 16, alignItems: "start" }}
    >
      <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div><p style={{ margin: 0, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ledger-ink-tertiary)" }}>Meta workspace</p><h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.metaHistory}</h1><p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>Decision, workflow and provider-action journal.</p></div>
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
                    onClick={() => {
                      setReplayId(row.id);
                      onReplay(row.id);
                    }}
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
      {disclosure ? (
        <p data-history-disclosure="" data-el="history-gap" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {disclosure}
        </p>
      ) : null}
      </div>
      {replayRow ? (
        <aside
          data-replay-drawer={replayRow.id}
          aria-label={`Replay — ${replayRow.action}`}
          style={{ minHeight: 420, padding: 18, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", boxShadow: "-12px 0 30px color-mix(in srgb, var(--ledger-ink-primary) 8%, transparent)" }}
        >
          <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <p style={{ margin: 0, font: "12px/1.3 var(--font-mono, monospace)", color: "var(--ledger-ink-tertiary)" }}>REPLAY · DECISION SNAPSHOT</p>
              <h2 style={{ margin: "5px 0 0", fontSize: 16 }}>{replayRow.action}</h2>
            </div>
            <Button variant="quiet" data-ctl="live:close-replay" onClick={() => setReplayId(null)}>{copy.close}</Button>
          </div>
          <p style={{ margin: "14px 0 0", padding: 10, border: "1px solid var(--ledger-semantic-warn)", borderRadius: "var(--ledger-radius-card)", fontSize: 12, lineHeight: "18px", color: "var(--ledger-semantic-warn)" }}>
            Replay of a stored snapshot — not live state. It shows what the engine served then; it cannot reconstruct today&apos;s account.
          </p>
          <dl style={{ margin: "16px 0 0", display: "grid", gap: 10, fontSize: 12 }}>
            <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.observed}</dt><dd style={{ margin: 0 }}>{replayRow.occurredAt}</dd></div>
            <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.outcome}</dt><dd style={{ margin: 0 }}>{replayRow.outcome}</dd></div>
            <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.actor}</dt><dd style={{ margin: 0 }}>{actorLabel(replayRow.actor)}</dd></div>
            <div><dt style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.evidenceBasis}</dt><dd style={{ margin: 0 }}>{replayRow.replayed ? "Replayed projection; historical caveat applies." : "Recorded at the time."}</dd></div>
          </dl>
        </aside>
      ) : null}
      <style>{`@media(max-width:900px){[data-history-layout]{grid-template-columns:1fr!important}[data-replay-drawer]{min-height:0!important}}`}</style>
    </div>
  );
}
