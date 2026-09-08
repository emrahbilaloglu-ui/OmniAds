/**
 * THE RECEIPT / SYNC-RUN / MANIFEST CONTRACTS, AGAINST A REAL POSTGRESQL.
 *
 * ── ROUND 14 ────────────────────────────────────────────────────────────────
 * Three of this round's facts are decided by SQL and by what a writer actually
 * committed, so a template mock can only restate what the test author typed:
 *
 *   1. `readMetaLatestObservationReceiptAsOf` must rank the NEWEST receipt
 *      first WITHOUT filtering on status or on a successful run, and must join
 *      the attempt LEFT — otherwise a newer failure is stepped over to reach an
 *      older success. Whether that is true depends on the plan the database
 *      runs, not on the string.
 *   2. `readMetaCompleteManifestMembershipForReceipt` reconstructs membership
 *      from rows the shipped writer committed: full manifests from the exact
 *      run, delta manifests from the deterministic latest row per entity in the
 *      complete lane, `absent_unconfirmed` removing membership, partial and
 *      point_lookup never entering, tombstones after the re-observation
 *      removing membership.
 *   3. `appendObservationCaptureReceipt` must persist `sync_run_id` at all —
 *      the column is new, and a mock cannot prove a real INSERT names it.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  readMetaCompleteManifestMembershipForReceipt,
  readMetaLatestObservationReceiptAsOf,
} from "@/lib/meta/entity-state-history";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/*
  Unique per run. The seam database is ephemeral and thrown away, but this file
  is re-run repeatedly while iterating (and during the reversion proofs), and a
  fixed owner email collides with the previous run's row — which cannot be
  deleted because the observation runs it owns hold a foreign key to it.
*/
// Unique per INVOCATION, so a pinned suffix cannot make a rerun collide.
const RUN_SUFFIX = process.env.ADSECUTE_SEAM_RUN_SUFFIX ?? String(process.pid);
const RUN_NONCE = `${RUN_SUFFIX}${process.pid}${Date.now().toString(36)}`;
const OWNER_EMAIL = `recent-edit-authority-receipt-${RUN_NONCE}@example.invalid`;
const ACCOUNT_ID = `act_recent_edit_${RUN_NONCE}`.slice(0, 60);
const ENDPOINT = "adset_configs_recent_edit";
const OTHER_ENDPOINT = "adset_configs_recent_edit_other";
const KNOWLEDGE = "2026-09-06T00:00:00.000Z";
/** Default receipt occurrence clock for helper-only cases. */
const RECEIPT_OCCURRENCE = "2026-09-05T08:00:00.000Z";

let businessId = "";
let accountRefId = "";
let partitionId = "";

async function seed() {
  const sql = getDb();
  const [owner] = await sql<{ id: string }>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Recent edit receipt seam', ${OWNER_EMAIL}, 'unused') RETURNING id
  `;
  const [business] = await sql<{ id: string }>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Recent edit receipt seam', ${owner!.id}) RETURNING id
  `;
  businessId = business!.id;
  const [account] = await sql<{ id: string }>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT_ID}, 'Recent edit receipt seam') RETURNING id
  `;
  accountRefId = account!.id;
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (${businessId}, 'meta', ${accountRefId}, ${ACCOUNT_ID})
  `;
  const [partition] = await sql<{ id: string }>`
    INSERT INTO meta_sync_partitions (
      business_id, provider_account_id, lane, scope, partition_date, status
    ) VALUES (
      ${businessId}, ${ACCOUNT_ID}, 'core', 'core_warehouse',
      '2026-09-05'::date, 'succeeded'
    ) RETURNING id
  `;
  partitionId = partition!.id;
}

/** One sync attempt on the shared partition. */
async function syncRun(input: {
  status: string;
  finishedAt: string | null;
}): Promise<string> {
  const sql = getDb();
  const [row] = await sql<{ id: string }>`
    INSERT INTO meta_sync_runs (
      partition_id, business_id, business_ref_id, provider_account_id,
      provider_account_ref_id, lane, scope, partition_date, status,
      attempt_count, started_at, finished_at
    ) VALUES (
      ${partitionId}::uuid, ${businessId}, ${businessId}::uuid, ${ACCOUNT_ID},
      ${accountRefId}::uuid, 'core', 'core_warehouse', '2026-09-05'::date,
      ${input.status}, 1, '2026-09-05T10:00:00Z'::timestamptz,
      ${input.finishedAt}::timestamptz
    ) RETURNING id
  `;
  return row!.id;
}

