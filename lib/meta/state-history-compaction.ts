// D077 — state-history compaction PLANNER.
//
// SELECT-only and deterministic, and it PROVES it: the planner refuses to run
// outside a read-only transaction, so no caller can accidentally point it at
// a writable session. The executor lives in
// ./state-history-compaction-executor.ts, is unreachable from app runtime
// (static guard), and consumes the plan by recomputing the canonical
// execution-payload hash — a received planHash is never trusted.
//
// The safe deletion unit is a WHOLE run's row set: a complete run whose full
// manifest signature is byte-identical to the immediately preceding complete
// run of the same (business, account, entity_type, endpoint) scope, that is
// not the scope's most recent run, and that contains NO row pinned by any of
// the three ON DELETE RESTRICT FK families (live lineage edges, the retained
// compact-schema lineage edges, operator response events). One pinned row
// protects its entire run — partial removal would break that run's manifest
// count and turn the receipts compaction guard's orderly skip into a
// fail-closed mismatch.
import { createHash } from "node:crypto";
import { DEFAULT_TABLE_BUDGET_BYTES } from "@/lib/sync/db-growth-fence";
import {
  measureStateHistoryFence,
  type StateHistoryFenceMeasurement,
} from "@/lib/sync/state-history-effective-size";

export const STATE_HISTORY_COMPACTION_CONTRACT =
  "adsecute.meta.state-history-compaction.v1";

/** Advisory lock key for lease acquisition (see the executor's lease). */
export const STATE_HISTORY_COMPACTION_LOCK_KEY = Number(
  BigInt.asIntN(
    63,
    BigInt(
      "0x" +
        createHash("sha256")
          .update(STATE_HISTORY_COMPACTION_CONTRACT)
          .digest("hex")
          .slice(0, 12),
    ),
  ),
);

/** The retained July compaction schema still holds RESTRICT FKs at us. */
export const ARCHIVED_LINEAGE_SCHEMA = "adsecute_compact_20260726t0204z";

export type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Strict, labelled parser for safety-critical planner counts (correction
 * 3). Accepts exactly the PostgreSQL COUNT forms — a non-negative safe
 * integer number, or a trimmed decimal-integer string such as "0"/"12"
 * (COUNT(*)::bigint arrives as a string). Everything else — null,
 * undefined, empty/whitespace, malformed strings, NaN, Infinity,
 * negatives, fractions, unsafe magnitudes, booleans, objects — REFUSES
 * the planner with the measurement named, before any plan or hash can be
 * serialized. Unreadable evidence is never manufactured into a measured
 * zero. Boolean SQL results use their own truthy() handling and must
 * never pass through this parser.
 */
function requirePlannerCount(value: unknown, label: string): number {
  const refuse = (): never => {
    throw new Error(
      `state-history compaction planner refused unparseable count evidence (${label}): ${JSON.stringify(value)}`,
    );
  };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) refuse();
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) refuse();
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) refuse();
    return parsed;
  }
  return refuse();
}

function emptyProtections(): CompactionProtectionsByReason {
  return {
    headDuplicate: { runs: 0, rows: 0 },
    liveLineagePinned: { runs: 0, rows: 0 },
    archivedLineagePinned: { runs: 0, rows: 0 },
    responseEventPinned: { runs: 0, rows: 0 },
    interleavedExcluded: { runs: 0, rows: 0 },
    multiEndpointExcluded: { runs: 0, rows: 0 },
  };
}

function addProtections(
  left: CompactionProtectionsByReason,
  right: CompactionProtectionsByReason,
): CompactionProtectionsByReason {
  const add = (
    a: CompactionProtectionCount,
    b: CompactionProtectionCount,
  ): CompactionProtectionCount => ({ runs: a.runs + b.runs, rows: a.rows + b.rows });
  return {
    headDuplicate: add(left.headDuplicate, right.headDuplicate),
    liveLineagePinned: add(left.liveLineagePinned, right.liveLineagePinned),
    archivedLineagePinned: add(
      left.archivedLineagePinned,
      right.archivedLineagePinned,
    ),
    responseEventPinned: add(
      left.responseEventPinned,
      right.responseEventPinned,
    ),
    interleavedExcluded: add(
      left.interleavedExcluded,
      right.interleavedExcluded,
    ),
    multiEndpointExcluded: add(
      left.multiEndpointExcluded,
      right.multiEndpointExcluded,
    ),
  };
}

