import { createHash } from "node:crypto";

import {
  reconcileCostComponents,
  type ReconcileCostComponentsResult,
} from "@/lib/commerce-cost/reconcile";
import { costStructureRevision } from "@/lib/commerce-cost/revision";
import { getDb, runDbTransaction } from "@/lib/db";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import type { CommerceCostStructure } from "@/src/types/commerce-cost";

/**
 * Storage for one business's declared commerce cost structure.
 *
 * Two tables: the current row, and an append-only history row per version.
 * Nothing here ever updates a history row, because a past day's profit was
 * computed from a past version — if a version could change meaning, no figure
 * this product has ever shown could be reproduced.
 *
 * Reads answer three different things and never merge them: a structure, `null`
 * for "this business has never stored one", and a thrown
 * `CostStructureSchemaUnavailableError` for "storage could not be read". The
 * third is not the second. An unreadable table reported as an empty one is how
 * a missing cost becomes a zero cost, and a zero cost is a profit.
 */

/** "CCST" -- the advisory-lock namespace this module owns. */
export const COMMERCE_COST_STRUCTURE_LOCK_NAMESPACE = 0x43435354;

/**
 * The concurrency token for "nothing is stored for this business".
 *
 * A read that finds no row still read something — it read absence — so it still
 * has a token to echo back, and a first save is checked exactly like any other.
 * The token is scoped to the business. A draft loaded for business A therefore
 * cannot pass the first-save check for business B, even while both stores are
 * empty.
 */
export function costStructureAbsentRevision(businessId: string): string {
  return createHash("sha256").update(`commerce-cost-absent:${businessId}`).digest("hex");
}

function normalizeExpectedRevision(expectedRevision: string, businessId: string): string | null {
  return expectedRevision === costStructureAbsentRevision(businessId) ? null : expectedRevision;
}

/** Read path. */
export const COMMERCE_COST_STRUCTURE_TABLES = ["business_commerce_cost_structures"] as const;

/** Write path: the current row and its history are written together or not at all. */
export const COMMERCE_COST_STRUCTURE_WRITE_TABLES = [
  ...COMMERCE_COST_STRUCTURE_TABLES,
  "business_commerce_cost_structure_history",
] as const;

function lockKey(businessId: string) {
  return `business_commerce_cost_structure:${businessId}`;
}

export interface StoredCostStructure {
  businessId: string;
  version: number;
  /** Canonical SHA-256 of the stored structure; the concurrency token. */
  revision: string;
  structure: CommerceCostStructure;
  recordedAt: string;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostStructureHistoryEntry {
  version: number;
  revision: string;
  effectiveFrom: string;
  recordedAt: string;
  updatedByUserId: string | null;
  origin: CommerceCostStructure["origin"];
  confirmed: boolean;
}

/**
 * Storage could not be read or written.
 *
 * Distinct from "nothing stored" on purpose: a caller that cannot tell these
 * apart will report an absent cost as a zero cost.
 */
export class CostStructureSchemaUnavailableError extends Error {
  readonly code = "COST_STRUCTURE_STORAGE_UNAVAILABLE";
  readonly missingTables: readonly string[];

  constructor(missingTables: readonly string[]) {
    super(
      `commerce cost structure storage is unavailable${
        missingTables.length > 0 ? ` (${missingTables.join(", ")})` : ""
      }`,
    );
    this.name = "CostStructureSchemaUnavailableError";
    this.missingTables = missingTables;
  }
}

/**
 * The caller's token does not describe what is stored now.
 *
 * `currentRevision` is always a token the caller can retry with, including
 * the business-scoped absent revision when the answer is "still nothing stored".
 */
export class CostStructureRevisionConflictError extends Error {
  readonly code = "commerce_cost_structure_changed";