async function observationRun(input: {
  endpoint?: string;
  completeness: string;
  manifestKind?: string | null;
  rowCount: number;
  capturedAt: string;
  hash: string;
}): Promise<string> {
  const sql = getDb();
  const [row] = await sql<{ id: string }>`
    INSERT INTO meta_entity_observation_runs (
      business_ref_id, business_id, provider_account_ref_id, provider_account_id,
      entity_type, endpoint, observed_at, captured_at, completeness,
      page_count, row_count, run_hash, manifest_kind, error_json
    ) VALUES (
      ${businessId}::uuid, ${businessId}, ${accountRefId}::uuid, ${ACCOUNT_ID},
      'adset', ${input.endpoint ?? ENDPOINT},
      ${input.capturedAt}::timestamptz, ${input.capturedAt}::timestamptz,
      ${input.completeness}, 1, ${input.rowCount}, ${input.hash},
      ${input.manifestKind ?? null},
      ${input.completeness === "failed" ? JSON.stringify({ reason: "seam" }) : null}::jsonb
    ) RETURNING id
  `;
  return row!.id;
}

async function stateRow(input: {
  runId: string;
  entityId: string;
  presence: string;
  completeness: string;
  capturedAt: string;
  hash: string;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_entity_state_history (
      run_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, entity_id, campaign_id, adset_id,
      observed_at, captured_at, run_completeness, presence, state_hash
    ) VALUES (
      ${input.runId}::uuid, ${businessId}::uuid, ${businessId},
      ${accountRefId}::uuid, ${ACCOUNT_ID}, 'adset', ${input.entityId},
      ${"cmp_" + input.entityId}, ${input.entityId},
      ${input.capturedAt}::timestamptz, ${input.capturedAt}::timestamptz,
      ${input.completeness}, ${input.presence}, ${input.hash}
    )
  `;
}

async function receipt(input: {
  runId: string;
  syncRunId: string | null;
  captureStatus: string;
  capturedAt: string;
  providerRowCount: number;
  endpoint?: string;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_entity_observation_receipts (
      run_id, business_id, provider_account_id, entity_type, endpoint,
      partition_id, sync_run_id, capture_status, provider_row_count,
      page_count, run_reused, observed_at, captured_at
    ) VALUES (
      ${input.runId}::uuid, ${businessId}, ${ACCOUNT_ID}, 'adset',
      ${input.endpoint ?? ENDPOINT}, ${partitionId}::uuid,
      ${input.syncRunId}::uuid, ${input.captureStatus},
      ${input.providerRowCount}, 1, false,
      ${input.capturedAt}::timestamptz, ${input.capturedAt}::timestamptz
    )
  `;
}

/*
  Distinct 64-char hex per call. `meta_entity_observation_runs` and the state
  table both carry unique hash constraints, so a helper that collapsed two
  seeds onto one value failed the INSERT rather than the assertion.
*/
let hashCounter = 0;
// Unique per INVOCATION: a counter that restarts at 1 collides on the unique
// `run_hash` whenever the suffix is pinned across reruns.
const RUN_HASH_PREFIX = `${RUN_NONCE}`
  .split("")
  .map((char) => char.charCodeAt(0).toString(16))
  .join("")
  .slice(0, 40);
const hash = (_seed: string) =>
  (RUN_HASH_PREFIX + (hashCounter += 1).toString(16)).padStart(64, "0").slice(-64);

describe.skipIf(!SEAM)("the receipt / sync-run / manifest contracts", () => {
  beforeAll(async () => {
    await seed();
  });
  /*
    No teardown. Observation runs hold a foreign key to the business, so a
    DELETE cascade is refused by design — the append-only evidence tables are
    meant to outlive a cleanup. The seam database is ephemeral; rows are
    namespaced per run instead.
  */
  afterAll(async () => {});

  it("persists sync_run_id and returns the attempt beside the receipt", async () => {
    const run = await syncRun({ status: "succeeded", finishedAt: "2026-09-05T11:00:00Z" });
    const obs = await observationRun({
      completeness: "complete",
      rowCount: 1,
      capturedAt: "2026-09-05T10:30:00Z",
      hash: hash("a1"),
    });
    await receipt({
      runId: obs,
      syncRunId: run,
      captureStatus: "complete",
      capturedAt: "2026-09-05T10:30:00Z",
      providerRowCount: 1,
    });

    const pointer = await readMetaLatestObservationReceiptAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: ENDPOINT,
      cutoff: KNOWLEDGE,
    });
    expect(pointer?.syncRunId).toBe(run);
    expect(pointer?.syncRun?.status).toBe("succeeded");
    expect(pointer?.syncRun?.partitionId).toBe(partitionId);
    expect(pointer?.partitionStatus).toBe("succeeded");
  });

  it("a NEWER failed attempt is selected over an older complete success", async () => {
    /*
      THE FALLBACK THIS CONTRACT FORBIDS. A complete receipt commits before
      `append_current_config_history`, so this is exactly the shape of "the
      apply failed after the receipt was written". The reader must surface the
      newest attempt; if it filtered on status or inner-joined a succeeded run
      it would return the 10:30 success instead and authorise on a config
      history that was never written.
    */
    const failed = await syncRun({ status: "failed", finishedAt: "2026-09-05T12:10:00Z" });
    const obs = await observationRun({
      completeness: "complete",
      rowCount: 1,
      capturedAt: "2026-09-05T12:00:00Z",
      hash: hash("b2"),
    });
    await receipt({
      runId: obs,
      syncRunId: failed,
      captureStatus: "complete",
      capturedAt: "2026-09-05T12:00:00Z",
      providerRowCount: 1,
    });

    const pointer = await readMetaLatestObservationReceiptAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: ENDPOINT,
      cutoff: KNOWLEDGE,
    });
    // Compared as an INSTANT: `::text` on a timestamptz renders in the session
    // timezone, so a string prefix would assert the session rather than the row.
    expect(new Date(pointer!.capturedAt).toISOString()).toBe(
      "2026-09-05T12:00:00.000Z",
    );
    expect(pointer?.syncRun?.status).toBe("failed");
  });

  it("two attempts on ONE partition cannot cross-bind", async () => {
    // Both attempts share `partitionId`; each receipt names its own. The reader
    // must return the attempt the RECEIPT points at, not the partition's latest.
    const first = await syncRun({ status: "succeeded", finishedAt: "2026-09-05T13:00:00Z" });
    const second = await syncRun({ status: "failed", finishedAt: "2026-09-05T14:00:00Z" });
    const obs = await observationRun({
      completeness: "complete",
      rowCount: 1,
      capturedAt: "2026-09-05T13:30:00Z",
      hash: hash("c3"),
    });
    await receipt({
      runId: obs,
      syncRunId: first,
      captureStatus: "complete",
      capturedAt: "2026-09-05T13:30:00Z",
      providerRowCount: 1,
      endpoint: OTHER_ENDPOINT,
    });
    const pointer = await readMetaLatestObservationReceiptAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: OTHER_ENDPOINT,
      cutoff: KNOWLEDGE,
    });
    expect(pointer?.syncRunId).toBe(first);
    expect(pointer?.syncRunId).not.toBe(second);
    expect(pointer?.syncRun?.status).toBe("succeeded");
  });

  it("a legacy receipt with a NULL sync_run_id returns no attempt", async () => {
    const obs = await observationRun({
      endpoint: "adset_configs_legacy",
      completeness: "complete",
      rowCount: 1,
      capturedAt: "2026-09-05T09:00:00Z",
      hash: hash("d4"),
    });
    await receipt({
      runId: obs,
      syncRunId: null,
      captureStatus: "complete",
      capturedAt: "2026-09-05T09:00:00Z",
      providerRowCount: 1,
      endpoint: "adset_configs_legacy",
    });
    const pointer = await readMetaLatestObservationReceiptAsOf({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: "adset_configs_legacy",
      cutoff: KNOWLEDGE,
    });
    expect(pointer?.syncRunId).toBeNull();
    expect(pointer?.syncRun).toBeNull();
  });

  it("a FULL manifest names exactly the run's own present members", async () => {
    const ep = "adset_configs_full";
    const obs = await observationRun({
      endpoint: ep,
      completeness: "complete",
      manifestKind: null,
      rowCount: 2,
      capturedAt: "2026-09-05T08:00:00Z",
      hash: hash("e5"),
    });
    await stateRow({ runId: obs, entityId: "as_full_1", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("e51") });
    await stateRow({ runId: obs, entityId: "as_full_2", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("e52") });
    // absent_unconfirmed REMOVES membership rather than granting it.
    await stateRow({ runId: obs, entityId: "as_full_3", presence: "absent_unconfirmed", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("e53") });

    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: ep,
      observationRunId: obs,
      expectedProviderRowCount: 2,
      receiptCapturedAt: RECEIPT_OCCURRENCE,
      knowledgeEndExclusive: KNOWLEDGE,
      entityIds: ["as_full_1", "as_full_3", "as_full_missing"],
    });
    expect(membership.ok).toBe(true);
    expect(membership.manifestCount).toBe(2);
    expect([...membership.presentEntityIds]).toEqual(["as_full_1"]);
  });

  it("a DELTA run inherits an unchanged base member and drops an exited one", async () => {
    const ep = "adset_configs_delta";
    const base = await observationRun({
      endpoint: ep,
      completeness: "complete",
      manifestKind: null,
      rowCount: 2,
      capturedAt: "2026-09-04T08:00:00Z",
      hash: hash("f6"),
    });
    await stateRow({ runId: base, entityId: "as_d_keep", presence: "present", completeness: "complete", capturedAt: "2026-09-04T08:00:00Z", hash: hash("f61") });
    await stateRow({ runId: base, entityId: "as_d_gone", presence: "present", completeness: "complete", capturedAt: "2026-09-04T08:00:00Z", hash: hash("f62") });

    const delta = await observationRun({
      endpoint: ep,
      completeness: "complete",
      manifestKind: "delta",
      rowCount: 1,
      capturedAt: "2026-09-05T08:00:00Z",
      hash: hash("f7"),
    });
    // The delta records only the exit; `as_d_keep` is inherited unchanged.
    await stateRow({ runId: delta, entityId: "as_d_gone", presence: "absent_unconfirmed", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("f71") });
    // A PARTIAL row must never enter the reconstruction.
    const partialRun = await observationRun({
      endpoint: ep,
      completeness: "partial",
      manifestKind: null,
      rowCount: 1,
      capturedAt: "2026-09-05T09:00:00Z",
      hash: hash("f8"),
    });
    await stateRow({ runId: partialRun, entityId: "as_d_partial_only", presence: "present", completeness: "partial", capturedAt: "2026-09-05T09:00:00Z", hash: hash("f81") });

    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: ep,
      observationRunId: delta,
      expectedProviderRowCount: 1,
      receiptCapturedAt: RECEIPT_OCCURRENCE,
      knowledgeEndExclusive: KNOWLEDGE,
      entityIds: ["as_d_keep", "as_d_gone", "as_d_partial_only"],
    });
    expect(membership.ok).toBe(true);
    expect([...membership.presentEntityIds]).toEqual(["as_d_keep"]);
  });

  it("refuses a run that is partial, point_lookup, or out of scope", async () => {
    for (const completeness of ["partial", "point_lookup", "failed"]) {
      const ep = `adset_configs_bad_${completeness}`;
      const obs = await observationRun({
        endpoint: ep,
        completeness,
        rowCount: 1,
        capturedAt: "2026-09-05T08:00:00Z",
        hash: hash(`g${completeness}`),
      });
      const membership = await readMetaCompleteManifestMembershipForReceipt({
        businessId,
        providerAccountId: ACCOUNT_ID,
        entityType: "adset",
        endpoint: ep,
        observationRunId: obs,
        expectedProviderRowCount: 1,
        receiptCapturedAt: RECEIPT_OCCURRENCE,
        knowledgeEndExclusive: KNOWLEDGE,
        entityIds: ["anything"],
      });
      expect(membership.ok, completeness).toBe(false);
      expect(membership.refusal, completeness).toBe("observation_run_not_complete");
    }
  });

  it("refuses when the manifest size disagrees with the receipt's provider count", async () => {
    const ep = "adset_configs_count_mismatch";
    const obs = await observationRun({
      endpoint: ep,
      completeness: "complete",
      rowCount: 9,
      capturedAt: "2026-09-05T08:00:00Z",
      hash: hash("h9"),
    });
    await stateRow({ runId: obs, entityId: "as_h_1", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("h91") });
    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId,
      providerAccountId: ACCOUNT_ID,
      entityType: "adset",
      endpoint: ep,
      observationRunId: obs,
      expectedProviderRowCount: 9,
      receiptCapturedAt: RECEIPT_OCCURRENCE,
      knowledgeEndExclusive: KNOWLEDGE,
      entityIds: ["as_h_1"],
    });
    expect(membership.ok).toBe(false);
    expect(membership.refusal).toBe("observation_manifest_count_mismatch");
  });

  it("excludes evidence at or after the knowledge bound, and admits 1 ms before", async () => {
    const ep = "adset_configs_bound";
    const obs = await observationRun({
      endpoint: ep,
      completeness: "complete",
      rowCount: 1,
      capturedAt: "2026-09-05T23:59:59.999Z",
      hash: hash("i1"),
    });
    await stateRow({ runId: obs, entityId: "as_i_1", presence: "present", completeness: "complete", capturedAt: "2026-09-05T23:59:59.999Z", hash: hash("i11") });

    // Exactly at the bound: the next day's evidence, excluded.
    const atBound = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: obs, expectedProviderRowCount: 1, receiptCapturedAt: RECEIPT_OCCURRENCE,
      knowledgeEndExclusive: "2026-09-05T23:59:59.999Z",
      entityIds: ["as_i_1"],
    });
    expect(atBound.ok).toBe(false);
    expect(atBound.refusal).toBe("observation_run_clock_after_knowledge");

    // One millisecond later the same evidence is inside the day.
    const inside = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: obs, expectedProviderRowCount: 1, receiptCapturedAt: RECEIPT_OCCURRENCE,
      knowledgeEndExclusive: "2026-09-06T00:00:00.000Z",
      entityIds: ["as_i_1"],
    });
    expect(inside.ok).toBe(true);
    expect([...inside.presentEntityIds]).toEqual(["as_i_1"]);
  });
});

