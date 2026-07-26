import { createHash } from "node:crypto";
import { getDbWithTimeout } from "@/lib/db";

/**
 * Bounded, deterministic, restartable DRY-RUN planner for legacy raw-snapshot
 * cleanup.
 *
 * Two legacy populations exist that the two-layer model cannot reach:
 *  - Meta rows written before the model with no `content_key` AND no
 *    `partition_id`. Retention's legacy branch needs a terminal partition to
 *    attribute a row to, so these are unreachable and would never age out.
 *  - Shopify rows written before the model whose payload is byte-identical to
 *    another legacy row. The content identity that would have collapsed them
 *    did not exist yet.
 *
 * ── Why this module cannot delete ──────────────────────────────────────────
 *
 * It ships NO execution path. There is no delete, no update, no truncate, and
 * no function that performs one — not behind a flag, an env var, a CLI switch,
 * a config key or a cast. `planLegacyCleanup` issues SELECTs only. Deleting
 * would require adding new code, which is a reviewed change rather than a
 * runtime decision.
 *
 * `LegacyCleanupExecutionAuthority` exists so that any FUTURE execution path
 * has one, and only one, way to be entered: an authority value. That value
 * carries a module-private symbol, so it cannot be constructed by an object
 * literal, parsed from JSON, cast from config, or forged by any caller — the
 * type is uninhabitable outside this file. `authorizeLegacyCleanupExecution`
 * is its sole producer, and it refuses unless every receipt verifies exactly
 * against the live database.
 */

const AUTHORITY_BRAND: unique symbol = Symbol("legacy-cleanup-execution-authority");

export const LEGACY_CLEANUP_PLAN_VERSION = "v1";

export type LegacyCleanupTarget = "meta_orphan_legacy" | "shopify_legacy_duplicate";

export interface LegacyCleanupCandidate {
  target: LegacyCleanupTarget;
  id: string;
  /** Stable sort key; also the resume cursor. */
  observedAt: string;
  payloadHash: string;
  /** Why this row is a candidate, in the planner's own words. */
  rationale: string;
}

export interface LegacyCleanupPlan {
  planVersion: string;
  target: LegacyCleanupTarget;
  /** Rows are only considered if strictly older than this. */
  cutoff: string;
  batchSize: number;
  candidates: LegacyCleanupCandidate[];
  /** Pass back as `resumeAfter` to continue; null when the plan is exhausted. */
  nextCursor: { observedAt: string; id: string } | null;
  /**
   * Digest of exactly this plan's inputs and outputs. Any change to the
   * cutoff, ordering, batch, or candidate set produces a different digest, so a
   * receipt bound to one plan cannot authorise another.
   */
  planDigest: string;
  /** Always true. There is no other mode. */
  dryRun: true;
}

export interface DatabaseFingerprint {
  /** Datname + system identifier: which database this literally is. */
  databaseIdentity: string;
  /** Digest over the catalog shape of the tables the plan touches. */
  schemaDigest: string;
  /** Digest over the candidate data itself. */
  dataFingerprint: string;
}

function digest(parts: readonly string[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    // Unit separator: without it, ("ab","c") and ("a","bc") would hash the
    // same, and a receipt bound to one plan could authorise another.
    hash.update(String.fromCharCode(0x1f));
  }
  return hash.digest("hex");
}

/**
 * Candidate SQL, held as constants so the tests can assert what the planner
 * reads, and so a reviewer can see there is no mutation anywhere in the module.
 */
export const META_ORPHAN_LEGACY_CANDIDATE_SQL = `
  SELECT
    snapshot.id::text AS id,
    snapshot.fetched_at::text AS observed_at,
    snapshot.payload_hash
  FROM meta_raw_snapshots snapshot
  WHERE snapshot.content_key IS NULL
    AND snapshot.partition_id IS NULL
    AND snapshot.fetched_at < $1::timestamptz
    AND NOT EXISTS (
      SELECT 1
      FROM meta_raw_snapshot_observations receipt
      WHERE receipt.snapshot_id = snapshot.id
    )
    AND ($2::timestamptz IS NULL OR (snapshot.fetched_at, snapshot.id) > ($2::timestamptz, $3::uuid))
  ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
  LIMIT $4`;

export const SHOPIFY_LEGACY_DUPLICATE_CANDIDATE_SQL = `
  SELECT
    snapshot.id::text AS id,
    snapshot.fetched_at::text AS observed_at,
    snapshot.payload_hash
  FROM shopify_raw_snapshots snapshot
  WHERE snapshot.content_key IS NULL
    AND snapshot.fetched_at < $1::timestamptz
    AND EXISTS (
      SELECT 1
      FROM shopify_raw_snapshots peer
      WHERE peer.content_key IS NULL
        AND peer.business_id = snapshot.business_id
        AND peer.provider_account_id = snapshot.provider_account_id
        AND peer.endpoint_name = snapshot.endpoint_name
        AND peer.entity_scope = snapshot.entity_scope
        AND peer.payload_hash = snapshot.payload_hash
        AND peer.start_date IS NOT DISTINCT FROM snapshot.start_date
        AND peer.end_date IS NOT DISTINCT FROM snapshot.end_date
        AND (peer.fetched_at, peer.id) < (snapshot.fetched_at, snapshot.id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shopify_raw_snapshot_observations receipt
      WHERE receipt.snapshot_id = snapshot.id
    )
    AND ($2::timestamptz IS NULL OR (snapshot.fetched_at, snapshot.id) > ($2::timestamptz, $3::uuid))
  ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
  LIMIT $4`;

