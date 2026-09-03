// D077 — read-only readiness read model for the state-history growth-fence
// recovery. Server-owned and display-only: consumers (the admin readiness
// route and the business Automation page) render these facts verbatim. It
// never plans, never executes, never returns an approval token or anything
// executable, and a read failure is an explicit unavailable state — never an
// empty/ready-looking default.
import { stateHistoryBudgetBytes } from "@/lib/meta/state-history-compaction";
import {
  measureStateHistoryFence,
  type StateHistoryFenceMeasurement,
} from "@/lib/sync/state-history-effective-size";

// v3 (acceptance correction): journal-read provenance is explicit — a
// failed business-scoped journal read is UNKNOWN_JOURNAL_UNAVAILABLE with
// its own blocker, never an empty array presented as "NOT_EXECUTED".
export const STATE_HISTORY_COMPACTION_READINESS_CONTRACT =
  "d077.state-history-compaction-readiness.v3";

type ReadinessDb = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<T[]>;
};

export interface CompactionJournalEntry {
  event: string;
  planHash: string;
  rowsDeleted: number | null;
  createdAt: string | null;
}

export interface D075WriterEvidence {
  /**
   * Measured server-side, never assumed:
   *  - "observed": at least one observation run carries a manifest_kind —
   *    the delta-bounded writer has provably written here.
   *  - "not_observed": zero manifest_kind rows. This cannot distinguish
   *    "writer not deployed" from "no complete observation since deploy";
   *    it is reported as absence of evidence, not as a deployment claim.
   *  - "unknown": the measurement itself failed.
   */
  state: "observed" | "not_observed" | "unknown";
  detail: string;
}

export interface StateHistoryCompactionReadiness {
  contract: typeof STATE_HISTORY_COMPACTION_READINESS_CONTRACT;
  businessId: string;
  fence: StateHistoryFenceMeasurement | null;
  /**
   * UNKNOWN_JOURNAL_UNAVAILABLE means the journal read itself failed:
   * execution state is unreadable, which is NOT a claim that nothing
   * executed. NOT_EXECUTED is asserted only from a SUCCESSFUL empty
   * business-scoped read.
   */
  approvalStatus:
    | "EXECUTED_SEE_JOURNAL"
    | "NOT_EXECUTED"
    | "UNKNOWN_JOURNAL_UNAVAILABLE";
  /** Provenance of the journal read backing approvalStatus/latestJournal. */
  journalRead: "ok" | "unavailable";
  /** Business-scoped: only journal rows whose plan scope contains this
   * business (multi-business plans included). Never a global latest-N. */
  latestJournal: CompactionJournalEntry[];
  /** Populated only by an operator dry-run plan artifact; this read model
   * never plans, so a missing artifact is honestly unknown. */
  plannedReclaim: null;
  d075WriterEvidence: D075WriterEvidence;
  blockers: string[];
}

function toCountOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function measureD075WriterEvidence(
  db: ReadinessDb,
): Promise<D075WriterEvidence> {
  try {
    const rows = await db.query<{ observed: unknown }>(
      `SELECT EXISTS (
         SELECT 1 FROM meta_entity_observation_runs
         WHERE manifest_kind IS NOT NULL
       ) AS observed`,
    );
    const observed = rows[0]?.observed === true || rows[0]?.observed === "t";
    if (observed) {
      return {
        state: "observed",
        detail:
          "At least one observation run carries manifest_kind: the D075 delta-bounded writer has written to this database.",
      };
    }
    return {
      state: "not_observed",
      detail:
        "No observation run carries manifest_kind. The D075 delta-bounded writer has not been observed writing here; reclaimed space may refill at the pre-D075 full-manifest rate. This is absence of evidence, not a deployment assertion.",
    };
  } catch (error) {
    return {
      state: "unknown",
      detail: `d075_writer_evidence_measurement_failed:${String(error)}`,
    };
  }
}

export async function readStateHistoryCompactionReadiness(
  db: ReadinessDb,
  input: { businessId: string },
): Promise<StateHistoryCompactionReadiness> {
  const businessId = input.businessId.trim();
  try {
    if (!businessId) {
      throw new Error("businessId is required for compaction readiness.");
    }
    const fence = await measureStateHistoryFence(db, {
      budgetBytes: stateHistoryBudgetBytes(),
    });
    let journalRead: "ok" | "unavailable" = "ok";
    let journalRows: Array<{
      event: string;
      plan_hash: string;
      rows_deleted: unknown;
      created_at: unknown;
    }> = [];
    try {
      journalRows = await db.query<{
        event: string;
        plan_hash: string;
        rows_deleted: unknown;
        created_at: unknown;
      }>(
        `SELECT event, plan_hash, rows_deleted, created_at::text AS created_at
         FROM meta_state_history_compaction_journal
         WHERE $1 = ANY(business_ids)
         ORDER BY created_at DESC, id DESC LIMIT 5`,
        [businessId],
      );
    } catch {
      // Unreadable is NOT empty: record the provenance and refuse to state
      // any execution fact below.
      journalRead = "unavailable";
    }
    const latestJournal: CompactionJournalEntry[] = journalRows.map((row) => ({
      event: row.event,
      planHash: row.plan_hash,
      rowsDeleted: toCountOrNull(row.rows_deleted),
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    }));
    const executed = latestJournal.some(
      (row) =>
        row.event === "completed" || row.event === "completed_with_skips",
    );
    const approvalStatus =
      journalRead === "unavailable"
        ? ("UNKNOWN_JOURNAL_UNAVAILABLE" as const)
        : executed
          ? ("EXECUTED_SEE_JOURNAL" as const)
          : ("NOT_EXECUTED" as const);
    const d075WriterEvidence = await measureD075WriterEvidence(db);

    const blockers: string[] = [];
    if (fence.metric === "unavailable") {
      blockers.push("fence_measurement_unavailable");
    }
    if (fence.metric !== "effective_reusable_heap") {
      blockers.push(
        `free_space_proof_unavailable:${fence.fallbackReason ?? "unknown"} (operator: CREATE EXTENSION pgstattuple)`,
      );
    }
    if (fence.breachedEffective) {
      blockers.push("fence_breached_on_governing_metric");
    }
    blockers.push(
      "delete_alone_cannot_shrink_raw_size (operator: REINDEX CONCURRENTLY / pg_repack for physical byte return)",
    );
    if (journalRead === "unavailable") {
      blockers.push("compaction_journal_read_unavailable");
    }
    if (d075WriterEvidence.state === "not_observed") {
      blockers.push(
        "d075_writer_evidence_not_observed (no manifest_kind runs measured; reclaim may refill at the pre-D075 rate)",
      );
    } else if (d075WriterEvidence.state === "unknown") {
      blockers.push("d075_writer_evidence_unknown");
    }

    return {
      contract: STATE_HISTORY_COMPACTION_READINESS_CONTRACT,
      businessId,
      fence,
      approvalStatus,
      journalRead,
      latestJournal,
      plannedReclaim: null,
      d075WriterEvidence,
      blockers,
    };
  } catch (error) {
    return {
      contract: STATE_HISTORY_COMPACTION_READINESS_CONTRACT,
      businessId,
      fence: null,
      // Total read failure: execution state is unknown, not "not executed".
      approvalStatus: "UNKNOWN_JOURNAL_UNAVAILABLE",
      journalRead: "unavailable",
      latestJournal: [],
      plannedReclaim: null,
      d075WriterEvidence: {
        state: "unknown",
        detail: "readiness_read_failed",
      },
      blockers: [`readiness_read_failed:${String(error)}`],
    };
  }
}