/**
 * Fail-closed count invariant for one scope (or, with
 * `multiEndpointDisjoint: false`, for plan totals aggregating mixed
 * scopes). Validates BOTH run and ROW level:
 *  - disjoint candidate reconciliation for runs AND rows
 *    (candidate = pinned union + interleave exclusion + removable);
 *  - pinned union bounds against the overlapping pin families, for runs
 *    AND rows: union never exceeds the family sum and never undercuts the
 *    largest family (families are non-additive; the union counts each
 *    run/row once);
 *  - the interleave reason mirrors the scope's exclusion exactly;
 *  - multi-endpoint disjointness at scope level: a scope carrying the
 *    multi-endpoint exclusion has NO other classification;
 *  - every count is a non-negative safe integer.
 * Throws on any violation: a plan whose own counts disagree must not
 * exist, so the planner refuses instead of serializing it.
 */
export function validateCompactionScopeCounts(input: {
  label: string;
  candidateRuns: number;
  candidateRows: number;
  pinnedRuns: number;
  pinnedRunRows: number;
  interleavedExcludedRuns: number;
  interleavedExcludedRows: number;
  removableRuns: number;
  removableRows: number;
  protectionsByReason: CompactionProtectionsByReason;
  multiEndpointDisjoint?: boolean;
}): void {
  const fail = (detail: string): never => {
    throw new Error(
      `state-history compaction planner internal count inconsistency (${detail}) for ${input.label}`,
    );
  };
  const reasons = input.protectionsByReason;
  const allCounts: Array<[string, number]> = [
    ["candidateRuns", input.candidateRuns],
    ["candidateRows", input.candidateRows],
    ["pinnedRuns", input.pinnedRuns],
    ["pinnedRunRows", input.pinnedRunRows],
    ["interleavedExcludedRuns", input.interleavedExcludedRuns],
    ["interleavedExcludedRows", input.interleavedExcludedRows],
    ["removableRuns", input.removableRuns],
    ["removableRows", input.removableRows],
  ];
  for (const [name, count] of Object.entries(reasons)) {
    allCounts.push([`${name}.runs`, count.runs], [`${name}.rows`, count.rows]);
  }
  for (const [name, value] of allCounts) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`non-negative integer violated: ${name}=${value}`);
    }
  }
  if (
    input.candidateRuns !==
    input.pinnedRuns + input.interleavedExcludedRuns + input.removableRuns
  ) {
    fail("candidate RUN reconciliation");
  }
  if (
    input.candidateRows !==
    input.pinnedRunRows + input.interleavedExcludedRows + input.removableRows
  ) {
    fail("candidate ROW reconciliation");
  }
  const familyRuns = [
    reasons.liveLineagePinned.runs,
    reasons.archivedLineagePinned.runs,
    reasons.responseEventPinned.runs,
  ];
  const familyRows = [
    reasons.liveLineagePinned.rows,
    reasons.archivedLineagePinned.rows,
    reasons.responseEventPinned.rows,
  ];
  const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);
  if (
    input.pinnedRuns > sum(familyRuns) ||
    input.pinnedRuns < Math.max(...familyRuns)
  ) {
    fail("pinned RUN union outside overlapping family bounds");
  }
  if (
    input.pinnedRunRows > sum(familyRows) ||
    input.pinnedRunRows < Math.max(...familyRows)
  ) {
    fail("pinned ROW union outside overlapping family bounds");
  }
  if (
    reasons.interleavedExcluded.runs !== input.interleavedExcludedRuns ||
    reasons.interleavedExcluded.rows !== input.interleavedExcludedRows
  ) {
    fail("interleave mirror");
  }
  // Multi-endpoint exclusion (correction 3): presence is derived from runs
  // OR rows; the measured complete-run/physical-row exclusion must be
  // symmetric (rows cannot exist without runs, and an all-empty scope's
  // asymmetric evidence fails closed for operator investigation rather
  // than being serialized). When present at scope level, EVERY other
  // classification must be zero at both RUN and ROW level — scalars and
  // every other protection reason alike.
  const multi = reasons.multiEndpointExcluded;
  const multiPresent = multi.runs > 0 || multi.rows > 0;
  if (multiPresent && (multi.runs === 0) !== (multi.rows === 0)) {
    fail("multi-endpoint exclusion evidence is asymmetric (runs xor rows)");
  }
  if ((input.multiEndpointDisjoint ?? true) && multiPresent) {
    const scalarLeak =
      input.candidateRuns !== 0 ||
      input.candidateRows !== 0 ||
      input.pinnedRuns !== 0 ||
      input.pinnedRunRows !== 0 ||
      input.interleavedExcludedRuns !== 0 ||
      input.interleavedExcludedRows !== 0 ||
      input.removableRuns !== 0 ||
      input.removableRows !== 0;
    const reasonLeak = (
      [
        "headDuplicate",
        "liveLineagePinned",
        "archivedLineagePinned",
        "responseEventPinned",
        "interleavedExcluded",
      ] as const
    ).some(
      (name) => reasons[name].runs !== 0 || reasons[name].rows !== 0,
    );
    if (scalarLeak || reasonLeak) {
      fail("multi-endpoint exclusion is not disjoint");
    }
  }
}

