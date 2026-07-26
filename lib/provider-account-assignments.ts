import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { getDb, runDbTransaction } from "@/lib/db";
import type { IntegrationProviderType } from "@/lib/integrations";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";

export interface ProviderAccountAssignmentRow {
  id: string;
  business_id: string;
  provider: IntegrationProviderType;
  account_ids: string[];
  created_at: string;
  updated_at: string;
}

export const PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES = [
  "business_provider_accounts",
  "provider_accounts",
] as const;

async function readAssignmentRowsByBusiness(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<ProviderAccountAssignmentRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      (ARRAY_AGG(bpa.id ORDER BY bpa.position, bpa.id))[1] AS id,
      bpa.business_id,
      bpa.provider,
      ARRAY_AGG(pa.external_account_id ORDER BY bpa.position, bpa.id) AS account_ids,
      MIN(bpa.created_at) AS created_at,
      MAX(bpa.updated_at) AS updated_at
    FROM business_provider_accounts bpa
    INNER JOIN provider_accounts pa
      ON pa.id = bpa.provider_account_ref_id
    WHERE bpa.business_id = ${businessId}
      AND bpa.provider = ${provider}
      AND bpa.is_selected
    GROUP BY bpa.business_id, bpa.provider
    LIMIT 1
  `) as Array<ProviderAccountAssignmentRow>;

  return rows[0] ?? null;
}

/**
 * Lock namespace for provider account selection.
 *
 * Two levels, taken in a fixed order so they compose with provider write
 * authority rather than deadlocking against it:
 *   1. provider-global, held SHARED by a per-business assignment and
 *      EXCLUSIVE by a provider-wide reset, so a reset happens entirely before
 *      or entirely after each assignment, never through the middle of one;
 *   2. business+provider, held EXCLUSIVE, so two concurrent replacements for
 *      the same business serialise.
 */
export const PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE = 0x50415353;

function buildProviderLockKey(provider: IntegrationProviderType) {
  return `provider_account_selection:${provider}`;
}

function buildBusinessLockKey(
  businessId: string,
  provider: IntegrationProviderType,
) {
  return `provider_account_selection:${provider}:${businessId}`;
}

/** Deterministic normalisation: trimmed, non-empty, de-duplicated, order kept. */
export function normalizeProviderAccountIds(
  accountIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of accountIds) {
    const accountId = String(raw ?? "").trim();
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    normalized.push(accountId);
  }
  return normalized;
}

export class ProviderAccountSelectionError extends Error {
  constructor(
    readonly code:
      | "identity_missing"
      | "identity_mismatch"
      | "readback_mismatch"
      | "connection_generation_changed"
      | "snapshot_revision_changed",
    message: string,
  ) {
    super(message);
    this.name = "ProviderAccountSelectionError";
  }
}

/**
 * The two facts a selection is authorised BY, captured as one pair.
 *
 * A selection is only as good as the evidence it was validated against, and that
 * evidence has two independent parts that can move independently: the credential
 * the accounts were reached with, and the discovery snapshot that listed them. A
 * reconnect moves the first; a refresh moves the second. Binding only one of
 * them leaves the other free to change underneath the write.
 *
 * Both are read in ONE statement so the pair describes a single instant. Reading
 * them one after the other would produce a generation from before a reconnect
 * paired with a snapshot from after it — a combination that never existed, and
 * one no later comparison can detect.
 */
export interface ProviderSelectionAuthority {
  /**
   * `connection_generation:status` — the same token shape
   * `readProviderConnectionGenerationToken` produces, so a caller can compare
   * this against a later read without translating between two spellings.
   */
  connectionGeneration: string | null;
  /**
   * `run_id:connection_fingerprint:accounts_hash` — the IMMUTABLE identity of
   * the discovery snapshot revision the selection was validated against.
   *
   * All three parts are needed. The run id alone survives an in-place refresh,
   * because the run row is upserted on (business_id, provider) rather than
   * replaced. The fingerprint alone is unchanged by a refresh under the same
   * credential that returns a different account list. The hash alone is
   * unchanged by a refresh under a DIFFERENT credential that happens to return
   * the same list — which is precisely the case where the accounts are the same
   * strings but the authority behind them is not.
   */
  snapshotRevision: string | null;
}

interface ProviderSelectionAuthorityRow {
  generation: string | null;
  status: string | null;
  snapshot_run_id: string | null;
  snapshot_connection_fingerprint: string | null;
  snapshot_accounts_hash: string | null;
}

function toSelectionAuthority(
  row: ProviderSelectionAuthorityRow | undefined,
): ProviderSelectionAuthority {
  if (!row) return { connectionGeneration: null, snapshotRevision: null };
  return {
    connectionGeneration: `${row.generation}:${row.status}`,
    // A business with a connection but no discovery snapshot has no revision to
    // bind to, and `null` is what an equally snapshot-less later read produces.
    // Spelling it as a token of empty parts would instead compare equal to a
    // real revision whose parts happened to be NULL.
    snapshotRevision:
      row.snapshot_run_id == null
        ? null
        : `${row.snapshot_run_id}:${row.snapshot_connection_fingerprint ?? ""}:${row.snapshot_accounts_hash ?? ""}`,
  };
}

/**
 * Capture the authority a selection is about to be validated against.
 *
 * Called BEFORE validation, not after it. Capturing afterwards would leave the
 * validation itself unguarded: a reconnect or a snapshot refresh landing while
 * the account list was being checked would be invisible, because the captured
 * token would already describe the post-change state and match at write time.
 * Capturing first makes the guarded window cover validation too, so any change
 * anywhere between "we started deciding" and "we committed" refuses.
 *
 * Deliberately not error-tolerant. A caller that swallowed a failure here would
 * hand `null` to the writer, and `null` means "no expectation to enforce" — so a
 * transient database error would silently disable the very check this exists
 * for. The failure must reach the caller and become a refusal.
 */
export async function readProviderSelectionAuthority(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<ProviderSelectionAuthority> {
  const sql = getDb();
  const rows = (await sql`
    SELECT connection.connection_generation::text AS generation,
           connection.status AS status,
           run.id::text AS snapshot_run_id,
           run.connection_fingerprint AS snapshot_connection_fingerprint,
           run.accounts_hash AS snapshot_accounts_hash
    FROM provider_connections connection
    LEFT JOIN provider_account_snapshot_runs run
      ON run.business_id = connection.business_id
     AND run.provider = connection.provider
    WHERE connection.business_id = ${businessId}
      AND connection.provider = ${provider}
    LIMIT 1
  `) as Array<ProviderSelectionAuthorityRow>;
  return toSelectionAuthority(rows[0]);
}

/**
 * The same read, taken inside the write transaction with the connection row
 * LOCKED.
 *
 * Without `FOR UPDATE` the check was a snapshot read: it proved the connection
 * had not moved AT THE INSTANT OF THE READ and nothing more, so a reconnect
 * committing between that read and this transaction's commit still landed a
 * selection validated against a credential that no longer existed. The row lock
 * makes the reconnect wait for this transaction to end, which turns the check
 * into a guarantee that holds all the way to commit.
 *
 * `FOR UPDATE OF connection` names the connection alone: the snapshot run is on
 * the nullable side of the outer join, where PostgreSQL refuses to take a row
 * lock at all. The revision comparison does not need one — a snapshot
 * replacement that commits after this read is indistinguishable from one that
 * commits after this transaction, and both leave a selection that was validated
 * against the revision current when it was written.
 */
async function readLockedProviderSelectionAuthority(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<ProviderSelectionAuthority> {
  const sql = getDb();
  const rows = (await sql`
    SELECT connection.connection_generation::text AS generation,
           connection.status AS status,
           run.id::text AS snapshot_run_id,
           run.connection_fingerprint AS snapshot_connection_fingerprint,
           run.accounts_hash AS snapshot_accounts_hash
    FROM provider_connections connection
    LEFT JOIN provider_account_snapshot_runs run
      ON run.business_id = connection.business_id
     AND run.provider = connection.provider
    WHERE connection.business_id = ${businessId}
      AND connection.provider = ${provider}
    FOR UPDATE OF connection
  `) as Array<ProviderSelectionAuthorityRow>;
  return toSelectionAuthority(rows[0]);
}

/** The two selection locks, in the one order every selection writer takes them. */
async function takeProviderAccountSelectionLocks(
  businessId: string,
  provider: IntegrationProviderType,
): Promise<void> {
  const sql = getDb();
  await sql`
    SELECT pg_advisory_xact_lock_shared(
      ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
      hashtext(${buildProviderLockKey(provider)})
    )
  `;
  await sql`
    SELECT pg_advisory_xact_lock(
      ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
      hashtext(${buildBusinessLockKey(businessId, provider)})
    )
  `;
}

/**
 * Run `work` under the same business+provider selection lock
 * `replaceProviderAccountSelection` takes.
 *
 * The OAuth post-connect path reads the previous selection, asks the provider
 * which accounts the new grant can reach, intersects the two and writes the
 * result back. Only the final write was serialised against other selection
 * writers, so a selection saved by the user while that discovery was in flight
 * was read as "previous", intersected against an account list fetched before it
 * existed, and then overwritten — the user's choice silently reverted by a
 * reconnect they made seconds earlier.
 *
 * Wrapping the whole read-decide-write sequence in this helper makes the
 * concurrent selection wait for it, or it for the concurrent selection, instead
 * of the two interleaving.
 *
 * This grants no authority of its own: it takes locks and nothing else. Lane
 * admission, connection authority and snapshot validation remain the caller's
 * obligations.
 */
export async function withProviderAccountSelectionLock<T>(input: {
  businessId: string;
  provider: IntegrationProviderType;
  work: () => Promise<T>;
}): Promise<T> {
  return runDbTransaction(async () => {
    await takeProviderAccountSelectionLocks(input.businessId, input.provider);
    return input.work();
  });
}

export interface ProviderAccountSelectionOutcome {
  /** Exactly what is durably selected, in order, as read back in the same transaction. */
  accountIds: string[];
  /** The same in-transaction readback, shaped as the row callers report. */
  assignment: ProviderAccountAssignmentRow;
}

/**
 * Replaces the current selection for one business+provider.
 *
 * Identity bindings survive deselection: rows are never deleted, only marked
 * unselected, because many historical references treat a binding as immutable
 * identity. The whole operation runs in one transaction with an exact readback,
 * so a partial selection can never be observed or reported as success.
 */
export async function replaceProviderAccountSelection(input: {
  businessId: string;
  provider: IntegrationProviderType;
  accountIds: readonly string[];
  /**
   * The `connection_generation:status` the caller VALIDATED this selection
   * against.
   *
   * Validation reads the discovery snapshot to decide the accounts are
   * accessible, then this writes them. Between those two steps a reconnect can
   * replace the credential entirely — different principal, different accessible
   * accounts — and the write would commit a selection nobody validated against
   * the current connection. Checked INSIDE the same lock that serialises the
   * write, so there is no window between the check and the commit.
   */
  expectedConnectionGeneration?: string | null;
  /**
   * The discovery snapshot revision the caller VALIDATED this selection against,
   * from `readProviderSelectionAuthority`.
   *
   * The generation check alone left the other half of the evidence unguarded. A
   * refresh under the SAME credential — a revocation on the provider side, an
   * account moved to another business manager, a permission removed — replaces
   * the account list without touching the connection, so the generation still
   * matches and a selection validated against the superseded list commits
   * anyway. Checked inside the same lock as the generation, so both halves of
   * the evidence are proven current at the moment of the write.
   */
  expectedSnapshotRevision?: string | null;
}): Promise<ProviderAccountSelectionOutcome> {
  // Selection mutation changes what every other lane acts on, so it is quiesced
  // with them during a rollout rather than left writable underneath a migration.
  assertSyncLaneEnabled("assignment_mutation");
  const accountIds = normalizeProviderAccountIds(input.accountIds);
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const businessRefId = businessRefIds.get(input.businessId) ?? null;

  return runDbTransaction(async () => {
    const sql = getDb();
    await takeProviderAccountSelectionLocks(input.businessId, input.provider);

    if (
      input.expectedConnectionGeneration != null ||
      input.expectedSnapshotRevision != null
    ) {
      // Both expectations are answered by ONE locked read, before any write
      // statement runs. A refusal below therefore leaves the transaction with
      // nothing to roll back: zero bindings touched, zero identities created.
      const observed = await readLockedProviderSelectionAuthority(
        input.businessId,
        input.provider,
      );
      if (
        input.expectedConnectionGeneration != null &&
        observed.connectionGeneration !== input.expectedConnectionGeneration
      ) {
        throw new ProviderAccountSelectionError(
          "connection_generation_changed",
          `The ${input.provider} connection changed while this selection was being validated (expected ${input.expectedConnectionGeneration}, found ${observed.connectionGeneration ?? "none"}). Nothing was selected or scheduled.`,
        );
      }
      if (
        input.expectedSnapshotRevision != null &&
        observed.snapshotRevision !== input.expectedSnapshotRevision
      ) {
        throw new ProviderAccountSelectionError(
          "snapshot_revision_changed",
          `The ${input.provider} account list was replaced while this selection was being validated (expected revision ${input.expectedSnapshotRevision}, found ${observed.snapshotRevision ?? "none"}). Nothing was selected or scheduled.`,
        );
      }
    }

    if (accountIds.length > 0) {
      // Identity rows are created once and never rewritten. ORDER BY keeps
      // concurrent inserts of the same set in a stable order so two callers
      // cannot deadlock against each other.
      await sql`
        INSERT INTO provider_accounts (provider, external_account_id)
        SELECT ${input.provider}, account_id
        FROM unnest(${accountIds}::TEXT[]) AS account_id
        ORDER BY account_id
        ON CONFLICT (provider, external_account_id) DO NOTHING
      `;

      const identities = (await sql`
        SELECT id::text AS id, external_account_id
        FROM provider_accounts
        WHERE provider = ${input.provider}
          AND external_account_id = ANY(${accountIds}::TEXT[])
      `) as Array<{ id: string; external_account_id: string }>;
      if (identities.length !== accountIds.length) {
        const found = new Set(identities.map((row) => row.external_account_id));
        throw new ProviderAccountSelectionError(
          "identity_missing",
          `Provider account identity missing for: ${accountIds
            .filter((accountId) => !found.has(accountId))
            .join(", ")}`,
        );
      }

      // The binding upsert never rewrites provider_account_id: that column is
      // the physical identity a historical reference resolves through, and
      // changing it would silently re-point history at another account.
      await sql`
        INSERT INTO business_provider_accounts (
          business_id, business_ref_id, provider, provider_account_ref_id,
          provider_account_id, position, is_selected
        )
        SELECT
          ${input.businessId},
          ${businessRefId},
          ${input.provider},
          pa.id,
          pa.external_account_id,
          account.ordinality - 1,
          TRUE
        FROM unnest(${accountIds}::TEXT[]) WITH ORDINALITY
          AS account(account_id, ordinality)
        INNER JOIN provider_accounts pa
          ON pa.provider = ${input.provider}
         AND pa.external_account_id = account.account_id
        ORDER BY pa.id
        ON CONFLICT (business_id, provider, provider_account_ref_id) DO UPDATE SET
          business_ref_id = COALESCE(
            business_provider_accounts.business_ref_id,
            EXCLUDED.business_ref_id
          ),
          position = EXCLUDED.position,
          is_selected = TRUE,
          updated_at = now()
      `;
    }

    // Deselect, never delete.
    await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE, updated_at = now()
      WHERE business_id = ${input.businessId}
        AND provider = ${input.provider}
        AND is_selected
        AND NOT (provider_account_id = ANY(${accountIds}::TEXT[]))
    `;

    // Physical identity, verified in-transaction on exactly the four parts that
    // define it: business, provider, the binding's ref id, and the external
    // account id that ref id resolves to. The upsert arbitrates on
    // (business_id, provider, provider_account_ref_id) only, so an existing row
    // whose provider_account_id no longer matches what its ref id resolves to
    // would survive DO UPDATE untouched — and every historical reference
    // resolving through that binding would silently point at another account.
    const mismatched = (await sql`
      SELECT bpa.provider_account_id AS bound_account_id,
             pa.external_account_id AS identity_account_id
      FROM business_provider_accounts bpa
      INNER JOIN provider_accounts pa
        ON pa.id = bpa.provider_account_ref_id
      WHERE bpa.business_id = ${input.businessId}
        AND bpa.provider = ${input.provider}
        AND bpa.is_selected
        AND (pa.provider <> ${input.provider}
             OR pa.external_account_id IS DISTINCT FROM bpa.provider_account_id)
    `) as Array<{ bound_account_id: string; identity_account_id: string }>;
    if (mismatched.length > 0) {
      throw new ProviderAccountSelectionError(
        "identity_mismatch",
        `Selected bindings do not match their provider account identity: ${mismatched
          .map(
            (row) =>
              `${row.bound_account_id} bound to identity ${row.identity_account_id}`,
          )
          .join(", ")}`,
      );
    }

    // Exact readback inside the same transaction, and the ONLY reading of the
    // selection this operation reports from.
    //
    // The wrapper used to discard this and re-read outside the transaction. That
    // second read is a different fact: it sees whatever is committed when it
    // runs, so a concurrent replacement landing between commit and re-read made
    // the response describe another request's selection while claiming to
    // describe this one. It also runs without the lock, so nothing even
    // serialises it. The row returned here is the row that was verified.
    const row = await readAssignmentRowsByBusiness(
      input.businessId,
      input.provider,
    );
    const selected = (row?.account_ids ?? []).map((accountId) => String(accountId));
    if (
      selected.length !== accountIds.length ||
      selected.some((accountId, index) => accountId !== accountIds[index])
    ) {
      throw new ProviderAccountSelectionError(
        "readback_mismatch",
        `Selection readback mismatch: expected [${accountIds.join(", ")}], got [${selected.join(", ")}]`,
      );
    }
    return {
      accountIds: selected,
      // An empty selection is a legitimate outcome, not a failure: the caller
      // deselected everything and the grouped reader returns no row for it.
      assignment: row ?? {
        id: "",
        business_id: input.businessId,
        provider: input.provider,
        account_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    };
  });
}

