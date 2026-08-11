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
import { REPLAY_BANNER, actorLabel } from "@/lib/zero-base/meta/automation-posture";

export interface HistoryRow {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actor: string | null;
  replayed: boolean;
}

export function HistoryView({ rows }: { rows: readonly HistoryRow[] }) {
  const anyReplayed = rows.some((row) => row.replayed);

  return (
    <div data-history-surface="">
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>Meta History</h1>

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

      <div style={{ marginTop: 16 }}>
        <DataTable
          caption="Meta action history"
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
                    Replayed
                  </span>
                ) : (
                  <span data-recorded={row.id}>Recorded at the time</span>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}