/* ══ ROUND 15 ════════════════════════════════════════════════════════════ */

/** A minimal ad-set observation state the shipped writer accepts. */
function adsetState(input: {
  entityId: string;
  status: string;
  observedAt: string;
}) {
  return {
    businessId,
    providerAccountId: ACCOUNT_ID,
    entityType: "adset" as const,
    entityId: input.entityId,
    campaignId: `cmp_${input.entityId}`,
    adsetId: input.entityId,
    adId: null,
    creativeId: null,
    entityName: input.entityId,
    configuredStatus: input.status,
    effectiveStatus: input.status,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { configuredStatus: true },
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
    observedAt: input.observedAt,
  };
}

async function tombstone(input: {
  runId: string;
  entityId: string;
  capturedAt: string;
  reason?: string;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_entity_tombstones (
      run_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, entity_id, reason,
      provider_evidence_json, observed_at, captured_at, run_completeness,
      tombstone_hash
    ) VALUES (
      ${input.runId}::uuid, ${businessId}::uuid, ${businessId},
      ${accountRefId}::uuid, ${ACCOUNT_ID}, 'adset', ${input.entityId},
      ${input.reason ?? "explicit_deleted"}, '{"seam":true}'::jsonb,
      ${input.capturedAt}::timestamptz, ${input.capturedAt}::timestamptz,
      -- An explicit scope exit is recorded from a POINT LOOKUP, never from a
      -- complete enumeration (meta_entity_tombstones_point_evidence_check).
      'point_lookup', ${hash("t")}
    )
  `;
}

describe.skipIf(!SEAM)("ROUND 15 — manifest integrity and attempt identity", () => {
  beforeAll(async () => {
    if (!businessId) await seed();
  });

  it("refuses a TRUNCATED delta: both counts say 2, the reconstruction yields 1", async () => {
    /*
      ── DEFECT 2 ────────────────────────────────────────────────────────────
      Round 14 exempted delta runs from the integrity check, believing
      `row_count` was the size of the change. `META_PARTIAL_MANIFEST_CONTRACT`
      says otherwise: `logicalEntityCount` — and `row_count` with it — is "the
      whole observed payload", the full logical provider scope, on the complete
      lane too. The exemption was exactly the hole a truncated delta needed:
      the account really has two ad sets, only one survives reconstruction, and
      the missing one would have been reported as absent rather than as a
      broken capture.
    */
    const ep = `adset_configs_trunc_${RUN_SUFFIX}`;
    const delta = await observationRun({
      endpoint: ep,
      completeness: "complete",
      manifestKind: "delta",
      rowCount: 2,
      capturedAt: "2026-09-05T08:00:00Z",
      hash: hash("r15a"),
    });
    await stateRow({ runId: delta, entityId: "as_t_1", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("r15a1") });

    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: delta, expectedProviderRowCount: 2,
      receiptCapturedAt: "2026-09-05T08:00:00Z",
      knowledgeEndExclusive: KNOWLEDGE, entityIds: ["as_t_1", "as_t_2"],
    });
    expect(membership.ok).toBe(false);
    expect(membership.refusal).toBe("observation_manifest_count_mismatch");
  });

  it("accepts a delta whose reconstructed base MATCHES both recorded counts", async () => {
    // The control. Same lane, same shape, honest counts.
    const ep = `adset_configs_delta_ok_${RUN_SUFFIX}`;
    const base = await observationRun({
      endpoint: ep, completeness: "complete", manifestKind: null, rowCount: 2,
      capturedAt: "2026-09-04T08:00:00Z", hash: hash("r15b"),
    });
    await stateRow({ runId: base, entityId: "as_o_1", presence: "present", completeness: "complete", capturedAt: "2026-09-04T08:00:00Z", hash: hash("r15b1") });
    await stateRow({ runId: base, entityId: "as_o_2", presence: "present", completeness: "complete", capturedAt: "2026-09-04T08:00:00Z", hash: hash("r15b2") });
    const delta = await observationRun({
      endpoint: ep, completeness: "complete", manifestKind: "delta", rowCount: 2,
      capturedAt: "2026-09-05T08:00:00Z", hash: hash("r15c"),
    });
    await stateRow({ runId: delta, entityId: "as_o_2", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("r15c1") });

    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: delta, expectedProviderRowCount: 2,
      receiptCapturedAt: "2026-09-05T08:00:00Z",
      knowledgeEndExclusive: KNOWLEDGE, entityIds: ["as_o_1", "as_o_2"],
    });
    expect(membership.ok).toBe(true);
    expect(membership.manifestCount).toBe(2);
    expect([...membership.presentEntityIds].sort()).toEqual(["as_o_1", "as_o_2"]);
  });

  it("refuses when the RECEIPT and the RUN disagree about the scope size", async () => {
    const ep = `adset_configs_pair_${RUN_SUFFIX}`;
    const obs = await observationRun({
      endpoint: ep, completeness: "complete", rowCount: 2,
      capturedAt: "2026-09-05T08:00:00Z", hash: hash("r15d"),
    });
    await stateRow({ runId: obs, entityId: "as_p_1", presence: "present", completeness: "complete", capturedAt: "2026-09-05T08:00:00Z", hash: hash("r15d1") });
    const membership = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: obs, expectedProviderRowCount: 3,
      receiptCapturedAt: "2026-09-05T08:00:00Z",
      knowledgeEndExclusive: KNOWLEDGE, entityIds: ["as_p_1"],
    });
    expect(membership.ok).toBe(false);
    expect(membership.refusal).toBe("observation_receipt_run_count_mismatch");
  });

  it("a coalesced t2 re-observation SUPERSEDES a t1.5 tombstone, and t2/t2.5 win", async () => {
    /*
      ── DEFECT 2, ORDERING ─────────────────────────────────────────────────
      The payload was captured at t1 and the receipt occurrence is t2: the
      account was demonstrably observed again at t2 and this entity was still in
      it, so an exit recorded at t1.5 is stale. An exit AT t2 wins on the
      canonical tie rule (a tombstone outranks a state at an identical clock),
      and one after t2 obviously wins.
    */
    const ep = `adset_configs_coalesce_${RUN_SUFFIX}`;
    const t1 = "2026-09-05T08:00:00Z";
    const obs = await observationRun({
      endpoint: ep, completeness: "complete", rowCount: 2, capturedAt: t1,
      hash: hash("r15e"),
    });
    await stateRow({ runId: obs, entityId: "as_c_keep", presence: "present", completeness: "complete", capturedAt: t1, hash: hash("r15e1") });
    await stateRow({ runId: obs, entityId: "as_c_exit", presence: "present", completeness: "complete", capturedAt: t1, hash: hash("r15e2") });

    const t2 = "2026-09-05T10:00:00Z";
    /*
      A scope exit is written by a POINT LOOKUP run, and the tombstone's
      composite FK binds it to a run of that completeness — so it cannot hang
      off the complete enumeration above.
    */
    const exitRun = await observationRun({
      endpoint: ep, completeness: "point_lookup", rowCount: 0,
      capturedAt: "2026-09-05T09:00:00Z", hash: hash("r15e-exit"),
    });
    // t1.5 — superseded by the t2 re-observation.
    await tombstone({ runId: exitRun, entityId: "as_c_exit", capturedAt: "2026-09-05T09:00:00Z" });
    const superseded = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: obs, expectedProviderRowCount: 2, receiptCapturedAt: t2,
      knowledgeEndExclusive: KNOWLEDGE, entityIds: ["as_c_keep", "as_c_exit"],
    });
    expect(superseded.ok).toBe(true);
    expect(superseded.removedByTombstone).toBe(0);
    expect([...superseded.presentEntityIds].sort()).toEqual(["as_c_exit", "as_c_keep"]);

    // t2.5 — after the re-observation, so it wins.
    const laterExitRun = await observationRun({
      endpoint: ep, completeness: "point_lookup", rowCount: 0,
      capturedAt: "2026-09-05T10:30:00Z", hash: hash("r15e-exit2"),
    });
    await tombstone({ runId: laterExitRun, entityId: "as_c_exit", capturedAt: "2026-09-05T10:30:00Z" });
    const removed = await readMetaCompleteManifestMembershipForReceipt({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset", endpoint: ep,
      observationRunId: obs, expectedProviderRowCount: 2, receiptCapturedAt: t2,
      knowledgeEndExclusive: KNOWLEDGE, entityIds: ["as_c_keep", "as_c_exit"],
    });
    /*
      THE SURVIVOR IS NOT COLLATERAL DAMAGE. Applying the exit before counting
      would leave a base of 1 against a recorded 2 and refuse the WHOLE
      manifest — one legitimate deletion invalidating every remaining entity.
      The integrity check runs on the base; exits are applied after it.
    */
    expect(removed.ok).toBe(true);
    expect(removed.manifestCount).toBe(2);
    expect(removed.removedByTombstone).toBe(1);
    expect([...removed.presentEntityIds]).toEqual(["as_c_keep"]);
  });

  it("writes DISTINCT receipts for two attempts at the same occurrence key", async () => {
    /*
      ── DEFECT 4, THROUGH THE SHIPPED WRITER ───────────────────────────────
      The occurrence key was (partition, type, endpoint, captured_at). The
      partition is reused across retries, so two distinct attempts capturing at
      the same millisecond collided and `DO NOTHING` silently kept whichever
      committed first — possibly the one whose apply then failed.
    */
    const { persistMetaEntityObservation } = await import(
      "@/lib/meta/entity-state-history"
    );
    const ep = `adset_configs_attempts_${RUN_SUFFIX}`;
    const capturedAt = "2026-09-05T14:00:00.000Z";
    const first = await syncRun({ status: "failed", finishedAt: "2026-09-05T14:05:00Z" });
    const second = await syncRun({ status: "succeeded", finishedAt: "2026-09-05T14:06:00Z" });

    for (const [attempt, entityId] of [[first, "as_a_1"], [second, "as_a_1"]] as const) {
      await persistMetaEntityObservation({
        businessId,
        providerAccountId: ACCOUNT_ID,
        entityType: "adset",
        endpoint: ep,
        observedAt: capturedAt,
        capturedAt,
        completeness: "complete",
        pageCount: 1,
        providerRowCount: 1,
        states: [adsetState({ entityId, status: "ACTIVE", observedAt: capturedAt })],
        captureReceipt: { partitionId, syncRunId: attempt },
      });
    }

    const sql = getDb();
    const rows = await sql<{ sync_run_id: string }>`
      SELECT sync_run_id::text AS sync_run_id
      FROM meta_entity_observation_receipts
      WHERE partition_id = ${partitionId}::uuid AND endpoint = ${ep}
      ORDER BY created_at ASC
    `;
    // BOTH survive: two attempts, two receipts.
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.sync_run_id).sort()).toEqual([first, second].sort());

    // And the newest EXACT attempt governs the reader.
    const pointer = await readMetaLatestObservationReceiptAsOf({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset",
      endpoint: ep, cutoff: KNOWLEDGE,
    });
    expect(pointer?.syncRunId).toBe(second);
    expect(pointer?.syncRun?.status).toBe("succeeded");
  });

  it("an exact retry of the SAME attempt stays a no-op", async () => {
    const { persistMetaEntityObservation } = await import(
      "@/lib/meta/entity-state-history"
    );
    const ep = `adset_configs_retry_${RUN_SUFFIX}`;
    const capturedAt = "2026-09-05T15:00:00.000Z";
    const attempt = await syncRun({ status: "succeeded", finishedAt: "2026-09-05T15:05:00Z" });
    const write = () =>
      persistMetaEntityObservation({
        businessId, providerAccountId: ACCOUNT_ID, entityType: "adset",
        endpoint: ep, observedAt: capturedAt, capturedAt, completeness: "complete",
        pageCount: 1, providerRowCount: 1,
        states: [adsetState({ entityId: "as_r_1", status: "ACTIVE", observedAt: capturedAt })],
        captureReceipt: { partitionId, syncRunId: attempt },
      });
    await write();
    await write();
    const sql = getDb();
    const [row] = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM meta_entity_observation_receipts
      WHERE partition_id = ${partitionId}::uuid AND endpoint = ${ep}
    `;
    expect(Number(row!.count)).toBe(1);
  });

  it("refuses CONTRADICTORY truth written under the same attempt and occurrence", async () => {
    const { persistMetaEntityObservation } = await import(
      "@/lib/meta/entity-state-history"
    );
    const ep = `adset_configs_contradiction_${RUN_SUFFIX}`;
    const capturedAt = "2026-09-05T16:00:00.000Z";
    const attempt = await syncRun({ status: "succeeded", finishedAt: "2026-09-05T16:05:00Z" });
    await persistMetaEntityObservation({
      businessId, providerAccountId: ACCOUNT_ID, entityType: "adset",
      endpoint: ep, observedAt: capturedAt, capturedAt, completeness: "complete",
      pageCount: 1, providerRowCount: 1,
      states: [adsetState({ entityId: "as_x_1", status: "ACTIVE", observedAt: capturedAt })],
      captureReceipt: { partitionId, syncRunId: attempt },
    });
    await expect(
      persistMetaEntityObservation({
        businessId, providerAccountId: ACCOUNT_ID, entityType: "adset",
        endpoint: ep, observedAt: capturedAt, capturedAt, completeness: "complete",
        // A DIFFERENT provider row count for the same attempt and occurrence.
        pageCount: 1, providerRowCount: 7,
        states: [adsetState({ entityId: "as_x_1", status: "ACTIVE", observedAt: capturedAt })],
        captureReceipt: { partitionId, syncRunId: attempt },
      }),
    ).rejects.toThrow();
  });
});
