/**
 * One pinned, read-only REPEATABLE READ snapshot for a historical replay.
 *
 * A replay that issues several statements through the pool gets a fresh
 * snapshot per statement: an anchor run, the ad-days it judges, the config
 * sources those ad-days resolve against and the persisted decisions it
 * compares can each describe a different moment of a database that the sync
 * jobs are writing to while the replay runs. Two of those reads are then
 * joined as if they were one fact.
 *
 * The caller must invoke this as the FIRST statement of a transaction
 * (`runDbTransaction` issues only BEGIN and a `SET LOCAL statement_timeout`
 * before its callback, and neither takes a snapshot). It then proves, rather
 * than assumes, that the transaction is repeatable read and read only, and
 * returns the snapshot identity so the receipt can name the one moment every
 * query in it read.
 */
export type SnapshotQuery = (
  text: string,
  values?: unknown[],
) => Promise<Array<Record<string, unknown>>>;

export interface PinnedReadOnlySnapshot {
  isolation: "repeatable read";
  transactionReadOnly: true;
  sessionDefaultReadOnly: true;
  /** `transaction_timestamp()`: the instant the transaction began. */
  transactionStartedAt: string;
  /** `txid_current_snapshot()`: the exact MVCC snapshot every read shares. */
  snapshotId: string;
}

export class ReadOnlySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlySnapshotError";
  }
}

function setting(rows: Array<Record<string, unknown>>, name: string): string {
  const row = rows[0] ?? {};
  return String(row[name] ?? row[name.toUpperCase()] ?? "").trim().toLowerCase();
}

export async function pinReadOnlySnapshot(
  query: SnapshotQuery,
): Promise<PinnedReadOnlySnapshot> {
  // Must precede every statement that takes a snapshot. SHOW does not.
  await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

  /*
    The session default is still required. It is what makes a statement
    issued OUTSIDE this transaction — a future edit that bypasses it — unable
    to write, and it is what the operator was told to set.
  */
  if (setting(await query("SHOW default_transaction_read_only"), "default_transaction_read_only") !== "on") {
    throw new ReadOnlySnapshotError(
      'this replay runs only in a read-only session. Start it with PGOPTIONS="-c default_transaction_read_only=on".',
    );
  }
  const isolation = setting(await query("SHOW transaction_isolation"), "transaction_isolation");
  if (isolation !== "repeatable read") {
    throw new ReadOnlySnapshotError(
      `the replay transaction is "${isolation || "unknown"}", not repeatable read; its reads would not share one snapshot.`,
    );
  }
  if (setting(await query("SHOW transaction_read_only"), "transaction_read_only") !== "on") {
    throw new ReadOnlySnapshotError("the replay transaction is not read only.");
  }

  // The first snapshot-taking statement: from here every read sees this moment.
  const [identity] = await query(
    "SELECT transaction_timestamp() AS started_at, txid_current_snapshot()::text AS snapshot_id",
  );
  const startedAt = identity?.started_at;
  const snapshotId = String(identity?.snapshot_id ?? "").trim();
  const startedMs =
    startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt ?? ""));
  if (!Number.isFinite(startedMs) || snapshotId === "") {
    throw new ReadOnlySnapshotError("could not read the pinned snapshot identity.");
  }
  return {
    isolation: "repeatable read",
    transactionReadOnly: true,
    sessionDefaultReadOnly: true,
    transactionStartedAt: new Date(startedMs).toISOString(),
    snapshotId,
  };
}
