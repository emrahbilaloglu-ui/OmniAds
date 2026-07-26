import { getDb, runDbTransaction } from "@/lib/db";
import { buildMetaCreativeLineageLogicalKey } from "@/lib/meta/entity-state-history";
import type {
  MetaCreativeLineageEvidenceSource,
  MetaCreativeLineageType,
} from "@/lib/meta/entity-state-history";

/**
 * Planning pass for lineage edges written under the old run-scoped hash.
 *
 * `lineage_hash` used to include `observationRunId`, so the same logical fact —
 * this ad reuses that creative — got a new identity on every observation and the
 * unique constraint deduplicated nothing. New writes carry a stable
 * `logical_lineage_key`; existing rows cannot, because their hashes were
 * computed from a run id that a migration has no way to reverse.
 *
 * So the collapse is an application pass, not DDL:
 *
 *  - it is RESUMABLE, driven by an explicit cursor, because the table is large
 *    and a single unbounded pass over it is the kind of statement that becomes
 *    an incident;
 *  - it PLANS by default and reports what it would do;
 *  - the only mutation it can perform is stamping a logical key onto the row it
 *    chose to keep. There is no delete path in this module at all, so a
 *    mistaken plan costs a wrong label rather than lost lineage.
 *
 * The keeper is the OLDEST row in each logical group. Lineage is evidence about
 * when a relationship was first observed; keeping the newest would move that
 * date forward every time the pass ran.
 */

export interface MetaLineageCollapseCandidate {
  logicalKey: string;
  /** The row that will carry the logical key. Oldest wins. */
  keeperId: string;
  /** Rows that describe the same fact and stay untouched. */
  redundantIds: string[];
}

export interface MetaLineageCollapsePlan {
  scanned: number;
  groups: MetaLineageCollapseCandidate[];
  redundantRowCount: number;
  /** Pass this back to continue; null means the scan reached the end. */
  nextCursor: MetaLineageCollapseCursor | null;
  applied: number;
  mode: "plan" | "apply";
}

export interface MetaLineageCollapseCursor {
  createdAt: string;
  id: string;
}

interface LegacyLineageRow {
  id: string;
  business_id: string;
  provider_account_id: string;
  lineage_type: MetaCreativeLineageType;
  source_ad_id: string;
  source_creative_id: string;
  target_ad_id: string;
  target_creative_id: string;
  evidence_source: MetaCreativeLineageEvidenceSource;
  action_log_id: string | null;
  created_at: string;
}

export const META_LINEAGE_COLLAPSE_DEFAULT_BATCH = 1_000;
export const META_LINEAGE_COLLAPSE_MAX_BATCH = 10_000;

/**
 * Scan one bounded batch of legacy rows and report the collapse it implies.
 *
 * `apply` defaults to false. When true it stamps the logical key on keepers
 * only, inside one transaction, and still deletes nothing.
 */
export async function planMetaCreativeLineageLegacyCollapse(input?: {
  limit?: number;
  cursor?: MetaLineageCollapseCursor | null;
  apply?: boolean;
}): Promise<MetaLineageCollapsePlan> {
  const limit = Math.max(
    1,
    Math.min(META_LINEAGE_COLLAPSE_MAX_BATCH, input?.limit ?? META_LINEAGE_COLLAPSE_DEFAULT_BATCH),
  );
  const cursor = input?.cursor ?? null;
  const apply = input?.apply === true;
  const sql = getDb();

  // Keyset pagination on (created_at, id). An OFFSET would re-read everything
  // it skipped, which on a multi-gigabyte table is the pass being slower every
  // time it resumes.
  const rows = (await sql.query(
    `SELECT id::text AS id, business_id, provider_account_id, lineage_type,
            source_ad_id, source_creative_id, target_ad_id, target_creative_id,
            evidence_source, action_log_id::text AS action_log_id,
            created_at::text AS created_at
     FROM meta_creative_lineage_edges
     WHERE logical_lineage_key IS NULL
       AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
     ORDER BY created_at ASC, id ASC
     LIMIT $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit],
  )) as LegacyLineageRow[];

  const groups = new Map<string, { keeper: LegacyLineageRow; redundant: string[] }>();
  for (const row of rows) {
    const logicalKey = buildMetaCreativeLineageLogicalKey({
      businessId: row.business_id,
      providerAccountId: row.provider_account_id,
      lineageType: row.lineage_type,
      sourceAdId: row.source_ad_id,
      sourceCreativeId: row.source_creative_id,
      targetAdId: row.target_ad_id,
      targetCreativeId: row.target_creative_id,
      evidenceSource: row.evidence_source,
      actionLogId: row.action_log_id,
    });
    const existing = groups.get(logicalKey);
    if (!existing) {
      groups.set(logicalKey, { keeper: row, redundant: [] });
      continue;
    }
    // Rows arrive in (created_at, id) order, so the first one seen is the
    // oldest and stays the keeper.
    existing.redundant.push(row.id);
  }

  const candidates: MetaLineageCollapseCandidate[] = [...groups.entries()].map(
    ([logicalKey, group]) => ({
      logicalKey,
      keeperId: group.keeper.id,
      redundantIds: group.redundant,
    }),
  );

  let applied = 0;
  if (apply && candidates.length > 0) {
    applied = await runDbTransaction(async () => {
      const tx = getDb();
      let stamped = 0;
      for (const candidate of candidates) {
        // Only the keeper is stamped, and only while it is still unstamped, so
        // a concurrent pass cannot double-apply. A row that already has a key
        // is left exactly as it is.
        const updated = (await tx.query(
          `UPDATE meta_creative_lineage_edges
           SET logical_lineage_key = $1
           WHERE id = $2::uuid AND logical_lineage_key IS NULL
           RETURNING id`,
          [candidate.logicalKey, candidate.keeperId],
        )) as Array<{ id: string }>;
        stamped += updated.length;
      }
      return stamped;
    });
  }

  const last = rows[rows.length - 1];
  return {
    scanned: rows.length,
    groups: candidates,
    redundantRowCount: candidates.reduce(
      (total, candidate) => total + candidate.redundantIds.length,
      0,
    ),
    nextCursor:
      rows.length === limit && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
    applied,
    mode: apply ? "apply" : "plan",
  };
}