export interface CompactionRunPlan {
  runId: string;
  physicalRows: number;
  manifestSig: string;
  /** The retained predecessor run's observed clock. The executor re-verifies
   * in-transaction that no partial/point-lookup row was interleaved into
   * (previousObservedAt, observedAt] — such a row makes the duplicate
   * load-bearing for mixed-lane as-of reads. */
  previousObservedAt: string;
  observedAt: string;
}

export interface CompactionProtectionCount {
  runs: number;
  rows: number;
}

/**
 * Exact per-reason protection counts. The pin families are NOT disjoint —
 * one run may be pinned by several families at once — so the per-family
 * values may overlap and must never be summed into a total; the union of
 * pinned runs/rows is `pinnedRuns`/`pinnedRunRows` on the scope. Head and
 * interleave exclusions are disjoint from the pin families and from each
 * other by construction (classification order: head, pin union,
 * interleave, removable).
 */
export interface CompactionProtectionsByReason {
  headDuplicate: CompactionProtectionCount;
  liveLineagePinned: CompactionProtectionCount;
  archivedLineagePinned: CompactionProtectionCount;
  responseEventPinned: CompactionProtectionCount;
  interleavedExcluded: CompactionProtectionCount;
  /**
   * Every complete-lane run (and its physical state rows) of a scope whose
   * (business, account, entityType) has more than one complete-lane
   * endpoint: the whole scope is excluded wholesale BEFORE candidate
   * classification, so this reason is disjoint from every other reason and
   * from the candidate denominator (such a scope has candidateRuns = 0 and
   * all other reasons zero). Measured by a scope-bound count, never
   * inferred by subtraction.
   */
  multiEndpointExcluded: CompactionProtectionCount;
}

export interface CompactionScopePlan {
  businessId: string;
  providerAccountId: string;
  entityType: string;
  endpoint: string;
  completeRuns: number;
  candidateRuns: number;
  candidateRows: number;
  pinnedRuns: number;
  pinnedRunRows: number;
  removableRuns: number;
  removableRows: number;
  /** Duplicate runs excluded because a partial/point-lookup observation is
   * interleaved between them and their retained predecessor: deleting them
   * would resurface the interleaved row as the mixed-lane as-of winner. */
  interleavedExcludedRuns: number;
  interleavedExcludedRows: number;
  /** Per-run identity, expected size, and expected manifest signature — the
   * executor revalidates all of it inside every batch transaction. */
  removable: CompactionRunPlan[];
  /** True when this (business, account, entityType) has >1 complete-lane
   * endpoint; the scope is excluded fail-closed (cross-endpoint timelines
   * could make a duplicate row load-bearing). */
  multiEndpointUnsupported: boolean;
  protectionsByReason: CompactionProtectionsByReason;
}

export interface CompactionTimelineHash {
  businessId: string;
  providerAccountId: string;
  entityType: string;
  timelineHash: string;
  transitionRows: number;
}

export interface StateHistoryCompactionPlan {
  contract: string;
  businessIds: string[];
  scopes: CompactionScopePlan[];
  timelines: CompactionTimelineHash[];
  totals: {
    candidateRuns: number;
    candidateRows: number;
    pinnedRuns: number;
    pinnedRunRows: number;
    removableRuns: number;
    removableRows: number;
    protectionsByReason: CompactionProtectionsByReason;
  };
  fence: StateHistoryFenceMeasurement;
  fenceProjection: {
    raw: { clearedByDeleteAlone: false; detail: string };
    effectiveReusableHeap: {
      proofAvailable: boolean;
      projectedFreedHeapBytes: number | null;
      projectedEffectiveBytes: number | null;
      budgetBytes: number;
      cleared: boolean | null;
      preconditions: string[];
    };
  };
  status: "ready" | "nothing_to_do" | "insufficient_evidence";
  insufficiencyReasons: string[];
  /** Cheap staleness fingerprint the executor re-verifies before leasing. */
  scopeFingerprint: string;
  /** Canonical execution-payload hash — see computeExecutionPayloadHash. */
  planHash: string;
}