const RATIONALE: Record<LegacyCleanupTarget, string> = {
  meta_orphan_legacy:
    "pre-model row with neither a content key nor a partition; retention's legacy branch cannot attribute it, so it never ages out",
  shopify_legacy_duplicate:
    "pre-model row whose payload is byte-identical to a strictly older pre-model row in the same scope",
};

/**
 * Produce one bounded batch of the plan.
 *
 * Deterministic: ordering is a total order on (fetched_at, id), so the same
 * database and cutoff always produce the same batch in the same sequence.
 * Restartable: pass the previous batch's `nextCursor` back as `resumeAfter`;
 * candidates already emitted are never revisited, and a plan interrupted at any
 * point resumes exactly where it stopped.
 */
export async function planLegacyCleanup(input: {
  target: LegacyCleanupTarget;
  cutoff: string;
  batchSize?: number;
  resumeAfter?: { observedAt: string; id: string } | null;
  timeoutMs?: number;
}): Promise<LegacyCleanupPlan> {
  const batchSize = Math.max(1, Math.min(5_000, input.batchSize ?? 500));
  const sql = getDbWithTimeout(Math.max(1, Math.min(60_000, input.timeoutMs ?? 30_000)));
  const statement =
    input.target === "meta_orphan_legacy"
      ? META_ORPHAN_LEGACY_CANDIDATE_SQL
      : SHOPIFY_LEGACY_DUPLICATE_CANDIDATE_SQL;

  const rows = (await sql.query(statement, [
    input.cutoff,
    input.resumeAfter?.observedAt ?? null,
    input.resumeAfter?.id ?? null,
    batchSize,
  ])) as Array<{ id: string; observed_at: string; payload_hash: string }>;

  const candidates: LegacyCleanupCandidate[] = (Array.isArray(rows) ? rows : []).map(
    (row) => ({
      target: input.target,
      id: row.id,
      observedAt: row.observed_at,
      payloadHash: row.payload_hash,
      rationale: RATIONALE[input.target],
    }),
  );

  const last = candidates.at(-1) ?? null;
  return {
    planVersion: LEGACY_CLEANUP_PLAN_VERSION,
    target: input.target,
    cutoff: input.cutoff,
    batchSize,
    candidates,
    // Exhausted only when the batch came back short; a full batch may have more
    // behind it, so the cursor stays open.
    nextCursor:
      last && candidates.length === batchSize
        ? { observedAt: last.observedAt, id: last.id }
        : null,
    planDigest: digest([
      LEGACY_CLEANUP_PLAN_VERSION,
      input.target,
      input.cutoff,
      String(batchSize),
      input.resumeAfter?.observedAt ?? "",
      input.resumeAfter?.id ?? "",
      ...candidates.flatMap((candidate) => [
        candidate.id,
        candidate.observedAt,
        candidate.payloadHash,
      ]),
    ]),
    dryRun: true,
  };
}

