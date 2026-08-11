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
}: {
  rows: readonly HistoryRow[];
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
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.metaHistory}</h1>
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

      {disclosure ? (
        <p data-history-disclosure="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {disclosure}
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

      <div style={{ marginTop: 16 }}>
        <DataTable
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
          ]}
        />
      </div>
    </div>
  );
}
