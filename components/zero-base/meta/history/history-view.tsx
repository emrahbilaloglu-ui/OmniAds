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
import { useState, type ReactNode } from "react";
import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import { actorLabel } from "@/lib/zero-base/meta/automation-posture";
import {
  moneyFactText,
  type HistoryRow,
} from "@/lib/zero-base/meta/history-adapter";
import type { HistoryDateWindow } from "@/lib/meta/history-date-window";
import {
  META_HISTORY_ENTITY_TYPES,
  META_HISTORY_KINDS,
} from "@/lib/meta/history-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import legacyStyles from "@/components/zero-base/legacy-workspace-interior.module.css";

export type { HistoryRow };

const HISTORY_LABELS: Record<string, string> = {
  all: "All",
  confirmed: "Confirmed",
  unsettled: "Needs review",
  verified_success: "Verified",
  silent_failure: "Needs review",
  unknown_outcome: "Needs review",
  validation_blocked: "Blocked",
  write_blocked: "Blocked",
  partially_succeeded: "Partially succeeded",
  label_flips: "Role changes",
  external_changes: "External changes",
  writes: "Changes",
  briefs: "Creative briefs",
  structures: "Structure changes",
  adset: "Ad set",
  creative_brief: "Creative brief",
  launch_intent: "Launch",
};

const REPLAY_NOTICE =
  "Some entries were reconstructed after the fact and may differ from the original state.";