/**
 * The canonical hash binds EVERY execution-relevant field. The executor
 * recomputes it from the received object and refuses on mismatch, so no
 * field can be edited around a stale hash and the approval token
 * (expectedApprovalToken) always names exactly this payload. The token is
 * an on-the-record operator acknowledgement of ONE exact planner artifact —
 * it is publicly derivable from the plan and is NOT cryptographic
 * provenance or authenticity; the executor's authoritative pre-write
 * re-plan is what makes an edited-and-rehashed payload unexecutable.
 */
export function computeExecutionPayloadHash(
  plan: Omit<StateHistoryCompactionPlan, "planHash">,
): string {
  return sha256({
    contract: plan.contract,
    businessIds: plan.businessIds,
    scopes: plan.scopes,
    timelines: plan.timelines,
    totals: plan.totals,
    fence: plan.fence,
    fenceProjection: plan.fenceProjection,
    status: plan.status,
    insufficiencyReasons: plan.insufficiencyReasons,
    scopeFingerprint: plan.scopeFingerprint,
  });
}

export function expectedApprovalToken(planHash: string): string {
  return `approve-state-history-compaction:${planHash}`;
}

export function stateHistoryBudgetBytes(): number {
  return DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history;
}

const SCOPE_FINGERPRINT_QUERY = `
  SELECT r.business_id, r.provider_account_id, r.entity_type, r.endpoint,
    COUNT(*)::int AS complete_runs,
    MAX(r.id::text) AS max_run_id
  FROM meta_entity_observation_runs r
  WHERE r.completeness = 'complete' AND r.business_id = ANY($1::text[])
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4
`;

export async function computeScopeFingerprint(
  sql: SqlClient,
  businessIds: string[],
): Promise<string> {
  const rows = await sql.query(SCOPE_FINGERPRINT_QUERY, [businessIds]);
  return sha256(rows);
}

export async function computeTimelineHashes(
  sql: SqlClient,
  businessIds: string[],
): Promise<CompactionTimelineHash[]> {
  const rows = await sql.query<{
    business_id: string;
    provider_account_id: string;
    entity_type: string;
    timeline_hash: string;
    transition_rows: unknown;
  }>(
    `
    WITH sequenced AS (
      SELECT business_id, provider_account_id, entity_type, entity_id,
        state_hash, captured_at,
        LAG(state_hash) OVER (
          PARTITION BY business_id, provider_account_id, entity_type, entity_id
          ORDER BY captured_at, created_at, id
        ) AS previous_hash
      FROM meta_entity_state_history
      WHERE business_id = ANY($1::text[]) AND run_completeness = 'complete'
    ), transitions AS (
      SELECT * FROM sequenced
      WHERE previous_hash IS NULL OR state_hash IS DISTINCT FROM previous_hash
    )
    SELECT business_id, provider_account_id, entity_type,
      md5(string_agg(
        entity_id || '@' || captured_at::text || ':' || state_hash,
        '|' ORDER BY entity_id, captured_at
      )) AS timeline_hash,
      COUNT(*)::int AS transition_rows
    FROM transitions
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
    `,
    [businessIds],
  );
  return rows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    entityType: row.entity_type,
    timelineHash: row.timeline_hash,
    transitionRows: requirePlannerCount(
      row.transition_rows,
      `timeline transition_rows for ${row.business_id}/${row.provider_account_id}/${row.entity_type}`,
    ),
  }));
}