  constructor(
    readonly currentRevision: string,
    readonly currentVersion: number,
  ) {
    super("The cost structure was changed by someone else.");
    this.name = "CostStructureRevisionConflictError";
  }
}

interface StoredRow {
  business_id: string;
  version: number | string;
  revision: string;
  structure: CommerceCostStructure | string;
  recorded_at: string;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseStructureColumn(value: CommerceCostStructure | string): CommerceCostStructure {
  return typeof value === "string" ? (JSON.parse(value) as CommerceCostStructure) : value;
}

function mapStoredRow(row: StoredRow): StoredCostStructure {
  return {
    businessId: row.business_id,
    version: Number(row.version),
    revision: row.revision,
    structure: parseStructureColumn(row.structure),
    recordedAt: row.recorded_at,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Turns every storage-absence signal into the one typed error.
 *
 * Called before `runDbTransaction`, never inside it: a readiness probe holding
 * an open transaction would hold the advisory lock while it waited.
 */
async function requireStorage(tables: readonly string[]) {
  const readiness = await getDbSchemaReadiness({ tables: [...tables] });
  if (!readiness.ready) {
    throw new CostStructureSchemaUnavailableError(readiness.missingTables);
  }
}

function asUnavailable(error: unknown, tables: readonly string[]): never {
  if (isMissingRelationError(error, [...tables])) {
    throw new CostStructureSchemaUnavailableError(tables);
  }
  throw error;
}

/**
 * The stored structure, or null when this business has never stored one.
 *
 * Throws `CostStructureSchemaUnavailableError` when storage cannot be read.
 */
export async function getStoredCostStructure(
  businessId: string,
): Promise<StoredCostStructure | null> {
  await requireStorage(COMMERCE_COST_STRUCTURE_TABLES);

  const sql = getDb();
  try {
    const rows = await sql<StoredRow>`
      /* commerce-cost-structure-read */
      SELECT business_id::text AS business_id,
             version,
             revision,
             structure,
             recorded_at,
             updated_by_user_id::text AS updated_by_user_id,
             created_at,
             updated_at
      FROM business_commerce_cost_structures
      WHERE business_id = ${businessId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    return row ? mapStoredRow(row) : null;
  } catch (error) {
    return asUnavailable(error, COMMERCE_COST_STRUCTURE_TABLES);
  }
}

export interface SaveCostStructureInput {
  businessId: string;
  /** Already sanitised at the HTTP boundary and domain-validated by the caller. */
  structure: CommerceCostStructure;
  /**
   * The revision the caller's last read returned. Mandatory: a write with no
   * token cannot detect that someone else already wrote. Either
   * `costStructureAbsentRevision(businessId)` asserts "that read found nothing
   * stored", which is a business-scoped claim checked like any other.
   */
  expectedRevision: string;
  /**
   * Transaction time for this version, stamped by the server.
   *
   * Passed in rather than computed here so that the structure and every
   * component in it carry the same instant: the HTTP boundary stamps components
   * as it sanitises them, and a second clock read here would leave the two
   * disagreeing by microseconds about when this version was recorded.
   */
  recordedAt: string;
  updatedByUserId: string | null;
}

export interface SaveCostStructureResult {
  stored: StoredCostStructure;
  /** The version this save superseded, or null for a first save. */
  previousVersion: number | null;
  /** What this save actually did to each component, from the reconciliation. */
  components: Omit<ReconcileCostComponentsResult, "components">;
}

/**
 * Writes the next version of a business's cost structure, atomically.
 *
 * The server owns `businessId`, `version` and `recordedAt`: whatever the caller
 * put in those fields is replaced, so a payload cannot claim a version it did
 * not earn or a business it does not belong to. The revision is computed from
 * the structure the server actually stores, not the one it was handed.
 *
 * Everything inside the transaction is a database statement. An HTTP call or a
 * slow computation in here would hold the advisory lock past
 * `idle_in_transaction_session_timeout` and have the lock taken away mid-write.
 */
export async function saveCostStructure(
  input: SaveCostStructureInput,
): Promise<SaveCostStructureResult> {
  await requireStorage(COMMERCE_COST_STRUCTURE_WRITE_TABLES);

  try {
    return await runDbTransaction(async () => {
      const sql = getDb();

      // First statement, before any read. Two operators saving at once would
      // otherwise both read version 4 and both compute version 5 -- and with no
      // current row yet, `FOR UPDATE` locks nothing, so the row-level lock
      // cannot serialise the first save either.
      await sql`
        SELECT pg_advisory_xact_lock(
          ${COMMERCE_COST_STRUCTURE_LOCK_NAMESPACE}::int,
          hashtext(${lockKey(input.businessId)})
        )
      `;

      const currentRows = await sql<{
        current_version: number | string | null;
        current_revision: string | null;
        current_structure: CommerceCostStructure | string | null;
        history_version: number | string | null;
      }>`
        /* commerce-cost-structure-current */
        WITH current_row AS MATERIALIZED (
          SELECT version, revision, structure
          FROM business_commerce_cost_structures
          WHERE business_id = ${input.businessId}::uuid
          FOR UPDATE
        )
        SELECT
          (SELECT version FROM current_row) AS current_version,
          (SELECT revision FROM current_row) AS current_revision,
          (SELECT structure FROM current_row) AS current_structure,
          (
            SELECT max(version)
            FROM business_commerce_cost_structure_history
            WHERE business_id = ${input.businessId}::uuid
          ) AS history_version
      `;

      const current = currentRows[0];
      const currentRevision = current?.current_revision ?? null;
      const currentVersion = current?.current_version == null ? 0 : Number(current.current_version);
      const historyVersion = current?.history_version == null ? 0 : Number(current.history_version);
      const currentStructure = current?.current_structure
        ? parseStructureColumn(current.current_structure)
        : null;

      if (currentRevision !== normalizeExpectedRevision(input.expectedRevision, input.businessId)) {
        throw new CostStructureRevisionConflictError(
          currentRevision ?? costStructureAbsentRevision(input.businessId),
          currentVersion,
        );
      }

      // Past the highest version either table has seen. If a current row were
      // ever removed without its history, restarting at 1 would collide with a
      // stored version -- which the unique index would refuse, but silently
      // reusing a version number is the thing to avoid, not just to detect.
      const version = Math.max(currentVersion, historyVersion) + 1;
      const recordedAt = input.recordedAt;

      // Reconciled here, inside the transaction and under the lock, against the
      // row that was just read FOR UPDATE. Doing it in the route against an
      // earlier read would decide "unchanged" from a state someone else has
      // since replaced, which is exactly the race the lock exists to prevent.
      const reconciled = reconcileCostComponents({
        previous: currentStructure?.components ?? null,
        next: input.structure.components,
        recordedAt,
        actorUserId: input.updatedByUserId,
      });

      const structure: CommerceCostStructure = {
        ...input.structure,
        businessId: input.businessId,
        version,
        recordedAt,
        // Saving through this path IS an operator declaring the structure, so
        // the origin is theirs. Without this, a first save of the legacy
        // preview would store `legacy_import` forever and the structure could
        // never become activatable however carefully it was confirmed. Where the
        // numbers came from is not lost: each component keeps its own `source`
        // and audit trail.
        origin: "operator",
        components: reconciled.components,
      };
      const revision = costStructureRevision(structure);
      const structureJson = JSON.stringify(structure);
      const businessRefId =
        (await resolveBusinessReferenceIds([input.businessId])).get(input.businessId) ?? null;

      // One statement carries both tables, so there is no ordering in which the
      // current row exists at a version the history cannot explain.
      const savedRows = await sql<StoredRow>`
        /* commerce-cost-structure-write */
        WITH saved AS (
          INSERT INTO business_commerce_cost_structures (
            business_id,
            business_ref_id,
            version,
            revision,
            origin,
            confirmed,
            structure,
            effective_from,
            recorded_at,
            updated_by_user_id,
            updated_at
          )
          VALUES (
            ${input.businessId}::uuid,
            ${businessRefId}::uuid,
            ${version},
            ${revision},
            ${structure.origin},
            ${structure.confirmed},
            ${structureJson}::jsonb,
            ${structure.effectiveFrom}::timestamptz,
            ${recordedAt}::timestamptz,
            ${input.updatedByUserId}::uuid,
            now()
          )
          ON CONFLICT (business_id)
          DO UPDATE SET
            business_ref_id = COALESCE(
              business_commerce_cost_structures.business_ref_id,
              EXCLUDED.business_ref_id
            ),
            version = EXCLUDED.version,
            revision = EXCLUDED.revision,
            origin = EXCLUDED.origin,
            confirmed = EXCLUDED.confirmed,
            structure = EXCLUDED.structure,
            effective_from = EXCLUDED.effective_from,
            recorded_at = EXCLUDED.recorded_at,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = now()
          RETURNING
            business_id,
            business_ref_id,
            version,
            revision,
            origin,
            confirmed,
            structure,
            effective_from,
            recorded_at,
            updated_by_user_id,
            created_at,
            updated_at
        ), history_write AS (
          INSERT INTO business_commerce_cost_structure_history (
            business_id,
            business_ref_id,
            version,
            revision,
            origin,
            confirmed,
            structure,
            effective_from,
            recorded_at,
            updated_by_user_id
          )
          SELECT
            saved.business_id,
            saved.business_ref_id,
            saved.version,
            saved.revision,
            saved.origin,
            saved.confirmed,
            saved.structure,
            saved.effective_from,
            saved.recorded_at,
            saved.updated_by_user_id
          FROM saved
          RETURNING business_id, version
        )
        SELECT
          saved.business_id::text AS business_id,
          saved.version,
          saved.revision,
          saved.structure,
          saved.recorded_at,
          saved.updated_by_user_id::text AS updated_by_user_id,
          saved.created_at,
          saved.updated_at
        FROM saved
        JOIN history_write ON history_write.business_id = saved.business_id
      `;

      const saved = savedRows[0];
      if (!saved) {
        throw new Error("commerce cost structure save wrote no row");
      }
      return {
        stored: mapStoredRow(saved),
        previousVersion: currentVersion > 0 ? currentVersion : null,
        components: {
          unchanged: reconciled.unchanged,
          changed: reconciled.changed,
          added: reconciled.added,
          removed: reconciled.removed,
          retired: reconciled.retired,
        },
      };
    });
  } catch (error) {
    if (error instanceof CostStructureRevisionConflictError) throw error;
    return asUnavailable(error, COMMERCE_COST_STRUCTURE_WRITE_TABLES);
  }
}

/**
 * Version history, newest first.
 *
 * Structures themselves are not returned: this answers "what happened and who
 * did it", and loading every stored blob to answer that would be wasteful.
 */
export async function listCostStructureHistory(input: {
  businessId: string;
  limit?: number;
}): Promise<CostStructureHistoryEntry[]> {
  await requireStorage(["business_commerce_cost_structure_history"]);

  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const sql = getDb();
  try {
    const rows = await sql<{
      version: number | string;
      revision: string;
      effective_from: string;
      recorded_at: string;
      updated_by_user_id: string | null;
      origin: CommerceCostStructure["origin"];
      confirmed: boolean;
    }>`
      /* commerce-cost-structure-history */
      SELECT version,
             revision,
             effective_from,
             recorded_at,
             updated_by_user_id::text AS updated_by_user_id,
             origin,
             confirmed
      FROM business_commerce_cost_structure_history
      WHERE business_id = ${input.businessId}::uuid
      ORDER BY version DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      version: Number(row.version),
      revision: row.revision,
      effectiveFrom: row.effective_from,
      recordedAt: row.recorded_at,
      updatedByUserId: row.updated_by_user_id,
      origin: row.origin,
      confirmed: row.confirmed,
    }));
  } catch (error) {
    return asUnavailable(error, ["business_commerce_cost_structure_history"]);
  }
}

/**
 * One stored version, for reproducing what a past figure was computed from.
 *
 * Null means that version was never stored, which is not the same as a version
 * whose storage cannot be read -- that still throws.
 */
export async function getCostStructureVersion(input: {
  businessId: string;
  version: number;
}): Promise<CommerceCostStructure | null> {
  await requireStorage(["business_commerce_cost_structure_history"]);

  const sql = getDb();
  try {
    const rows = await sql<{ structure: CommerceCostStructure | string }>`
      /* commerce-cost-structure-version */
      SELECT structure
      FROM business_commerce_cost_structure_history
      WHERE business_id = ${input.businessId}::uuid
        AND version = ${input.version}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? parseStructureColumn(row.structure) : null;
  } catch (error) {
    return asUnavailable(error, ["business_commerce_cost_structure_history"]);
  }
}
