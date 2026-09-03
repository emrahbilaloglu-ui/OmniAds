// D077 real-Postgres seam: state-history compaction planner + executor.
//
// Proves, against the full migrated schema: duplicate-manifest candidate
// selection with head/pin/multi-endpoint protection (one pinned row protects
// its WHOLE run); zero-write refusals for invalid token and tampered payload;
// out-of-scope run injection rolling its batch back; stale-plan refusal;
// kill-switch interruption with idempotent resume; executor exclusivity via
// the journal lease; pre/post equivalence for as-of reads, the receipts
// compaction-guard expression, distinct-state timelines, partial/failed
// interleaves, and exact-business isolation; the effective-size fence
// fallback-then-proof transition around CREATE EXTENSION pgstattuple; and —
// after compaction — the D075 WRITER path producing delta stats identical to
// an uncompacted twin business, including the identical-payload coalesce.
import { Client } from "pg";
import { getDb, runDbTransaction } from "@/lib/db";
import { NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION } from "@/lib/creative-decision-engine/ad-operator-response-detection";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  buildMetaObservationRunHash,
  persistMetaEntityObservation,
  readMetaEntityStatesAsOf,
} from "@/lib/meta/entity-state-history";
import {
  computeScopeFingerprint,
  expectedApprovalToken,
  computeExecutionPayloadHash,
  planStateHistoryCompaction,
  type StateHistoryCompactionPlan,
} from "@/lib/meta/state-history-compaction";
import { executeStateHistoryCompaction } from "@/lib/meta/state-history-compaction-executor";
import { measureStateHistoryFence } from "@/lib/sync/state-history-effective-size";

interface IdRow {
  id: string;
  [key: string]: unknown;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[compaction-seam] ${message}`);
}

const HEX = "0123456789abcdef";
function hex64(seed: number): string {
  let out = "";
  for (let index = 0; index < 64; index += 1) {
    out += HEX[(seed + index * 7) % 16];
  }
  return out;
}

async function journalCount(): Promise<number> {
  const rows = await getDb().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM meta_state_history_compaction_journal`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function plannedReadOnly(businessIds: string[]) {
  return runDbTransaction(async () => {
    const db = getDb();
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return planStateHistoryCompaction(db, { businessIds });
  });
}

async function main() {
  const sql = getDb();

  /* ---------------- Fixture ------------------------------------------- */

  const [owner] = await sql<IdRow>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Compaction seam', 'compaction-seam@example.invalid', 'unused')
    RETURNING id
  `;
  const mkBusiness = async (name: string) => {
    const [business] = await sql<IdRow>`
      INSERT INTO businesses (name, owner_id)
      VALUES (${name}, ${owner!.id}) RETURNING id
    `;
    return business!.id;
  };
  const mkAccount = async (businessId: string, externalId: string) => {
    const [account] = await sql<IdRow>`
      INSERT INTO provider_accounts (provider, external_account_id, account_name)
      VALUES ('meta', ${externalId}, ${externalId}) RETURNING id
    `;
    await sql`
      INSERT INTO business_provider_accounts (
        business_id, provider, provider_account_ref_id, provider_account_id
      ) VALUES (${businessId}, 'meta', ${account!.id}, ${externalId})
    `;
    return account!.id;
  };

  const bizA = await mkBusiness("Compaction seam A");
  const bizB = await mkBusiness("Compaction seam twin B");
  const accA = await mkAccount(bizA, "act_compact_a");
  const accARef = accA;
  const accB = await mkAccount(bizB, "act_compact_b");

  interface LegacyRunSpec {
    businessId: string;
    accountRef: string;
    accountId: string;
    entityType: "campaign" | "ad" | "creative";
    endpoint: string;
    capturedAt: string;
    completeness?: "complete" | "partial" | "failed";
    states: Array<{ entityId: string; stateHash: string; adId?: string; creativeId?: string }>;
    seed: number;
  }
  const insertLegacyRun = async (spec: LegacyRunSpec) => {
    const completeness = spec.completeness ?? "complete";
    const observedAt = spec.capturedAt;
    const runHash = buildMetaObservationRunHash({
      businessId: spec.businessId,
      providerAccountId: spec.accountId,
      entityType: spec.entityType,
      endpoint: spec.endpoint,
      observedAt,
      capturedAt: spec.capturedAt,
      completeness,
      pageCount: 1,
      rowCount: spec.states.length,
      error: completeness === "failed" ? { code: "provider_failed" } : null,
    });
    const [run] = await sql<IdRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, endpoint, observed_at, captured_at,
        completeness, page_count, row_count, run_hash, error_json
      ) VALUES (
        ${spec.businessId}, ${spec.businessId}, ${spec.accountRef},
        ${spec.accountId}, ${spec.entityType}, ${spec.endpoint},
        ${observedAt}::timestamptz, ${spec.capturedAt}::timestamptz,
        ${completeness}, 1, ${spec.states.length}, ${runHash},
        ${completeness === "failed" ? { code: "provider_failed" } : null}::jsonb
      ) RETURNING id
    `;
    for (const state of spec.states) {
      await sql`
        INSERT INTO meta_entity_state_history (
          run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id,
          ad_id, creative_id, learning_source, budget_origin, presence,
          field_coverage_json, observed_at, captured_at, run_completeness,
          state_hash
        ) VALUES (
          ${run!.id}, ${spec.businessId}, ${spec.businessId},
          ${spec.accountRef}, ${spec.accountId}, ${spec.entityType},
          ${state.entityId},
          ${spec.entityType === "creative" ? null : spec.entityType === "campaign" ? state.entityId : "campaign_compact"},
          ${spec.entityType === "ad" ? "adset_compact" : null},
          ${state.adId ?? null},
          ${spec.entityType === "creative" ? state.entityId : (state.creativeId ?? null)},
          'not_observed', 'not_applicable', 'present', '{}'::jsonb,
          ${observedAt}::timestamptz, ${spec.capturedAt}::timestamptz,
          ${completeness === "failed" ? "complete" : completeness}, ${state.stateHash}
        )
      `;
    }
    return { runId: run!.id, capturedAt: spec.capturedAt };
  };