export async function upsertProviderAccountAssignments(params: {
  businessId: string;
  provider: IntegrationProviderType;
  accountIds: string[];
  expectedConnectionGeneration?: string | null;
  expectedSnapshotRevision?: string | null;
}): Promise<ProviderAccountAssignmentRow> {
  const outcome = await replaceProviderAccountSelection(params);
  return outcome.assignment;
}

export async function getProviderAccountAssignments(
  businessId: string,
  provider: IntegrationProviderType
): Promise<ProviderAccountAssignmentRow | null> {
  return readAssignmentRowsByBusiness(businessId, provider);
}

/**
 * Deselects every account for one business+provider while preserving the
 * historical binding rows.
 */
export async function clearProviderAccountAssignments(
  businessId: string,
  provider: IntegrationProviderType
): Promise<void> {
  await replaceProviderAccountSelection({
    businessId,
    provider,
    accountIds: [],
  });
}

/**
 * Deselects every account for a provider across all businesses. Takes the
 * provider-global lock EXCLUSIVE so it can never run through the middle of a
 * per-business assignment, which holds the same lock shared.
 */
export async function clearAllProviderAccountAssignmentsForProvider(
  provider: IntegrationProviderType
): Promise<void> {
  // The widest selection mutation there is: it deselects every account of a
  // provider across every business in one statement. It does not go through
  // replaceProviderAccountSelection, so it did not inherit that function's lane
  // admission — leaving the stated "no selection changes while the lane is off"
  // contract with a bypass. Guarded here whether or not a caller currently
  // reaches it, because the contract is about what is possible, not about what
  // is called today.
  assertSyncLaneEnabled("assignment_mutation");
  await runDbTransaction(async () => {
    const sql = getDb();
    await sql`
      SELECT pg_advisory_xact_lock(
        ${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
        hashtext(${buildProviderLockKey(provider)})
      )
    `;
    await sql`
      UPDATE business_provider_accounts
      SET is_selected = FALSE, updated_at = now()
      WHERE provider = ${provider}
        AND is_selected
    `;
  });
}