/** Fingerprint the live database as it is right now, for receipt binding. */
export async function fingerprintDatabaseForPlan(input: {
  plan: LegacyCleanupPlan;
  timeoutMs?: number;
}): Promise<DatabaseFingerprint> {
  const sql = getDbWithTimeout(Math.max(1, Math.min(60_000, input.timeoutMs ?? 30_000)));
  const identityRows = (await sql.query(
    `SELECT current_database() AS datname,
            system_identifier::text AS system_identifier
     FROM pg_control_system()`,
  )) as Array<{ datname: string; system_identifier: string }>;
  const identity = identityRows[0];

  const catalogRows = (await sql.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])
     ORDER BY table_name, column_name`,
    [
      [
        "meta_raw_snapshots",
        "meta_raw_snapshot_observations",
        "shopify_raw_snapshots",
        "shopify_raw_snapshot_observations",
      ],
    ],
  )) as Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>;

  return {
    databaseIdentity: `${identity?.datname ?? ""}:${identity?.system_identifier ?? ""}`,
    schemaDigest: digest(
      (Array.isArray(catalogRows) ? catalogRows : []).map(
        (row) =>
          `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`,
      ),
    ),
    dataFingerprint: digest(
      input.plan.candidates.map(
        (candidate) => `${candidate.id}:${candidate.observedAt}:${candidate.payloadHash}`,
      ),
    ),
  };
}

export type LegacyCleanupReceiptKind =
  | "reader_equivalence"
  | "fk_pit_equivalence"
  | "restored_backup";

export interface LegacyCleanupReceipt {
  kind: LegacyCleanupReceiptKind;
  /** Which plan this receipt was produced for. */
  planDigest: string;
  /** Which cutoff the evidence was gathered against. */
  cutoff: string;
  databaseIdentity: string;
  schemaDigest: string;
  dataFingerprint: string;
  /** When the evidence was produced. Stale evidence is refused. */
  issuedAt: string;
  /**
   * For `restored_backup`: the identity of the ISOLATED restore the evidence
   * came from. It must not be the live database, or the "restored backup" claim
   * is circular.
   */
  isolatedDatabaseIdentity?: string;
}

export const REQUIRED_LEGACY_CLEANUP_RECEIPTS: readonly LegacyCleanupReceiptKind[] = [
  "reader_equivalence",
  "fk_pit_equivalence",
  "restored_backup",
];

/** How old evidence may be before it stops describing the live database. */
export const LEGACY_CLEANUP_RECEIPT_MAX_AGE_MS = 60 * 60_000;

export class LegacyCleanupAuthorityRefusal extends Error {
  readonly code = "LEGACY_CLEANUP_AUTHORITY_REFUSED";
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`legacy cleanup execution refused (${reasons.join(", ")})`);
    this.name = "LegacyCleanupAuthorityRefusal";
    this.reasons = reasons;
  }
}

/**
 * The only inhabitant of the execution-authority type.
 *
 * The brand is a module-private symbol, so this interface cannot be satisfied
 * by any value constructed outside this file — not an object literal, not
 * JSON.parse, not a config object, not a structural cast. That is the point:
 * authority is unrepresentable rather than merely checked.
 */
export interface LegacyCleanupExecutionAuthority {
  readonly [AUTHORITY_BRAND]: true;
  readonly planDigest: string;
  readonly verifiedAt: string;
}

/**
 * Verify every receipt against the live database and the exact plan.
 *
 * Refuses on: a missing receipt kind, a duplicate standing in for a missing
 * one, a digest/identity/fingerprint that does not match the live database, a
 * cutoff that does not match the plan, evidence older than the max age, and a
 * restored-backup receipt taken from the live database rather than an isolated
 * restore.
 *
 * Note what this function does NOT do: it does not delete anything, and there
 * is no function in this module that consumes its result to delete anything.
 * It exists so that a future execution path cannot be written without it.
 */
export function authorizeLegacyCleanupExecution(input: {
  plan: LegacyCleanupPlan;
  fingerprint: DatabaseFingerprint;
  receipts: readonly LegacyCleanupReceipt[];
  now: string;
}): LegacyCleanupExecutionAuthority {
  const reasons: string[] = [];
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) reasons.push("unparseable_now");

  for (const kind of REQUIRED_LEGACY_CLEANUP_RECEIPTS) {
    const matching = input.receipts.filter((receipt) => receipt.kind === kind);
    if (matching.length === 0) {
      reasons.push(`missing_receipt:${kind}`);
      continue;
    }
    if (matching.length > 1) {
      // Ambiguity is refused rather than resolved: picking one would let a
      // valid receipt mask an invalid duplicate.
      reasons.push(`ambiguous_receipt:${kind}`);
      continue;
    }
    const receipt = matching[0]!;
    if (receipt.planDigest !== input.plan.planDigest) {
      reasons.push(`plan_mismatch:${kind}`);
    }
    if (receipt.cutoff !== input.plan.cutoff) {
      reasons.push(`cutoff_mismatch:${kind}`);
    }
    if (receipt.databaseIdentity !== input.fingerprint.databaseIdentity) {
      reasons.push(`database_mismatch:${kind}`);
    }
    if (receipt.schemaDigest !== input.fingerprint.schemaDigest) {
      reasons.push(`schema_mismatch:${kind}`);
    }
    if (receipt.dataFingerprint !== input.fingerprint.dataFingerprint) {
      reasons.push(`data_mismatch:${kind}`);
    }
    const issuedMs = Date.parse(receipt.issuedAt);
    if (!Number.isFinite(issuedMs)) {
      reasons.push(`unparseable_issued_at:${kind}`);
    } else if (
      Number.isFinite(nowMs) &&
      (nowMs - issuedMs > LEGACY_CLEANUP_RECEIPT_MAX_AGE_MS || issuedMs > nowMs)
    ) {
      // Future-dated evidence is refused too: a clock skew that makes stale
      // evidence look fresh is the same failure.
      reasons.push(`stale_receipt:${kind}`);
    }
    if (kind === "restored_backup") {
      if (!receipt.isolatedDatabaseIdentity) {
        reasons.push("missing_isolated_restore_identity");
      } else if (receipt.isolatedDatabaseIdentity === input.fingerprint.databaseIdentity) {
        // Verifying the restore against the live database proves nothing about
        // the backup.
        reasons.push("restore_not_isolated");
      }
    }
  }

  if (reasons.length > 0) {
    throw new LegacyCleanupAuthorityRefusal([...new Set(reasons)].sort());
  }

  return {
    [AUTHORITY_BRAND]: true,
    planDigest: input.plan.planDigest,
    verifiedAt: input.now,
  };
}