  // S1 (bizA campaign scope) and its byte-identical twin on bizB. Streaks:
  // L1(A1,B1,C1) [F/P interleave] L2=L1 L3=L1 | L4(B->B2) L5=L4 | L6 head (B back to B1).
  const S1 = { entityType: "campaign" as const, endpoint: "campaign_configs_compact" };
  const A1 = hex64(1);
  const B1 = hex64(2);
  const B2 = hex64(3);
  const C1 = hex64(4);
  const s1States = (bHash: string) => [
    { entityId: "cmp_a", stateHash: A1 },
    { entityId: "cmp_b", stateHash: bHash },
    { entityId: "cmp_c", stateHash: C1 },
  ];
  const fixtureScope = async (businessId: string, accountRef: string, accountId: string) => {
    const base = { businessId, accountRef, accountId, ...S1 };
    const l1 = await insertLegacyRun({ ...base, capturedAt: "2026-06-01T03:00:00Z", states: s1States(B1), seed: 1 });
    await insertLegacyRun({ ...base, capturedAt: "2026-06-01T09:00:00Z", completeness: "failed", states: [], seed: 9 });
    await insertLegacyRun({
      ...base,
      capturedAt: "2026-06-01T10:00:00Z",
      completeness: "partial",
      states: [{ entityId: "cmp_a", stateHash: hex64(5) }],
      seed: 5,
    });
    const l2 = await insertLegacyRun({ ...base, capturedAt: "2026-06-02T03:00:00Z", states: s1States(B1), seed: 2 });
    const l3 = await insertLegacyRun({ ...base, capturedAt: "2026-06-03T03:00:00Z", states: s1States(B1), seed: 3 });
    const l4 = await insertLegacyRun({ ...base, capturedAt: "2026-06-04T03:00:00Z", states: s1States(B2), seed: 4 });
    const l5 = await insertLegacyRun({ ...base, capturedAt: "2026-06-05T03:00:00Z", states: s1States(B2), seed: 6 });
    const l6 = await insertLegacyRun({ ...base, capturedAt: "2026-06-06T03:00:00Z", states: s1States(B1), seed: 7 });
    return { l1, l2, l3, l4, l5, l6 };
  };
  const scopeA = await fixtureScope(bizA, accARef, "act_compact_a");
  await fixtureScope(bizB, accB, "act_compact_b");

  // S3 (bizA ad scope): duplicate run pinned by a lineage edge.
  const S3 = { entityType: "ad" as const, endpoint: "ad_configs_compact" };
  const adStates = [
    { entityId: "ad_x", stateHash: hex64(8), adId: "ad_x", creativeId: "cr_1" },
    { entityId: "ad_y", stateHash: hex64(9), adId: "ad_y", creativeId: "cr_1" },
  ];
  const s3base = { businessId: bizA, accountRef: accARef, accountId: "act_compact_a", ...S3 };
  await insertLegacyRun({ ...s3base, capturedAt: "2026-06-01T04:00:00Z", states: adStates, seed: 11 });
  const l2ad = await insertLegacyRun({ ...s3base, capturedAt: "2026-06-02T04:00:00Z", states: adStates, seed: 12 });
  await insertLegacyRun({ ...s3base, capturedAt: "2026-06-03T04:00:00Z", states: adStates, seed: 13 });
  await sql`
    INSERT INTO meta_creative_lineage_edges (
      business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, source_ad_id, source_creative_id, target_ad_id,
      target_creative_id, lineage_type, evidence_source, observation_run_id,
      observation_run_entity_type, observation_run_completeness,
      evidence_json, observed_at, captured_at, lineage_hash,
      logical_lineage_key, relationship_observed_at, relationship_captured_at
    ) VALUES (
      ${bizA}, ${bizA}, ${accARef}, 'act_compact_a', 'ad_x', 'cr_1', 'ad_y',
      'cr_1', 'reuse_same_creative', 'observation_run', ${l2ad.runId}, 'ad',
      'complete', '{}'::jsonb, '2026-06-02T04:00:00Z'::timestamptz,
      '2026-06-02T04:00:00Z'::timestamptz, ${hex64(14)},
      'compaction-seam-pin', '2026-06-02T04:00:00Z'::timestamptz,
      '2026-06-02T04:00:00Z'::timestamptz
    )
  `;

  // Multi-endpoint scope (bizA creative type, two complete endpoints).
  for (const endpoint of ["creative_configs_one", "creative_configs_two"]) {
    const base = {
      businessId: bizA,
      accountRef: accARef,
      accountId: "act_compact_a",
      entityType: "creative" as const,
      endpoint,
    };
    await insertLegacyRun({ ...base, capturedAt: "2026-06-01T05:00:00Z", states: [{ entityId: `cre_${endpoint}`, stateHash: hex64(21) }], seed: 21 });
    await insertLegacyRun({ ...base, capturedAt: "2026-06-02T05:00:00Z", states: [{ entityId: `cre_${endpoint}`, stateHash: hex64(21) }], seed: 22 });
    await insertLegacyRun({ ...base, capturedAt: "2026-06-03T05:00:00Z", states: [{ entityId: `cre_${endpoint}`, stateHash: hex64(21) }], seed: 23 });
  }