export async function detectArchivedLineageSchema(
  sql: SqlClient,
): Promise<boolean> {
  const probe = await sql.query<{ present: unknown }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${ARCHIVED_LINEAGE_SCHEMA}.meta_creative_lineage_edges`],
  );
  return probe[0]?.present === true || probe[0]?.present === "t";
}

/** Live meta_creative_lineage_edges pin (one FK family). */
export function liveLineagePinExistsSql(alias = "s"): string {
  return `EXISTS (SELECT 1 FROM meta_creative_lineage_edges e
      WHERE e.observation_run_id = ${alias}.run_id
        AND e.observation_run_entity_type = ${alias}.entity_type
        AND (e.source_ad_id = ${alias}.ad_id AND e.source_creative_id = ${alias}.creative_id
          OR e.target_ad_id = ${alias}.ad_id AND e.target_creative_id = ${alias}.creative_id))`;
}

/** Retained-compaction-schema lineage pin (one FK family). */
export function archivedLineagePinExistsSql(alias = "s"): string {
  return `EXISTS (SELECT 1 FROM ${ARCHIVED_LINEAGE_SCHEMA}.meta_creative_lineage_edges e
      WHERE e.observation_run_id = ${alias}.run_id
        AND e.observation_run_entity_type = ${alias}.entity_type
        AND (e.source_ad_id = ${alias}.ad_id AND e.source_creative_id = ${alias}.creative_id
          OR e.target_ad_id = ${alias}.ad_id AND e.target_creative_id = ${alias}.creative_id))`;
}

/** engine_v3_ad_operator_response_events.state_history_id pin (one FK family). */
export function responseEventPinExistsSql(alias = "s"): string {
  return `EXISTS (SELECT 1 FROM engine_v3_ad_operator_response_events ev
      WHERE ev.state_history_id = ${alias}.id)`;
}

/** The pin UNION the executor revalidates: composed from the exact same
 * per-family fragments the planner attributes reasons with, so the two can
 * never classify differently. */
export function pinnedExistsSql(
  archivedSchemaPresent: boolean,
  alias = "s",
): string {
  const archivedArm = archivedSchemaPresent
    ? `OR ${archivedLineagePinExistsSql(alias)}`
    : "";
  return `
    ${liveLineagePinExistsSql(alias)}
    ${archivedArm}
    OR ${responseEventPinExistsSql(alias)}
  `;
}

/**
 * SELECT-only dry-run planner. Refuses a writable session, a global scope,
 * and an unresolved scope. Every statement is per-scope-bounded; the caller
 * additionally sets a statement timeout (the CLI does; the planner cannot
 * SET LOCAL for its caller without owning the transaction).
 */
export async function planStateHistoryCompaction(
  sql: SqlClient,
  input: { businessIds: string[] },
): Promise<StateHistoryCompactionPlan> {
  const readOnly = await sql.query<{ transaction_read_only: string }>(
    `SHOW transaction_read_only`,
  );
  if (readOnly[0]?.transaction_read_only !== "on") {
    throw new Error(
      "state-history compaction planner refuses to run outside a READ ONLY transaction.",
    );
  }
  // D077 hardening: the plan is a MULTI-STATEMENT artifact. Under READ
  // COMMITTED each statement gets its own snapshot, so a concurrent commit
  // mid-plan could produce a mixed-snapshot plan (fingerprint, scopes,
  // timelines, and fence measured against different worlds). REPEATABLE
  // READ pins one snapshot for the whole transaction.
  const isolation = await sql.query<{ transaction_isolation: string }>(
    `SHOW transaction_isolation`,
  );
  const level = isolation[0]?.transaction_isolation?.toLowerCase() ?? "";
  if (level !== "repeatable read" && level !== "serializable") {
    throw new Error(
      "state-history compaction planner refuses to run outside a REPEATABLE READ transaction: a weaker isolation level can produce a mixed-snapshot plan.",
    );
  }
  const businessIds = [...new Set(input.businessIds)].sort();
  if (businessIds.length === 0 || businessIds.some((id) => !id.trim())) {
    throw new Error(
      "state-history compaction refuses a global or unresolved scope: pass an explicit non-empty business-id list.",
    );
  }

  const scopeRows = await sql.query<{
    business_id: string;
    provider_account_id: string;
    entity_type: string;
    endpoint: string;
    complete_runs: unknown;
  }>(SCOPE_FINGERPRINT_QUERY, [businessIds]);
  const endpointCount = new Map<string, number>();
  for (const row of scopeRows) {
    const key = `${row.business_id} ${row.provider_account_id} ${row.entity_type}`;
    endpointCount.set(key, (endpointCount.get(key) ?? 0) + 1);
  }
  const archivedSchemaPresent = await detectArchivedLineageSchema(sql);

  const scopes: CompactionScopePlan[] = [];
  for (const scope of scopeRows) {
    const multiEndpointUnsupported =
      (endpointCount.get(
        `${scope.business_id} ${scope.provider_account_id} ${scope.entity_type}`,
      ) ?? 0) > 1;
    const base = {
      businessId: scope.business_id,
      providerAccountId: scope.provider_account_id,
      entityType: scope.entity_type,
      endpoint: scope.endpoint,
      completeRuns: requirePlannerCount(
        scope.complete_runs,
        `scope complete_runs for ${scope.business_id}/${scope.provider_account_id}/${scope.entity_type}/${scope.endpoint}`,
      ),
      multiEndpointUnsupported,
    };
    if (multiEndpointUnsupported) {
      // The whole scope is excluded BEFORE candidate classification. The
      // exclusion is an exact measured reason: every complete-lane run of
      // this scope and its physical state rows (a scope-bound count, never
      // a subtraction, never a boolean-only flag).
      const excludedRows = await sql.query<{ rows: unknown }>(
        `SELECT COUNT(s.id)::bigint AS rows
         FROM meta_entity_observation_runs r
         JOIN meta_entity_state_history s ON s.run_id = r.id
         WHERE r.completeness = 'complete'
           AND r.business_id = $1 AND r.provider_account_id = $2
           AND r.entity_type = $3 AND r.endpoint = $4`,
        [
          scope.business_id,
          scope.provider_account_id,
          scope.entity_type,
          scope.endpoint,
        ],
      );
      const multiScope = {
        ...base,
        candidateRuns: 0,
        candidateRows: 0,
        pinnedRuns: 0,
        pinnedRunRows: 0,
        removableRuns: 0,
        removableRows: 0,
        interleavedExcludedRuns: 0,
        interleavedExcludedRows: 0,
        removable: [],
        protectionsByReason: {
          ...emptyProtections(),
          multiEndpointExcluded: {
            runs: requirePlannerCount(
              scope.complete_runs,
              `multi-endpoint excluded runs for ${scope.business_id}/${scope.provider_account_id}/${scope.entity_type}/${scope.endpoint}`,
            ),
            rows: requirePlannerCount(
              excludedRows[0]?.rows,
              `multi-endpoint excluded rows for ${scope.business_id}/${scope.provider_account_id}/${scope.entity_type}/${scope.endpoint}`,
            ),
          },
        },
      };
      validateCompactionScopeCounts({
        label: `${scope.business_id}/${scope.provider_account_id}/${scope.entity_type}/${scope.endpoint}`,
        ...multiScope,
      });
      scopes.push(multiScope);
      continue;
    }
    const detail = await sql.query<{
      run_id: string;
      physical_rows: unknown;
      manifest_sig: string;
      observed_at: string;
      previous_observed_at: string;
      recency_rank: unknown;
      pinned_live: unknown;
      pinned_archived: unknown;
      pinned_event: unknown;
      interleaved_partial: unknown;
    }>(
      `
      WITH run_manifest AS (
        SELECT r.id AS run_id, r.captured_at, r.observed_at,
          COUNT(s.id) AS physical_rows,
          md5(string_agg(s.entity_id || ':' || s.state_hash, '|' ORDER BY s.entity_id)) AS manifest_sig
        FROM meta_entity_observation_runs r
        JOIN meta_entity_state_history s ON s.run_id = r.id
        WHERE r.completeness = 'complete'
          AND r.business_id = $1 AND r.provider_account_id = $2
          AND r.entity_type = $3 AND r.endpoint = $4
        GROUP BY r.id, r.captured_at, r.observed_at
      ), sequenced AS (
        SELECT *,
          LAG(manifest_sig) OVER (ORDER BY captured_at, run_id) AS previous_sig,
          LAG(observed_at) OVER (ORDER BY captured_at, run_id) AS previous_observed_at,
          ROW_NUMBER() OVER (ORDER BY captured_at DESC, run_id DESC) AS recency_rank
        FROM run_manifest
      )
      SELECT seq.run_id::text AS run_id, seq.physical_rows, seq.manifest_sig,
        seq.observed_at::text AS observed_at,
        seq.previous_observed_at::text AS previous_observed_at,
        seq.recency_rank,
        EXISTS (
          SELECT 1 FROM meta_entity_state_history s
          WHERE s.run_id = seq.run_id AND ${liveLineagePinExistsSql()}
        ) AS pinned_live,
        ${
          archivedSchemaPresent
            ? `EXISTS (
          SELECT 1 FROM meta_entity_state_history s
          WHERE s.run_id = seq.run_id AND ${archivedLineagePinExistsSql()}
        )`
            : "FALSE"
        } AS pinned_archived,
        EXISTS (
          SELECT 1 FROM meta_entity_state_history s
          WHERE s.run_id = seq.run_id AND ${responseEventPinExistsSql()}
        ) AS pinned_event,
        EXISTS (
          SELECT 1 FROM meta_entity_state_history interleaved
          WHERE interleaved.business_id = $1
            AND interleaved.provider_account_id = $2
            AND interleaved.entity_type = $3
            AND interleaved.run_completeness IN ('partial', 'point_lookup')
            AND interleaved.observed_at > seq.previous_observed_at
            AND interleaved.observed_at <= seq.observed_at
        ) AS interleaved_partial
      FROM sequenced seq
      WHERE seq.manifest_sig = seq.previous_sig
      ORDER BY seq.run_id
      `,
      [
        scope.business_id,
        scope.provider_account_id,
        scope.entity_type,
        scope.endpoint,
      ],
    );
    let candidateRuns = 0;
    let candidateRows = 0;
    let pinnedRuns = 0;
    let pinnedRunRows = 0;
    let interleavedExcludedRuns = 0;
    let interleavedExcludedRows = 0;
    const reasons = emptyProtections();
    const removable: CompactionRunPlan[] = [];
    let removableRows = 0;
    const truthy = (value: unknown) => value === true || value === "t";
    for (const row of detail) {
      const rows = requirePlannerCount(
        row.physical_rows,
        `candidate physical_rows for run ${row.run_id}`,
      );
      if (
        requirePlannerCount(
          row.recency_rank,
          `candidate recency_rank for run ${row.run_id}`,
        ) === 1
      ) {
        // A duplicate that is the scope's most recent run: protected by the
        // non-head rule, never a candidate. Counted explicitly (ADR
        // "protected counts by reason").
        reasons.headDuplicate.runs += 1;
        reasons.headDuplicate.rows += rows;
        continue;
      }
      candidateRuns += 1;
      candidateRows += rows;
      const pinnedLive = truthy(row.pinned_live);
      const pinnedArchived = truthy(row.pinned_archived);
      const pinnedEvent = truthy(row.pinned_event);
      if (pinnedLive || pinnedArchived || pinnedEvent) {
        // One pinned row protects the WHOLE run. The union counts each run
        // once; the per-family counts below may overlap (a run pinned by
        // several families appears in each) and are never additive.
        pinnedRuns += 1;
        pinnedRunRows += rows;
        if (pinnedLive) {
          reasons.liveLineagePinned.runs += 1;
          reasons.liveLineagePinned.rows += rows;
        }
        if (pinnedArchived) {
          reasons.archivedLineagePinned.runs += 1;
          reasons.archivedLineagePinned.rows += rows;
        }
        if (pinnedEvent) {
          reasons.responseEventPinned.runs += 1;
          reasons.responseEventPinned.rows += rows;
        }
      } else if (truthy(row.interleaved_partial)) {
        // A partial/point-lookup observation between this duplicate and its
        // retained predecessor makes the duplicate load-bearing: deleting it
        // would resurface the interleaved row as the as-of winner.
        interleavedExcludedRuns += 1;
        interleavedExcludedRows += rows;
        reasons.interleavedExcluded.runs += 1;
        reasons.interleavedExcluded.rows += rows;
      } else {
        removable.push({
          runId: row.run_id,
          physicalRows: rows,
          manifestSig: row.manifest_sig,
          previousObservedAt: row.previous_observed_at,
          observedAt: row.observed_at,
        });
        removableRows += rows;
      }
    }
    // Fail-closed internal consistency at BOTH run and row level, through
    // the exported validator (see validateCompactionScopeCounts).
    validateCompactionScopeCounts({
      label: `${scope.business_id}/${scope.provider_account_id}/${scope.entity_type}/${scope.endpoint}`,
      candidateRuns,
      candidateRows,
      pinnedRuns,
      pinnedRunRows,
      interleavedExcludedRuns,
      interleavedExcludedRows,
      removableRuns: removable.length,
      removableRows,
      protectionsByReason: reasons,
    });
    scopes.push({
      ...base,
      candidateRuns,
      candidateRows,
      pinnedRuns,
      pinnedRunRows,
      removableRuns: removable.length,
      removableRows,
      interleavedExcludedRuns,
      interleavedExcludedRows,
      removable,
      protectionsByReason: reasons,
    });
  }

  const timelines = await computeTimelineHashes(sql, businessIds);
  const fence = await measureStateHistoryFence(sql, {
    budgetBytes: stateHistoryBudgetBytes(),
  });
  const liveRowRows = await sql.query<{ live_rows: unknown }>(
    `SELECT COUNT(*)::bigint AS live_rows FROM meta_entity_state_history`,
  );
  const liveRows = requirePlannerCount(
    liveRowRows[0]?.live_rows,
    "live_rows census of meta_entity_state_history",
  );

  const totals = scopes.reduce(
    (acc, scope) => ({
      candidateRuns: acc.candidateRuns + scope.candidateRuns,
      candidateRows: acc.candidateRows + scope.candidateRows,
      pinnedRuns: acc.pinnedRuns + scope.pinnedRuns,
      pinnedRunRows: acc.pinnedRunRows + scope.pinnedRunRows,
      removableRuns: acc.removableRuns + scope.removableRuns,
      removableRows: acc.removableRows + scope.removableRows,
      protectionsByReason: addProtections(
        acc.protectionsByReason,
        scope.protectionsByReason,
      ),
    }),
    {
      candidateRuns: 0,
      candidateRows: 0,
      pinnedRuns: 0,
      pinnedRunRows: 0,
      removableRuns: 0,
      removableRows: 0,
      protectionsByReason: emptyProtections(),
    },
  );

  // Totals-level invariant (multi-endpoint disjointness relaxed: totals
  // legitimately mix excluded and supported scopes).
  validateCompactionScopeCounts({
    label: "plan totals",
    candidateRuns: totals.candidateRuns,
    candidateRows: totals.candidateRows,
    pinnedRuns: totals.pinnedRuns,
    pinnedRunRows: totals.pinnedRunRows,
    interleavedExcludedRuns: totals.protectionsByReason.interleavedExcluded.runs,
    interleavedExcludedRows: totals.protectionsByReason.interleavedExcluded.rows,
    removableRuns: totals.removableRuns,
    removableRows: totals.removableRows,
    protectionsByReason: totals.protectionsByReason,
    multiEndpointDisjoint: false,
  });

  // Conservative heap-only projection: mean heap bytes per live row times
  // removable rows. Index bytes are NEVER projected as reclaimed, and the
  // projection is only meaningful under the effective metric with proof.
  const meanHeapBytesPerRow =
    liveRows > 0 && fence.heapBytes !== null && fence.heapBytes > 0
      ? fence.heapBytes / liveRows
      : null;
  const projectedFreedHeapBytes =
    meanHeapBytesPerRow === null
      ? null
      : Math.floor(meanHeapBytesPerRow * totals.removableRows);
  const proofAvailable = fence.metric === "effective_reusable_heap";
  const projectedEffectiveBytes =
    projectedFreedHeapBytes === null || fence.effectiveBytes === null
      ? null
      : Math.max(0, fence.effectiveBytes - projectedFreedHeapBytes);

  const insufficiencyReasons: string[] = [];
  if (fence.metric === "unavailable") {
    insufficiencyReasons.push("fence_measurement_unavailable");
  }
  if (!proofAvailable) {
    insufficiencyReasons.push(
      `free_space_proof_unavailable:${fence.fallbackReason ?? "unknown"}`,
    );
  }
  if (totals.removableRows === 0) insufficiencyReasons.push("no_removable_rows");

  const status: StateHistoryCompactionPlan["status"] =
    totals.removableRows === 0
      ? "nothing_to_do"
      : insufficiencyReasons.length > 0
        ? "insufficient_evidence"
        : "ready";

  const scopeFingerprint = await computeScopeFingerprint(sql, businessIds);
  const withoutHash: Omit<StateHistoryCompactionPlan, "planHash"> = {
    contract: STATE_HISTORY_COMPACTION_CONTRACT,
    businessIds,
    scopes,
    timelines,
    totals,
    fence,
    fenceProjection: {
      raw: {
        clearedByDeleteAlone: false,
        detail:
          "DELETE creates reusable space only; pg_total_relation_size does not shrink. Physical byte return (REINDEX CONCURRENTLY / pg_repack / VACUUM FULL) is a separate, operator-approved step never run by this tool.",
      },
      effectiveReusableHeap: {
        proofAvailable,
        projectedFreedHeapBytes,
        projectedEffectiveBytes,
        budgetBytes: fence.budgetBytes,
        cleared:
          proofAvailable && projectedEffectiveBytes !== null
            ? projectedEffectiveBytes < fence.budgetBytes
            : null,
        preconditions: [
          "pgstattuple extension installed (operator DDL)",
          "routine (auto)vacuum has processed the deletions",
          "fence deployed with the effective_reusable_heap metric",
        ],
      },
    },
    status,
    insufficiencyReasons,
    scopeFingerprint,
  };
  return { ...withoutHash, planHash: computeExecutionPayloadHash(withoutHash) };
}