function historyLabel(value: string): string {
  const known = HISTORY_LABELS[value];
  if (known) return known;
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function historyActorLabel(actor: string | null): string {
  return actor === "No human actor (engine)" ? "Automated" : actorLabel(actor);
}

export function HistoryView({
  rows,
  dateWindow,
  disclosure,
  limitations = [],
  accountLabel,
  unavailableReason,
  unavailableAction,
  query = "",
  onQueryChange,
  outcomeFilter = "all",
  onOutcomeFilterChange,
  kindFilter = "all",
  onKindFilterChange,
  entityFilter = "all",
  onEntityFilterChange,
  onLoadMore,
  onReplay,
  onClose,
  initialReplayId = null,
}: {
  rows: readonly HistoryRow[];
  /**
   * The two days these rows were read for, and where those days came from.
   *
   * IT IS PRINTED, and that is the point. The journal is bounded now for every
   * URL shape, including the ones that state no window — and a boundary the
   * operator cannot see is worse than no boundary at all, because entries are
   * missing and nothing on screen says why. When the window came from the URL
   * this line simply agrees with the chip above it; when it is the fallback, the
   * line says so in the same breath as the dates.
   *
   * Absent on the unavailable states and in the harnesses that render this view
   * without a route, where there is no window to name.
   */
  dateWindow?: HistoryDateWindow | null;
  /** Search is server-side against the history projection, not a local filter
   *  over the loaded page — a page-local search silently answers "no matches"
   *  for a row that exists two pages further on. */
  query?: string;
  onQueryChange?: (query: string) => void;
  outcomeFilter?: string;
  onOutcomeFilterChange?: (value: string) => void;
  /**
   * The event family and the entity type, both filtered on the SERVER.
   *
   * WP12 item 9 asks for kind and entity to reach the server, and until now
   * neither had a control at all: the read model parsed both and every caller
   * passed `null`, so nine event families arrived as one undifferentiated
   * stream. A page-local filter would have been worse than none — it answers
   * "no matches" for a row that exists two pages further on.
   */
  kindFilter?: string;
  onKindFilterChange?: (value: string) => void;
  entityFilter?: string;
  onEntityFilterChange?: (value: string) => void;
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
  /**
   * Rendered under an unavailable notice, and nowhere else.
   *
   * Some refusals are dead ends the operator can act on — "several accounts are
   * assigned, choose one" is a question, not a verdict — and the surface had no
   * way to offer the remedy beside the sentence that names it. When absent (the
   * resolved surface, and every refusal with no remedy) nothing at all is
   * rendered, so no state gains a control it did not have.
   */
  unavailableAction?: ReactNode;
}) {
  const t = useCopy();
  const copy = useCopy();
  const anyReplayed = rows.some((row) => row.replayed);
  const [replayId, setReplayId] = useState<string | null>(initialReplayId);
  const replayRow = rows.find((row) => row.id === replayId) ?? null;
  const visibleAccountLabel =
    accountLabel && !/^act_/i.test(accountLabel.trim()) ? accountLabel : null;

  if (unavailableReason) {
    return (
      <div
        data-history-surface=""
        data-screen-label="Meta · History"
        className={legacyStyles.workspace}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 700,
            lineHeight: "26px",
          }}
        >
          {copy.metaHistory}
        </h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
          {unavailableAction}
        </div>
      </div>
    );
  }

  return (
    <div
      data-history-surface=""
      data-history-layout=""
      data-screen-label="Meta · History"
      className={legacyStyles.workspace}
      style={{
        display: "grid",
        gridTemplateColumns: replayRow ? "minmax(0, 1fr) 360px" : "1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 20,
                fontWeight: 700,
                lineHeight: "26px",
              }}
            >
              {copy.metaHistory}
            </h1>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 12,
                color: "var(--ledger-ink-secondary)",
              }}
            >
              Changes and actions on this account.
            </p>
          </div>
          {onClose ? (
            <Button variant="secondary" data-ctl="live:close" onClick={onClose}>
              {copy.close}
            </Button>
          ) : null}
        </div>
        {visibleAccountLabel ? (
          <p
            data-history-account=""
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "var(--ledger-ink-tertiary)",
            }}
          >
            Account {visibleAccountLabel}
          </p>
        ) : null}

        {dateWindow ? (
          <p
            data-history-window=""
            data-history-window-source={dateWindow.source}
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "var(--ledger-ink-tertiary)",
            }}
          >
            {dateWindow.start} – {dateWindow.end}
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
            {REPLAY_NOTICE}
          </p>
        ) : null}
        {limitations.length > 0 ? (
          <p
            role="status"
            data-history-limitations=""
            style={{
              margin: "8px 0 0",
              padding: "8px 10px",
              borderRadius: "var(--ledger-radius-card)",
              border: "1px solid var(--ledger-semantic-warn)",
              fontSize: 12,
              lineHeight: "18px",
              color: "var(--ledger-semantic-warn)",
            }}
          >
            Some history details are unavailable. The entries shown may be
            incomplete.
          </p>
        ) : null}
        {onQueryChange ||
        onOutcomeFilterChange ||
        onKindFilterChange ||
        onEntityFilterChange ? (
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
              marginTop: 16,
            }}
          >
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
                  data-history-filter="outcome"
                  value={outcomeFilter}
                  onChange={(event) =>
                    onOutcomeFilterChange(event.target.value)
                  }
                  style={{ minHeight: 44, padding: "6px 8px" }}
                >
                  {["all", "confirmed", "failed", "unsettled"].map((value) => (
                    <option key={value} value={value}>
                      {historyLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {onKindFilterChange ? (
              <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
                {copy.eventFamily}
                <select
                  data-ctl="live:META-HIST-05 kind"
                  data-history-filter="kind"
                  value={kindFilter}
                  onChange={(event) => onKindFilterChange(event.target.value)}
                  style={{ minHeight: 44, padding: "6px 8px" }}
                >
                  {["all", ...META_HISTORY_KINDS].map((value) => (
                    <option key={value} value={value}>
                      {historyLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {onEntityFilterChange ? (
              <label style={{ fontSize: 12, display: "grid", gap: 4 }}>
                {copy.entity}
                <select
                  data-ctl="live:META-HIST-05 entity"
                  data-history-filter="entity"
                  value={entityFilter}
                  onChange={(event) => onEntityFilterChange(event.target.value)}
                  style={{ minHeight: 44, padding: "6px 8px" }}
                >
                  {["all", ...META_HISTORY_ENTITY_TYPES].map((value) => (
                    <option key={value} value={value}>
                      {historyLabel(value)}
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
              {
                id: "occurredAt",
                header: "When",
                render: (row) => row.occurredAt,
              },
              { id: "action", header: "Action", render: (row) => row.action },
              {
                id: "outcome",
                header: "Outcome",
                render: (row) => historyLabel(row.outcome),
              },
              {
                id: "actor",
                header: "Actor",
                render: (row) => (
                  <span
                    data-actor={row.id}
                    data-actor-known={row.actor ? "yes" : "no"}
                  >
                    {historyActorLabel(row.actor)}
                  </span>
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
                    <span
                      style={{
                        color: "var(--ledger-ink-tertiary)",
                        fontSize: 12,
                      }}
                    >
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
          <p
            data-history-disclosure=""
            data-el="history-gap"
            style={{
              margin: "8px 0 0",
              fontSize: 12,
              color: "var(--ledger-ink-tertiary)",
            }}
          >
            {disclosure}
          </p>
        ) : null}
      </div>
      {replayRow ? (
        <aside
          data-replay-drawer={replayRow.id}
          aria-label={`Replay — ${replayRow.action}`}
          style={{
            minHeight: 420,
            padding: 18,
            border: "1px solid var(--ledger-border-subtle)",
            borderRadius: "var(--ledger-radius-card)",
            background: "var(--ledger-bg-surface)",
            boxShadow:
              "-12px 0 30px color-mix(in srgb, var(--ledger-ink-primary) 8%, transparent)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "start",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--ledger-ink-tertiary)",
                }}
              >
                Replay
              </p>
              <h2 style={{ margin: "5px 0 0", fontSize: 16 }}>
                {replayRow.action}
              </h2>
            </div>
            <Button
              variant="quiet"
              data-ctl="live:close-replay"
              onClick={() => setReplayId(null)}
            >
              {copy.close}
            </Button>
          </div>
          <p
            style={{
              margin: "14px 0 0",
              padding: 10,
              border: "1px solid var(--ledger-semantic-warn)",
              borderRadius: "var(--ledger-radius-card)",
              fontSize: 12,
              lineHeight: "18px",
              color: "var(--ledger-semantic-warn)",
            }}
          >
            Historical view. It may differ from the account today.
          </p>
          <dl
            style={{
              margin: "16px 0 0",
              display: "grid",
              gap: 10,
              fontSize: 12,
            }}
          >
            <div>
              <dt style={{ color: "var(--ledger-ink-tertiary)" }}>
                {copy.observed}
              </dt>
              <dd style={{ margin: 0 }}>{replayRow.occurredAt}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--ledger-ink-tertiary)" }}>
                {copy.outcome}
              </dt>
              <dd style={{ margin: 0 }}>{historyLabel(replayRow.outcome)}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--ledger-ink-tertiary)" }}>
                {copy.actor}
              </dt>
              <dd style={{ margin: 0 }}>
                {historyActorLabel(replayRow.actor)}
              </dd>
            </div>
            {replayRow.summary ? (
              <div>
                <dt style={{ color: "var(--ledger-ink-tertiary)" }}>
                  {copy.summary}
                </dt>
                <dd data-replay-summary={replayRow.id} style={{ margin: 0 }}>
                  {replayRow.summary}
                </dd>
              </div>
            ) : null}
            {/* The served money facts, not re-derived ones. A budget change with
                no amounts is a budget change nobody can check. */}
            {(replayRow.money ?? []).map((fact) => (
              <div key={fact.label}>
                <dt style={{ color: "var(--ledger-ink-tertiary)" }}>
                  {fact.label}
                </dt>
                <dd data-replay-money={fact.label} style={{ margin: 0 }}>
                  {moneyFactText(fact)}
                </dd>
              </div>
            ))}
          </dl>
        </aside>
      ) : null}
      <style>{`@media(max-width:900px){[data-history-layout]{grid-template-columns:1fr!important}[data-replay-drawer]{min-height:0!important}}`}</style>
    </div>
  );
}