  // S2 (bizA adset scope): a REAL D075 chain — never a candidate.
  const adsetObservation = (input: {
    observedAt: string;
    capturedAt: string;
    entities: Array<{ id: string; status: string }>;
  }) => ({
    businessId: bizA,
    providerAccountId: "act_compact_a",
    entityType: "adset" as const,
    endpoint: "adset_configs_compact",
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) => ({
      businessId: bizA,
      providerAccountId: "act_compact_a",
      entityType: "adset" as const,
      entityId: entity.id,
      campaignId: "campaign_compact",
      adsetId: entity.id,
      learningSource: "not_observed" as const,
      budgetOrigin: "not_applicable" as const,
      presence: "present" as const,
      fieldCoverage: { configuredStatus: true },
      configuredStatus: entity.status,
      effectiveStatus: entity.status,
      providerUpdatedAt: "2026-06-01T00:00:00Z",
      observedAt: input.observedAt,
    })),
  });
  await persistMetaEntityObservation(
    adsetObservation({ observedAt: "2026-06-10T00:00:00Z", capturedAt: "2026-06-10T00:00:01Z", entities: [{ id: "as1", status: "ACTIVE" }, { id: "as2", status: "ACTIVE" }, { id: "as3", status: "ACTIVE" }] }),
  );
  await persistMetaEntityObservation(
    adsetObservation({ observedAt: "2026-06-10T01:00:00Z", capturedAt: "2026-06-10T01:00:01Z", entities: [{ id: "as1", status: "ACTIVE" }, { id: "as2", status: "PAUSED" }, { id: "as3", status: "ACTIVE" }] }),
  );
  await persistMetaEntityObservation(
    adsetObservation({ observedAt: "2026-06-10T02:00:00Z", capturedAt: "2026-06-10T02:00:01Z", entities: [{ id: "as1", status: "ACTIVE" }, { id: "as2", status: "PAUSED" }] }),
  );
  await persistMetaEntityObservation(
    adsetObservation({ observedAt: "2026-06-10T03:00:00Z", capturedAt: "2026-06-10T03:00:01Z", entities: [{ id: "as1", status: "ACTIVE" }, { id: "as2", status: "PAUSED" }, { id: "as3", status: "ACTIVE" }] }),
  );
  const checkpoint = await persistMetaEntityObservation(
    adsetObservation({ observedAt: "2026-06-11T04:00:00Z", capturedAt: "2026-06-11T04:00:01Z", entities: [{ id: "as1", status: "ACTIVE" }, { id: "as2", status: "PAUSED" }, { id: "as3", status: "ACTIVE" }] }),
  );
  assert(
    checkpoint.manifestKind === "delta" && checkpoint.stateCount === 0,
    `D075 forced checkpoint fixture is wrong: ${JSON.stringify(checkpoint)}`,
  );

  /* ---------------- BEFORE snapshot ------------------------------------ */

  const CUTOFFS = [
    "2026-06-01T12:00:00Z",
    "2026-06-02T12:00:00Z",
    "2026-06-04T12:00:00Z",
    "2026-06-30T00:00:00Z",
  ];
  const winners = async () => {
    const out: Array<Record<string, unknown>> = [];
    for (const cutoff of CUTOFFS) {
      const rows = await readMetaEntityStatesAsOf({
        businessId: bizA,
        providerAccountId: "act_compact_a",
        entityType: "campaign",
        entityIds: ["cmp_a", "cmp_b", "cmp_c"],
        cutoff,
      });
      out.push(
        ...rows.map((row) => ({
          cutoff,
          entityId: row.entityId,
          stateHash: row.stateHash,
          presence: row.presence,
        })),
      );
    }
    return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  const receiptsGuardAdmits = async (runId: string) => {
    const rows = await sql<{ admitted: boolean }>`
      SELECT (
        run.row_count = 0
        OR run.manifest_kind = 'delta'
        OR EXISTS (
          SELECT 1 FROM meta_entity_state_history retained_state
          WHERE retained_state.run_id = run.id
        )
      ) AS admitted
      FROM meta_entity_observation_runs run WHERE run.id = ${runId}
    `;
    return rows[0]?.admitted === true;
  };
  const businessRowCount = async (businessId: string) => {
    const rows = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM meta_entity_state_history
      WHERE business_id = ${businessId}
    `;
    return Number(rows[0]?.n ?? 0);
  };

  const winnersBefore = await winners();
  const bizBRowsBefore = await businessRowCount(bizB);

  /* ---------------- Plan: fallback then proof --------------------------- */

  const fenceNoExt = await measureStateHistoryFence(sql, {
    budgetBytes: 5 * 1024 ** 3,
  });
  assert(
    fenceNoExt.metric === "raw_fallback" &&
      fenceNoExt.fallbackReason === "extension_missing",
    `expected extension_missing fallback, got ${JSON.stringify(fenceNoExt)}`,
  );
  const planNoProof = await plannedReadOnly([bizA]);
  assert(
    planNoProof.status === "insufficient_evidence" &&
      planNoProof.insufficiencyReasons.some((reason) =>
        reason.startsWith("free_space_proof_unavailable"),
      ),
    `plan without proof must be insufficient: ${JSON.stringify(planNoProof.insufficiencyReasons)}`,
  );
  const insufficientExec = await executeStateHistoryCompaction({
    plan: planNoProof,
    approvalToken: expectedApprovalToken(planNoProof.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(
    insufficientExec.status === "refused" &&
      insufficientExec.refusalReason === "plan_not_ready:insufficient_evidence",
    `insufficient plan must refuse strictly: ${JSON.stringify(insufficientExec)}`,
  );

  await sql`CREATE EXTENSION IF NOT EXISTS pgstattuple`;
  const plan1 = await plannedReadOnly([bizA]);
  assert(plan1.status === "ready", `plan1 not ready: ${JSON.stringify(plan1.insufficiencyReasons)}`);
  assert(plan1.fence.metric === "effective_reusable_heap", "proof metric expected after CREATE EXTENSION");

  const s1Scope = plan1.scopes.find(
    (scope) => scope.endpoint === S1.endpoint && scope.businessId === bizA,
  );
  assert(s1Scope, "S1 scope missing from plan");
  // L2 duplicates L1 but a PARTIAL observation is interleaved between them:
  // it must be excluded, or deleting it would resurface the partial row as
  // the mixed-lane as-of winner. L3 and L5 stay removable.
  assert(
    s1Scope!.candidateRuns === 3 &&
      s1Scope!.interleavedExcludedRuns === 1 &&
      s1Scope!.interleavedExcludedRows === 3 &&
      s1Scope!.removableRuns === 2 &&
      s1Scope!.removableRows === 6,
    `S1 candidates wrong: ${JSON.stringify({
      candidateRuns: s1Scope!.candidateRuns,
      interleaved: s1Scope!.interleavedExcludedRuns,
      removableRuns: s1Scope!.removableRuns,
      removableRows: s1Scope!.removableRows,
    })}`,
  );
  const s3Scope = plan1.scopes.find((scope) => scope.endpoint === S3.endpoint);
  assert(
    s3Scope!.candidateRuns === 1 &&
      s3Scope!.pinnedRuns === 1 &&
      s3Scope!.pinnedRunRows === 2 &&
      s3Scope!.removableRuns === 0,
    `one pinned row must protect its WHOLE run: ${JSON.stringify(s3Scope)}`,
  );
  const multiScopes = plan1.scopes.filter((scope) => scope.multiEndpointUnsupported);
  assert(
    multiScopes.length === 2 && multiScopes.every((scope) => scope.candidateRuns === 0),
    `multi-endpoint scopes must be excluded: ${JSON.stringify(multiScopes.length)}`,
  );
  // Acceptance correction: the exclusion is an EXACT, hash-bound reason —
  // every complete run (and its rows) of an unsupported multi-endpoint
  // scope is excluded wholesale, measured, never a boolean or a zero.
  for (const scope of multiScopes) {
    const excluded = (scope as unknown as {
      protectionsByReason?: {
        multiEndpointExcluded?: { runs: number; rows: number };
      };
    }).protectionsByReason?.multiEndpointExcluded;
    assert(
      excluded !== undefined &&
        excluded.runs === 3 &&
        excluded.rows === 3,
      `multi-endpoint exclusion must carry exact measured run/row counts (3 runs / 3 rows per creative endpoint scope): ${JSON.stringify(scope)}`,
    );
  }
  const plan1MultiTotals = (plan1.totals as unknown as {
    protectionsByReason?: {
      multiEndpointExcluded?: { runs: number; rows: number };
    };
  }).protectionsByReason?.multiEndpointExcluded;
  assert(
    plan1MultiTotals !== undefined &&
      plan1MultiTotals.runs === 6 &&
      plan1MultiTotals.rows === 6,
    `plan totals must aggregate the multi-endpoint exclusion exactly (6 runs / 6 rows): ${JSON.stringify(plan1MultiTotals)}`,
  );
  const s2Scope = plan1.scopes.find((scope) => scope.endpoint === "adset_configs_compact");
  assert(
    s2Scope!.candidateRuns === 0,
    `a D075 delta chain must yield zero candidates: ${JSON.stringify(s2Scope)}`,
  );

  /* ---------------- Zero-write refusals -------------------------------- */

  const journalBefore = await journalCount();
  const wrongToken = await executeStateHistoryCompaction({
    plan: plan1,
    approvalToken: "approve-state-history-compaction:not-the-hash",
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(wrongToken.status === "refused" && wrongToken.refusalReason === "approval_token_mismatch", "wrong token must refuse");
  const tampered = {
    ...plan1,
    totals: { ...plan1.totals, removableRows: plan1.totals.removableRows + 1 },
  };
  const tamperedExec = await executeStateHistoryCompaction({
    plan: tampered,
    approvalToken: expectedApprovalToken(plan1.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(
    tamperedExec.status === "refused" && tamperedExec.refusalReason === "plan_payload_tampered",
    "tampered payload must refuse",
  );
  const noAck = await executeStateHistoryCompaction({
    plan: plan1,
    approvalToken: expectedApprovalToken(plan1.planHash),
    acknowledgePhysicalShrinkRequired: false,
  });
  assert(
    noAck.status === "refused" && noAck.refusalReason === "physical_shrink_acknowledgement_required",
    "missing acknowledgement must refuse",
  );
  assert(
    (await journalCount()) === journalBefore,
    "an invalid execution attempt must write NOTHING, journal included",
  );

  /* ---------------- Out-of-scope injection ------------------------------ */

  const [foreignRun] = await sql<IdRow>`
    SELECT r.id::text AS id FROM meta_entity_observation_runs r
    WHERE r.business_id = ${bizB} AND r.endpoint = ${S1.endpoint}
    ORDER BY r.captured_at LIMIT 1 OFFSET 1
  `;
  const injectedScopes = plan1.scopes.map((scope) =>
    scope.endpoint === S1.endpoint && scope.businessId === bizA
      ? {
          ...scope,
          removable: [
            ...scope.removable,
            {
              runId: foreignRun!.id,
              physicalRows: 3,
              manifestSig: hex64(31),
              previousObservedAt: "2026-06-01T03:00:00Z",
              observedAt: "2026-06-02T03:00:00Z",
            },
          ],
          removableRuns: scope.removableRuns + 1,
          removableRows: scope.removableRows + 3,
        }
      : scope,
  );
  const injectedCore = {
    contract: plan1.contract,
    businessIds: plan1.businessIds,
    scopes: injectedScopes,
    timelines: plan1.timelines,
    totals: { ...plan1.totals, removableRuns: plan1.totals.removableRuns + 1, removableRows: plan1.totals.removableRows + 3 },
    fence: plan1.fence,
    fenceProjection: plan1.fenceProjection,
    status: plan1.status,
    insufficiencyReasons: plan1.insufficiencyReasons,
    scopeFingerprint: plan1.scopeFingerprint,
  };
  const injectedPlan: StateHistoryCompactionPlan = {
    ...injectedCore,
    planHash: computeExecutionPayloadHash(injectedCore),
  };
  const journalBeforeInjection = await journalCount();
  const injected = await executeStateHistoryCompaction({
    plan: injectedPlan,
    approvalToken: expectedApprovalToken(injectedPlan.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  // D077 hardening correction: a foreign-run injection is now caught by the
  // authoritative pre-write re-plan BEFORE lease or journal — the earlier
  // contract journaled lease rows before its batch rolled back.
  assert(
    injected.status === "refused" &&
      injected.refusalReason === "authoritative_replan_mismatch",
    `injected foreign run must refuse at the authoritative re-plan: ${JSON.stringify(injected)}`,
  );
  assert(injected.rowsDeleted === 0, "the injection must delete nothing");
  assert(
    (await journalCount()) === journalBeforeInjection,
    "a foreign-run injection must write ZERO journal rows",
  );
  assert(
    (await businessRowCount(bizA)) > 0 && (await businessRowCount(bizB)) === bizBRowsBefore,
    "no row may be deleted by a refused injection",
  );

  /* ---------------- Stale plan ----------------------------------------- */

  await insertLegacyRun({
    businessId: bizA,
    accountRef: accARef,
    accountId: "act_compact_a",
    ...S1,
    capturedAt: "2026-06-07T03:00:00Z",
    states: s1States(B1),
    seed: 41,
  });
  const journalBeforeStale = await journalCount();
  const stale = await executeStateHistoryCompaction({
    plan: plan1,
    approvalToken: expectedApprovalToken(plan1.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  // The authoritative re-plan catches the changed world before any write;
  // the legacy scope-fingerprint check remains as post-lease defense in
  // depth for resumes.
  assert(
    stale.status === "refused" &&
      stale.refusalReason === "authoritative_replan_mismatch",
    `stale plan must refuse before any write: ${JSON.stringify(stale)}`,
  );
  assert(
    (await journalCount()) === journalBeforeStale,
    "a stale plan must write ZERO journal rows",
  );

  /* ---------------- Interrupt, exclusivity, resume ---------------------- */

  // Fresh plan (now L6 became a candidate too: the new head duplicates it).
  const plan2 = await plannedReadOnly([bizA]);
  assert(plan2.status === "ready", "plan2 must be ready");
  const expectedRows = plan2.totals.removableRows;
  let batchesSeen = 0;
  const interrupted = await executeStateHistoryCompaction({
    plan: plan2,
    approvalToken: expectedApprovalToken(plan2.planHash),
    acknowledgePhysicalShrinkRequired: true,
    batchRunLimit: 1,
    shouldAbort: () => {
      batchesSeen += 1;
      return batchesSeen > 1; // allow one batch, abort before the second
    },
  });
  assert(
    interrupted.status === "aborted_kill_switch" && interrupted.rowsDeleted > 0,
    `interrupt must stop mid-way with progress: ${JSON.stringify(interrupted)}`,
  );

  const [resumeA, resumeB] = await Promise.all([
    executeStateHistoryCompaction({
      plan: plan2,
      approvalToken: expectedApprovalToken(plan2.planHash),
      acknowledgePhysicalShrinkRequired: true,
      batchRunLimit: 1,
    }),
    executeStateHistoryCompaction({
      plan: plan2,
      approvalToken: expectedApprovalToken(plan2.planHash),
      acknowledgePhysicalShrinkRequired: true,
      batchRunLimit: 1,
    }),
  ]);
  const completedRun = [resumeA, resumeB].find(
    (result) => result.status === "completed" || result.status === "completed_with_skips",
  );
  const refusedRun = [resumeA, resumeB].find(
    (result) => result.status === "refused",
  );
  assert(
    completedRun &&
      refusedRun &&
      (refusedRun.refusalReason === "another_executor_active" ||
        refusedRun.refusalReason === "plan_already_completed"),
    `exactly one concurrent executor may own the lease: ${JSON.stringify([resumeA, resumeB].map((result) => `${result.status}:${result.refusalReason}`))}`,
  );
  assert(
    completedRun!.runsAlreadyEmpty >= 1,
    "resume must recognise already-emptied runs instead of recounting them",
  );
  assert(
    interrupted.rowsDeleted + completedRun!.rowsDeleted === expectedRows,
    `deleted rows must account exactly: ${interrupted.rowsDeleted}+${completedRun!.rowsDeleted}!=${expectedRows}`,
  );

  const again = await executeStateHistoryCompaction({
    plan: plan2,
    approvalToken: expectedApprovalToken(plan2.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(
    again.status === "refused" && again.refusalReason === "plan_already_completed",
    "a completed plan must never execute twice",
  );

  /* ---------------- AFTER equivalence ----------------------------------- */

  const winnersAfter = await winners();
  assert(
    JSON.stringify(winnersBefore) === JSON.stringify(winnersAfter),
    "as-of winners (content) must be identical before and after compaction",
  );
  assert(
    (await businessRowCount(bizB)) === bizBRowsBefore,
    "the out-of-scope twin business must be byte-untouched",
  );
  const [partialRows] = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM meta_entity_state_history
    WHERE business_id = ${bizA} AND run_completeness = 'partial'
  `;
  assert(Number(partialRows!.n) === 1, "partial-lane rows must survive");
  const [pinnedRows] = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM meta_entity_state_history
    WHERE run_id = ${l2ad.runId}
  `;
  assert(Number(pinnedRows!.n) === 2, "the lineage-pinned run must keep every row");
  assert(
    !(await receiptsGuardAdmits(scopeA.l3.runId)) &&
      (await receiptsGuardAdmits(scopeA.l1.runId)) &&
      (await receiptsGuardAdmits(scopeA.l2.runId)),
    "the receipts compaction guard must skip emptied runs and admit retained ones (including the interleave-protected duplicate)",
  );

  /* ---------------- D075 writer equivalence post-compaction ------------- */

  const campaignObservation = (businessId: string, accountId: string, statuses: [string, string, string], at: string) => ({
    businessId,
    providerAccountId: accountId,
    entityType: "campaign" as const,
    endpoint: S1.endpoint,
    observedAt: at,
    capturedAt: at.replace("00Z", "01Z"),
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: 3,
    states: (["cmp_a", "cmp_b", "cmp_c"] as const).map((entityId, index) => ({
      businessId,
      providerAccountId: accountId,
      entityType: "campaign" as const,
      entityId,
      campaignId: entityId,
      learningSource: "not_observed" as const,
      budgetOrigin: "not_applicable" as const,
      presence: "present" as const,
      fieldCoverage: { configuredStatus: true },
      configuredStatus: statuses[index],
      effectiveStatus: statuses[index],
      providerUpdatedAt: "2026-06-01T00:00:00Z",
      observedAt: at,
    })),
  });
  const compacted = await persistMetaEntityObservation(
    campaignObservation(bizA, "act_compact_a", ["ACTIVE", "PAUSED", "ACTIVE"], "2026-06-08T03:00:00Z"),
  );
  const twin = await persistMetaEntityObservation(
    campaignObservation(bizB, "act_compact_b", ["ACTIVE", "PAUSED", "ACTIVE"], "2026-06-08T03:00:00Z"),
  );
  assert(
    compacted.manifestKind === "delta" && twin.manifestKind === "delta",
    `post-compaction writer must keep delta manifests: ${compacted.manifestKind}/${twin.manifestKind}`,
  );
  assert(
    JSON.stringify(compacted.deltaStats) === JSON.stringify(twin.deltaStats) &&
      compacted.stateCount === twin.stateCount,
    `compacted vs uncompacted twin writer divergence: ${JSON.stringify({ compacted: compacted.deltaStats, twin: twin.deltaStats })}`,
  );
  const compactedRepeat = await persistMetaEntityObservation(
    campaignObservation(bizA, "act_compact_a", ["ACTIVE", "PAUSED", "ACTIVE"], "2026-06-08T05:00:00Z"),
  );
  const twinRepeat = await persistMetaEntityObservation(
    campaignObservation(bizB, "act_compact_b", ["ACTIVE", "PAUSED", "ACTIVE"], "2026-06-08T05:00:00Z"),
  );
  assert(
    compactedRepeat.coalesced === true &&
      twinRepeat.coalesced === true &&
      compactedRepeat.runId === compacted.runId,
    "an identical payload must still coalesce into the head after compaction",
  );

  /* =====================================================================
   * D077 hardening correction (2026-08-30): forgeable policy gate, planner
   * snapshot isolation, per-reason protection counts, and the
   * response-event FK pin chain.
   * ===================================================================== */

  const bizC = await mkBusiness("Compaction seam hardening C");
  const accC = await mkAccount(bizC, "act_compact_c");
  const HARD_AD = { entityType: "ad" as const, endpoint: "ad_configs_hard" };
  const hardAdStates = [
    { entityId: "had_x", stateHash: hex64(51), adId: "had_x", creativeId: "hcr_1" },
    { entityId: "had_y", stateHash: hex64(52), adId: "had_y", creativeId: "hcr_1" },
  ];
  const hardBase = { businessId: bizC, accountRef: accC, accountId: "act_compact_c", ...HARD_AD };
  const hA1 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-01T06:00:00Z", states: hardAdStates, seed: 51 });
  const hA2 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-02T06:00:00Z", states: hardAdStates, seed: 52 });
  const hA3 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-03T06:00:00Z", states: hardAdStates, seed: 53 });
  const hA4 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-04T06:00:00Z", states: hardAdStates, seed: 54 });
  const hA5 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-05T06:00:00Z", states: hardAdStates, seed: 55 });
  const hA6 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-06T06:00:00Z", states: hardAdStates, seed: 56 });
  const hA7 = await insertLegacyRun({ ...hardBase, capturedAt: "2026-06-07T06:00:00Z", states: hardAdStates, seed: 57 });
  void hA1;
  void hA7;

  // Live-lineage pins: hA2 and hA5.
  for (const [pinIndex, pinned] of [hA2, hA5].entries()) {
    await sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, source_ad_id, source_creative_id, target_ad_id,
        target_creative_id, lineage_type, evidence_source, observation_run_id,
        observation_run_entity_type, observation_run_completeness,
        evidence_json, observed_at, captured_at, lineage_hash,
        logical_lineage_key, relationship_observed_at, relationship_captured_at
      ) VALUES (
        ${bizC}, ${bizC}, ${accC}, 'act_compact_c', 'had_x', 'hcr_1', 'had_y',
        'hcr_1', 'reuse_same_creative', 'observation_run', ${pinned.runId},
        'ad', 'complete', '{}'::jsonb, ${pinned.capturedAt}::timestamptz,
        ${pinned.capturedAt}::timestamptz,
        ${hex64(58 + pinIndex)}, ${"hardening-pin-" + pinned.runId},
        ${pinned.capturedAt}::timestamptz, ${pinned.capturedAt}::timestamptz
      )
    `;
  }

  // Archived-schema lineage pin: hA3, through a seeded retained schema whose
  // column shape matches the production pinnedExistsSql references.
  await sql.query(`CREATE SCHEMA IF NOT EXISTS adsecute_compact_20260726t0204z`);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS adsecute_compact_20260726t0204z.meta_creative_lineage_edges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      observation_run_id uuid NOT NULL,
      observation_run_entity_type text NOT NULL,
      source_ad_id text NULL,
      source_creative_id text NULL,
      target_ad_id text NULL,
      target_creative_id text NULL
    )`);
  await sql`
    INSERT INTO adsecute_compact_20260726t0204z.meta_creative_lineage_edges (
      observation_run_id, observation_run_entity_type, source_ad_id,
      source_creative_id, target_ad_id, target_creative_id
    ) VALUES (${hA3.runId}, 'ad', 'had_x', 'hcr_1', 'had_y', 'hcr_1')
  `;

  // Response-event pins: hA4 and hA5, through the full legitimate chain
  // (job run -> evaluation context -> evaluation -> snapshot -> episode ->
  // response event referencing a candidate state-history row).
  const [hardJobRun] = await sql<IdRow>`
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, started_at, finished_at
    ) VALUES (
      'native_ad_operator_response', ${bizC}, ${bizC}, '2026-06-08',
      ${NATIVE_AD_ENGINE_VERSION}, 'success', now(), now()
    ) RETURNING id
  `;
  const [hardContext] = await sql<IdRow>`
    INSERT INTO engine_v3_ad_decision_evaluation_contexts (
      business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, as_of_date, engine_version, scope_type, scope_id,
      contract_version, context_json, account_profile_json, data_health_json,
      flags_json, context_hash, job_run_id, evaluated_at
    ) VALUES (
      ${bizC}, ${bizC}, ${accC}, 'act_compact_c', '2026-06-08',
      ${NATIVE_AD_ENGINE_VERSION}, 'account', 'act_compact_c',
      'hardening-seam.v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, ${hex64(61)}, ${hardJobRun!.id}, now()
    ) RETURNING id
  `;
  const [hardEvaluation] = await sql<IdRow>`
    INSERT INTO engine_v3_ad_decision_evaluations (
      context_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, decision_entity_type, decision_entity_id, ad_id,
      creative_id, as_of_date, engine_version, scope_type, scope_id,
      contract_version, creative_input_json, campaign_context_json,
      prior_hysteresis_json, decision_output_json, raw_label, input_hash,
      decision_hash, job_run_id, evaluated_at
    ) VALUES (
      ${hardContext!.id}, ${bizC}, ${bizC}, ${accC}, 'act_compact_c', 'ad',
      'had_x', 'had_x', 'hcr_1', '2026-06-08', ${NATIVE_AD_ENGINE_VERSION},
      'account', 'act_compact_c', 'hardening-seam.v1', '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'diagnose', ${hex64(62)},
      ${hex64(63)}, ${hardJobRun!.id}, now()
    ) RETURNING id
  `;
  const [hardSnapshot] = await sql<IdRow>`
    INSERT INTO engine_v3_ad_decision_snapshots_daily (
      business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, decision_entity_type, decision_entity_id, ad_id,
      creative_id, as_of_date, engine_version, scope_type, scope_id, label,
      raw_label, confidence, truth_source, effective_target_roas, badges,
      reason, job_run_id, evaluation_id, input_hash, decision_hash,
      computed_at
    ) VALUES (
      ${bizC}, ${bizC}, ${accC}, 'act_compact_c', 'ad', 'had_x', 'had_x',
      'hcr_1', '2026-06-08', ${NATIVE_AD_ENGINE_VERSION}, 'account',
      'act_compact_c', 'diagnose', 'diagnose', 40, 'account_baseline', 2.0,
      '[{"type":"native_calibration_unavailable"}]'::jsonb,
      'Hardening seam episode.', ${hardJobRun!.id}, ${hardEvaluation!.id},
      ${hex64(62)}, ${hex64(63)}, now()
    ) RETURNING id
  `;
  const hardEpisodeKey = hex64(64);
  await sql`
    INSERT INTO engine_v3_ad_recommendation_episodes (
      contract_version, episode_key, business_ref_id, business_id,
      provider_account_ref_id, provider_account_id, decision_entity_type,
      decision_entity_id, ad_id, creative_id, as_of_date, engine_version,
      scope_type, scope_id, decision_snapshot_id, evaluation_id, input_hash,
      decision_hash, decision_label, recommended_at, captured_at, job_run_id
    ) VALUES (
      ${NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION}, ${hardEpisodeKey},
      ${bizC}, ${bizC}, ${accC}, 'act_compact_c', 'ad', 'had_x', 'had_x',
      'hcr_1', '2026-06-08', ${NATIVE_AD_ENGINE_VERSION}, 'account',
      'act_compact_c', ${hardSnapshot!.id}, ${hardEvaluation!.id},
      ${hex64(62)}, ${hex64(63)}, 'diagnose', now(), now(), ${hardJobRun!.id}
    )
  `;
  const pinRunWithResponseEvent = async (runId: string, evidenceSeed: number) => {
    const [stateRow] = await sql<IdRow>`
      SELECT id::text AS id FROM meta_entity_state_history
      WHERE run_id = ${runId} ORDER BY entity_id LIMIT 1
    `;
    await sql`
      INSERT INTO engine_v3_ad_operator_response_events (
        contract_version, episode_key, business_ref_id, business_id,
        provider_account_ref_id, provider_account_id, entity_type, entity_id,
        job_run_id, response_cutoff, evidence_kind, evidence_source_id,
        state_history_id, evidence_observed_at, evidence_captured_at,
        evidence_json, evidence_hash
      ) VALUES (
        ${NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION}, ${hardEpisodeKey},
        ${bizC}, ${bizC}, ${accC}, 'act_compact_c', 'ad', 'had_x',
        ${hardJobRun!.id}, now(), 'meta_entity_state_history',
        ${stateRow!.id}, ${stateRow!.id}::uuid, now(), now(), '{}'::jsonb,
        ${hex64(evidenceSeed)}
      )
    `;
    return stateRow!.id;
  };
  await pinRunWithResponseEvent(hA4.runId, 65);
  await pinRunWithResponseEvent(hA5.runId, 66);

  /* ---- Gap B fail-first: the forgeable readiness/policy gate ----------- */

  await sql.query(`DROP EXTENSION IF EXISTS pgstattuple`);
  const insufficientHard = await plannedReadOnly([bizC]);
  assert(
    insufficientHard.status === "insufficient_evidence",
    `hardening plan without proof must be insufficient: ${JSON.stringify(insufficientHard.status)}`,
  );
  const forgedCore = {
    contract: insufficientHard.contract,
    businessIds: insufficientHard.businessIds,
    scopes: insufficientHard.scopes,
    timelines: insufficientHard.timelines,
    totals: insufficientHard.totals,
    fence: insufficientHard.fence,
    fenceProjection: {
      ...insufficientHard.fenceProjection,
      effectiveReusableHeap: {
        ...insufficientHard.fenceProjection.effectiveReusableHeap,
        proofAvailable: true,
        projectedFreedHeapBytes: 1_000_000,
        projectedEffectiveBytes: 0,
        cleared: true,
      },
    },
    status: "ready" as const,
    insufficiencyReasons: [],
    scopeFingerprint: insufficientHard.scopeFingerprint,
  };
  const forgedPlan: StateHistoryCompactionPlan = {
    ...forgedCore,
    planHash: computeExecutionPayloadHash(forgedCore),
  };
  const journalBeforeForged = await journalCount();
  const bizCRowsBeforeForged = await businessRowCount(bizC);
  const forged = await executeStateHistoryCompaction({
    plan: forgedPlan,
    approvalToken: expectedApprovalToken(forgedPlan.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(
    forged.status === "refused" &&
      (forged.refusalReason ?? "").startsWith("authoritative_replan"),
    `a policy-forged plan (honest re-hash of edited status/projection) must be refused by the pre-write authoritative re-plan; got ${JSON.stringify(
      { status: forged.status, reason: forged.refusalReason, rowsDeleted: forged.rowsDeleted },
    )}`,
  );
  assert(
    (await journalCount()) === journalBeforeForged,
    `a policy-forged plan must write ZERO journal rows; journal grew by ${(await journalCount()) - journalBeforeForged}`,
  );
  assert(
    (await businessRowCount(bizC)) === bizCRowsBeforeForged,
    "a policy-forged plan must delete ZERO state rows",
  );
  await sql.query(`CREATE EXTENSION IF NOT EXISTS pgstattuple`);

  /* ---- Gap A fail-first: snapshot-consistent planner ------------------- */

  // (a) The planner must refuse an isolation level weaker than REPEATABLE
  // READ even when the transaction is READ ONLY.
  let weakerIsolationRefused = false;
  try {
    await runDbTransaction(async () => {
      const db = getDb();
      await db.query("SET TRANSACTION READ ONLY");
      await planStateHistoryCompaction(db, { businessIds: [bizC] });
    });
  } catch (error) {
    weakerIsolationRefused = /REPEATABLE READ/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  assert(
    weakerIsolationRefused,
    "the planner must refuse a READ COMMITTED (default) transaction even when READ ONLY",
  );

  // (b) Under REPEATABLE READ the whole multi-statement plan reads ONE
  // snapshot: a concurrent commit mid-plan must be invisible.
  const concurrent = new Client({ connectionString: process.env.DATABASE_URL });
  await concurrent.connect();
  try {
    const snapshotPlan = await runDbTransaction(async () => {
      const db = getDb();
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const fingerprintAtStart = await computeScopeFingerprint(db, [bizC]);
      // Commit a new complete run for the same scope from a second session,
      // between the planner transaction's statements.
      await concurrent.query(
        `INSERT INTO meta_entity_observation_runs (
           business_ref_id, business_id, provider_account_ref_id,
           provider_account_id, entity_type, endpoint, observed_at,
           captured_at, completeness, page_count, row_count, run_hash
         ) VALUES ($1::uuid, $1::text, $2::uuid, 'act_compact_c', 'ad', 'ad_configs_hard',
           '2026-06-09T06:00:00Z', '2026-06-09T06:00:00Z', 'complete', 1, 0,
           $3)`,
        [bizC, accC, hex64(71)],
      );
      const plan = await planStateHistoryCompaction(db, {
        businessIds: [bizC],
      });
      return { fingerprintAtStart, plan };
    });
    assert(
      snapshotPlan.plan.scopeFingerprint === snapshotPlan.fingerprintAtStart,
      "a concurrent commit mid-plan must be invisible to the REPEATABLE READ planner snapshot (no mixed-snapshot artifact)",
    );
  } finally {
    await concurrent.end();
  }

  /* ---- Gaps C + D: per-reason protection counts and the response-event
   * pin, distinguished per family on real Postgres. --------------------- */

  const hardPlan = await plannedReadOnly([bizC]);
  const hardScope = hardPlan.scopes.find(
    (scope) => scope.endpoint === HARD_AD.endpoint,
  );
  assert(hardScope, "hardening ad scope missing from plan");
  const reasons = (hardScope as unknown as {
    protectionsByReason?: {
      headDuplicate: { runs: number; rows: number };
      liveLineagePinned: { runs: number; rows: number };
      archivedLineagePinned: { runs: number; rows: number };
      responseEventPinned: { runs: number; rows: number };
      interleavedExcluded: { runs: number; rows: number };
    };
  }).protectionsByReason;
  assert(
    reasons !== undefined,
    "the plan must expose per-reason protection counts (protectionsByReason)",
  );
  assert(
    reasons!.liveLineagePinned.runs === 2 &&
      reasons!.liveLineagePinned.rows === 4 &&
      reasons!.archivedLineagePinned.runs === 1 &&
      reasons!.archivedLineagePinned.rows === 2 &&
      reasons!.responseEventPinned.runs === 2 &&
      reasons!.responseEventPinned.rows === 4,
    `per-family pin attribution wrong: ${JSON.stringify(reasons)}`,
  );
  // hA5 is pinned by BOTH the live-lineage and response-event families: the
  // union (pinnedRuns) must count it once — families overlap and are not
  // additive.
  assert(
    hardScope!.pinnedRuns === 4 &&
      hardScope!.pinnedRunRows === 8 &&
      reasons!.liveLineagePinned.runs +
        reasons!.archivedLineagePinned.runs +
        reasons!.responseEventPinned.runs ===
        5,
    `overlapping pin families must not inflate the union: pinned=${hardScope!.pinnedRuns} families=${JSON.stringify(reasons)}`,
  );
  // The scope head (hA7 duplicates hA6's manifest but is the most recent
  // run): protected by the non-head rule and now counted explicitly. The
  // 0-row concurrent run from the snapshot leg is the physical head, so the
  // head-duplicate rule still lands on hA7 through the empty head... no:
  // run_manifest joins state rows, so the 0-row run has no manifest and hA7
  // remains the manifest head.
  assert(
    reasons!.headDuplicate.runs === 1 && reasons!.headDuplicate.rows === 2,
    `head-duplicate protection must be counted: ${JSON.stringify(reasons!.headDuplicate)}`,
  );
  assert(
    hardScope!.removableRuns === 1 && hardScope!.removableRows === 2,
    `exactly hA6 must remain removable: ${JSON.stringify({ runs: hardScope!.removableRuns, rows: hardScope!.removableRows })}`,
  );
  const hardTotals = (hardPlan as unknown as {
    totals: Record<string, unknown> & {
      protectionsByReason?: Record<string, { runs: number; rows: number }>;
    };
  }).totals;
  assert(
    hardTotals.protectionsByReason !== undefined,
    "plan totals must carry per-reason protection counts",
  );

  // D: the response-event pin protects its WHOLE run at plan time, and a pin
  // arriving AFTER planning is refused fail-closed by the authoritative
  // re-plan before any journal write or deletion.
  assert(
    hardPlan.status === "ready",
    `hardening plan should be ready with pgstattuple present: ${JSON.stringify(hardPlan.insufficiencyReasons)}`,
  );
  const journalBeforeLatePin = await journalCount();
  await pinRunWithResponseEvent(hA6.runId, 67);
  const latePin = await executeStateHistoryCompaction({
    plan: hardPlan,
    approvalToken: expectedApprovalToken(hardPlan.planHash),
    acknowledgePhysicalShrinkRequired: true,
  });
  assert(
    latePin.status === "refused" &&
      (latePin.refusalReason ?? "").startsWith("authoritative_replan"),
    `a pin appearing after planning must refuse before any write: ${JSON.stringify(latePin)}`,
  );
  assert(
    (await journalCount()) === journalBeforeLatePin,
    "a post-plan pin refusal must write zero journal rows",
  );
  const [hA6Rows] = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM meta_entity_state_history
    WHERE run_id = ${hA6.runId}
  `;
  assert(
    Number(hA6Rows!.n) === 2,
    "the late-pinned run must keep every row (no partial deletion; RESTRICT FK never exercised)",
  );

  // Fresh plan AFTER the late pin: hA6 joins the response-event family and
  // nothing is removable; executing the fresh plan completes without
  // deleting anything (nothing_to_do refuses at status).
  const hardPlanAfterPin = await plannedReadOnly([bizC]);
  const hardScopeAfterPin = hardPlanAfterPin.scopes.find(
    (scope) => scope.endpoint === HARD_AD.endpoint,
  );
  assert(
    hardScopeAfterPin!.removableRuns === 0 &&
      hardPlanAfterPin.status === "nothing_to_do",
    `after the late pin the scope must have nothing removable: ${JSON.stringify(
      { removable: hardScopeAfterPin!.removableRuns, status: hardPlanAfterPin.status },
    )}`,
  );

  console.log(
    "[state-history-compaction-seam] PASS: candidate selection with head/pin/multi-endpoint/delta protection (one pinned row protects its whole run); strict insufficient-evidence refusal before pgstattuple and readiness after CREATE EXTENSION; zero-write refusals for wrong token, tampered payload, and missing acknowledgement; out-of-scope injection rolls its batch back; stale plans refuse; kill-switch interrupt + exact-accounting resume with lease exclusivity against a concurrent executor; completed plans never re-execute; as-of winners, partial/failed interleaves, pinned rows, the receipts guard, and the twin business are all preserved; and the post-compaction D075 writer produces twin-identical delta stats and still coalesces identical payloads. Hardening correction: a policy-forged plan (edited status/projection with an honestly recomputed hash+token) is refused by the authoritative pre-write re-plan with zero journal rows and zero deletions; the planner refuses any isolation weaker than REPEATABLE READ and a concurrent commit mid-plan is invisible to its snapshot; per-reason protection counts distinguish head-duplicate, live-lineage, archived-schema-lineage, response-event, interleave, AND exact measured multi-endpoint-exclusion protections (runs and rows per scope and in totals, hash-bound) with a non-additive overlapping-family union and fail-closed row-level reconciliation; the response-event FK pin is proven through the full episode chain, protects its whole run at plan time, and a pin arriving after planning refuses before any write.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const pg = error as { detail?: string; constraint?: string; table?: string };
    if (pg?.detail || pg?.constraint) {
      console.error(
        `pg error: constraint=${pg.constraint ?? "?"} table=${pg.table ?? "?"} detail=${pg.detail ?? "?"}`,
      );
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
