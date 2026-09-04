import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { readMetaCampaignLabelsAsOf } from "@/lib/meta/campaign-labels";
import {
  buildMetaEntityStateHash,
  buildMetaObservationRunHash,
  persistMetaEntityObservation,
  readMetaCreativeLineageAsOf,
  readMetaEntityStatesAsOf,
  readMetaEntityTruthAsOf,
  type MetaObservationCompleteness,
} from "@/lib/meta/entity-state-history";
import {
  AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL,
  FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY,
} from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { SOURCE_RUNS_SQL } from "@/scripts/creative-decision-center/native-ad-natural-wave-operational-verifier";

interface IdRow {
  id: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectPostgresError(
  operation: () => Promise<unknown>,
  expectedCode: string,
  label: string,
) {
  try {
    await operation();
  } catch (error) {
    const code =
      typeof error === "object" && error != null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === expectedCode) return;
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function main() {
  const sql = getDb();
  const [owner] = await sql<IdRow>`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Entity state seam', 'entity-state-seam@example.invalid', 'unused')
    RETURNING id
  `;
  assert(owner?.id, "Could not create seam owner.");

  const [business] = await sql<IdRow>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Entity state seam', ${owner.id})
    RETURNING id
  `;
  assert(business?.id, "Could not create seam business.");
  const businessId = business.id;

  const [account] = await sql<IdRow>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', 'act_entity_state_seam', 'Entity state seam')
    RETURNING id
  `;
  assert(account?.id, "Could not create seam provider account.");
  const providerAccountId = "act_entity_state_seam";
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (
      ${businessId}, 'meta', ${account.id}, ${providerAccountId}
    )
  `;
  const [secondAccount] = await sql<IdRow>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', 'act_entity_state_seam_2', 'Entity state seam second')
    RETURNING id
  `;
  assert(secondAccount?.id, "Could not create second seam provider account.");
  const secondProviderAccountId = "act_entity_state_seam_2";
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (
      ${businessId}, 'meta', ${secondAccount.id}, ${secondProviderAccountId}
    )
  `;
  const [otherBusiness] = await sql<IdRow>`
    INSERT INTO businesses (name, owner_id)
    VALUES ('Entity state seam other tenant', ${owner.id})
    RETURNING id
  `;
  assert(otherBusiness?.id, "Could not create second seam business.");
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (
      ${otherBusiness.id}, 'meta', ${account.id}, ${providerAccountId}
    )
  `;

  // D074: the production write implementation for manual labels is removed.
  // The frozen history table is seeded here with seam-local fixture SQL only,
  // purely so the retained READ-ONLY historical comparator
  // (readMetaCampaignLabelsAsOf) and the cross-tenant constraint below can be
  // exercised against real Postgres. This is fixture setup for an ephemeral
  // database, not a manual-label capability.
  await sql`
    INSERT INTO meta_campaign_labels (
      business_id, campaign_id, provider_account_id, campaign_name,
      campaign_kind, test_dimension, source, labeled_by, labeled_at, updated_at
    ) VALUES (
      ${businessId}, 'campaign_label_seam', ${providerAccountId},
      'Creative test', 'test', 'creative', 'bulk_apply_confirmed',
      ${owner.id}, '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z'
    )
  `;
  await sql`
    INSERT INTO meta_campaign_label_history (
      business_ref_id, business_id, campaign_id, provider_account_ref_id,
      provider_account_id, campaign_name, campaign_kind, test_dimension,
      source, labeled_by, change_kind, observed_at, state_hash
    ) VALUES (
      ${businessId}, ${businessId}, 'campaign_label_seam', ${account.id},
      ${providerAccountId}, 'Main campaign', 'main', NULL,
      'user', ${owner.id}, 'created', '2026-08-01T10:00:00Z', ${"a".repeat(64)}
    )
  `;
  await sql`
    INSERT INTO meta_campaign_label_history (
      business_ref_id, business_id, campaign_id, provider_account_ref_id,
      provider_account_id, campaign_name, campaign_kind, test_dimension,
      source, labeled_by, previous_provider_account_id, previous_campaign_name,
      previous_campaign_kind, previous_source, change_kind, observed_at,
      state_hash
    ) VALUES (
      ${businessId}, ${businessId}, 'campaign_label_seam', ${account.id},
      ${providerAccountId}, 'Creative test', 'test', 'creative',
      'bulk_apply_confirmed', ${owner.id}, ${providerAccountId},
      'Main campaign', 'main', 'user', 'updated',
      '2026-08-01T11:00:00Z', ${"b".repeat(64)}
    )
  `;
  const labelAsOf = await readMetaCampaignLabelsAsOf({
    businessId,
    providerAccountId,
    cutoff: new Date(Date.now() + 60_000),
  });
  assert(
    labelAsOf.length === 1 && labelAsOf[0]?.kind === "test",
    "Account-scoped campaign label as-of read did not return the latest state.",
  );
  const wrongAccountLabels = await readMetaCampaignLabelsAsOf({
    businessId,
    providerAccountId: "act_other",
    cutoff: new Date(Date.now() + 60_000),
  });
  assert(
    wrongAccountLabels.length === 0,
    "Campaign label as-of read crossed accounts.",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_campaign_label_history (
        business_ref_id, business_id, campaign_id, provider_account_ref_id,
        provider_account_id, campaign_kind, source, change_kind, observed_at,
        state_hash
      ) VALUES (
        ${otherBusiness.id}, ${otherBusiness.id}, 'cross_tenant_label',
        ${secondAccount.id}, ${secondProviderAccountId}, 'main', 'user',
        'created', now(), ${"8".repeat(64)}
      )
    `,
    "23503",
    "campaign label history tenant binding",
  );

  async function insertRun(input: {
    entityType: "campaign" | "adset" | "ad" | "creative";
    observedAt: string;
    capturedAt: string;
    completeness: MetaObservationCompleteness;
    endpoint: string;
  }) {
    const runHash = buildMetaObservationRunHash({
      businessId,
      providerAccountId,
      entityType: input.entityType,
      endpoint: input.endpoint,
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      completeness: input.completeness,
      pageCount: input.completeness === "failed" ? 0 : 1,
      rowCount: input.completeness === "failed" ? 0 : 1,
      error:
        input.completeness === "failed" ? { code: "provider_failed" } : null,
    });
    const [run] = await sql<IdRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness, page_count,
        row_count, run_hash, error_json
      ) VALUES (
        ${businessId}, ${businessId}, ${account.id}, ${providerAccountId},
        ${input.entityType}, ${input.endpoint}, ${input.observedAt}::timestamptz,
        ${input.capturedAt}::timestamptz, ${input.completeness},
        ${input.completeness === "failed" ? 0 : 1},
        ${input.completeness === "failed" ? 0 : 1},
        ${runHash},
        ${input.completeness === "failed" ? { code: "provider_failed" } : null}::jsonb
      )
      RETURNING id
    `;
    assert(run?.id, `Could not create ${input.completeness} observation run.`);
    return run.id;
  }

  const idempotentObservationInput = {
    businessId,
    providerAccountId,
    entityType: "campaign" as const,
    endpoint: "campaign_configs_idempotency",
    observedAt: "2026-07-12T02:59:59Z",
    capturedAt: "2026-07-12T03:00:00Z",
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: 1,
    states: [
      {
        businessId,
        providerAccountId,
        entityType: "campaign" as const,
        entityId: "campaign_shared_across_accounts",
        campaignId: "campaign_shared_across_accounts",
        learningSource: "not_observed" as const,
        budgetOrigin: "not_applicable" as const,
        presence: "present" as const,
        fieldCoverage: { configuredStatus: true },
        configuredStatus: "ACTIVE",
        effectiveStatus: "ACTIVE",
        providerUpdatedAt: "2026-06-30T08:00:00Z",
        observedAt: "2026-06-30T08:00:00Z",
      },
    ],
  };
  const firstObservation = await persistMetaEntityObservation(
    idempotentObservationInput,
  );
  const retriedObservation = await persistMetaEntityObservation(
    idempotentObservationInput,
  );
  assert(
    firstObservation.runId === retriedObservation.runId,
    "Identical observation retry created a second run.",
  );
  const [idempotentCounts] = await sql<{
    run_count: string;
    state_count: string;
  }>`
    SELECT
      count(DISTINCT run.id)::text AS run_count,
      count(state.id)::text AS state_count
    FROM meta_entity_observation_runs run
    LEFT JOIN meta_entity_state_history state ON state.run_id = run.id
    WHERE run.business_id = ${businessId}
      AND run.provider_account_id = ${providerAccountId}
      AND run.endpoint = 'campaign_configs_idempotency'
  `;
  assert(
    idempotentCounts?.run_count === "1" &&
      idempotentCounts.state_count === "1",
    "Observation retry was not idempotent.",
  );
  await persistMetaEntityObservation({
    ...idempotentObservationInput,
    providerAccountId: secondProviderAccountId,
    endpoint: "campaign_configs_account_2",
    observedAt: "2026-07-12T03:00:09Z",
    capturedAt: "2026-07-12T03:00:10Z",
    states: [
      {
        ...idempotentObservationInput.states[0],
        providerAccountId: secondProviderAccountId,
        configuredStatus: "PAUSED",
        effectiveStatus: "PAUSED",
      },
    ],
  });
  const [firstAccountState] = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityIds: ["campaign_shared_across_accounts"],
    cutoff: "2026-07-12T03:00:20Z",
  });
  const [secondAccountState] = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId: secondProviderAccountId,
    entityType: "campaign",
    entityIds: ["campaign_shared_across_accounts"],
    cutoff: "2026-07-12T03:00:20Z",
  });
  assert(
    firstAccountState?.configuredStatus === "ACTIVE" &&
      secondAccountState?.configuredStatus === "PAUSED",
    "The same provider entity id crossed account boundaries.",
  );
  assert(
    new Date(firstAccountState.observedAt).toISOString() ===
      "2026-06-30T08:00:00.000Z",
    "Provider updated_time was not preserved as observation time.",
  );

  const completeRunId = await insertRun({
    entityType: "campaign",
    observedAt: "2026-07-12T03:00:00Z",
    capturedAt: "2026-07-12T03:00:01Z",
    completeness: "complete",
    endpoint: "/campaigns",
  });
  const stateHash = buildMetaEntityStateHash({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityId: "campaign_state_seam",
    campaignId: "campaign_state_seam",
    learningStatus: null,
    learningSource: "not_observed",
    campaignDailyBudgetRaw: "10000",
    budgetCurrency: "USD",
    budgetOrigin: "campaign",
    presence: "present",
    fieldCoverage: { status: true, budget: true },
  });
  await sql`
    INSERT INTO meta_entity_state_history (
      run_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, entity_id, campaign_id,
      configured_status, effective_status, learning_source,
      campaign_daily_budget_raw, budget_currency, budget_origin, presence,
      field_coverage_json, observed_at, captured_at, run_completeness, state_hash
    ) VALUES (
      ${completeRunId}, ${businessId}, ${businessId}, ${account.id},
      ${providerAccountId}, 'campaign', 'campaign_state_seam', 'campaign_state_seam',
      'ACTIVE', 'ACTIVE', 'not_observed', '10000', 'USD', 'campaign', 'present',
      ${{ status: true, budget: true }}::jsonb,
      '2026-07-12T03:00:00Z'::timestamptz,
      '2026-07-12T03:00:01Z'::timestamptz, 'complete', ${stateHash}
    )
  `;

  const beforeCapture = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityIds: ["campaign_state_seam"],
    cutoff: "2026-07-12T03:00:00.500Z",
  });
  assert(beforeCapture.length === 0, "State leaked before captured_at.");
  const afterCapture = await readMetaEntityStatesAsOf({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityIds: ["campaign_state_seam"],
    cutoff: "2026-07-12T03:00:02Z",
  });
  assert(afterCapture.length === 1, "State was not visible after captured_at.");

  const failedRunId = await insertRun({
    entityType: "campaign",
    observedAt: "2026-07-12T03:01:00Z",
    capturedAt: "2026-07-12T03:01:01Z",
    completeness: "failed",
    endpoint: "/campaigns",
  });
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_entity_state_history (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, campaign_id, learning_source,
        budget_origin, presence, observed_at, captured_at, run_completeness, state_hash
      ) VALUES (
        ${failedRunId}, ${businessId}, ${businessId}, ${account.id},
        ${providerAccountId}, 'campaign', 'failed_state', 'failed_state', 'not_observed',
        'not_observed', 'present', '2026-07-12T03:01:00Z'::timestamptz,
        '2026-07-12T03:01:01Z'::timestamptz, 'failed', ${"a".repeat(64)}
      )
    `,
    "23514",
    "failed run state",
  );

  const partialRunId = await insertRun({
    entityType: "campaign",
    observedAt: "2026-07-12T03:02:00Z",
    capturedAt: "2026-07-12T03:02:01Z",
    completeness: "partial",
    endpoint: "/campaigns",
  });
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_entity_tombstones (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, reason, provider_evidence_json,
        observed_at, captured_at, run_completeness, tombstone_hash
      ) VALUES (
        ${partialRunId}, ${businessId}, ${businessId}, ${account.id},
        ${providerAccountId}, 'campaign', 'partial_missing', 'explicit_deleted', '{}'::jsonb,
        '2026-07-12T03:02:00Z'::timestamptz,
        '2026-07-12T03:02:01Z'::timestamptz, 'partial', ${"b".repeat(64)}
      )
    `,
    "23514",
    "partial run tombstone",
  );

  await expectPostgresError(
    () => sql`
      INSERT INTO meta_entity_tombstones (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, reason, provider_evidence_json,
        observed_at, captured_at, run_completeness, tombstone_hash
      ) VALUES (
        ${completeRunId}, ${businessId}, ${businessId}, ${account.id},
        ${providerAccountId}, 'campaign', 'complete_not_found', 'explicit_not_found', '{}'::jsonb,
        '2026-07-12T03:00:00Z'::timestamptz,
        '2026-07-12T03:00:01Z'::timestamptz, 'complete', ${"c".repeat(64)}
      )
    `,
    "23514",
    "complete inventory not-found tombstone",
  );

  const pointRunId = await insertRun({
    entityType: "campaign",
    observedAt: "2026-07-12T03:05:00Z",
    capturedAt: "2026-07-12T03:05:01Z",
    completeness: "point_lookup",
    endpoint: "/campaigns/campaign_state_seam",
  });
  await sql`
    INSERT INTO meta_entity_tombstones (
      run_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, entity_id, reason, provider_evidence_json,
      observed_at, captured_at, run_completeness, tombstone_hash
    ) VALUES (
      ${pointRunId}, ${businessId}, ${businessId}, ${account.id},
      ${providerAccountId}, 'campaign', 'campaign_state_seam', 'explicit_not_found',
      ${{ httpStatus: 404 }}::jsonb,
      '2026-07-12T03:05:00Z'::timestamptz,
      '2026-07-12T03:05:01Z'::timestamptz, 'point_lookup', ${"d".repeat(64)}
    )
  `;
  const truth = await readMetaEntityTruthAsOf({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityIds: ["campaign_state_seam"],
    cutoff: "2026-07-12T03:06:00Z",
  });
  assert(
    truth.length === 1 && truth[0]?.eventKind === "tombstone",
    "Latest entity truth did not prefer the later explicit tombstone.",
  );
  const resurrectionRunId = await insertRun({
    entityType: "campaign",
    observedAt: "2026-07-12T03:10:00Z",
    capturedAt: "2026-07-12T03:10:01Z",
    completeness: "complete",
    endpoint: "/campaigns",
  });
  await sql`
    INSERT INTO meta_entity_state_history (
      run_id, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, entity_id, campaign_id,
      configured_status, effective_status, learning_source,
      campaign_daily_budget_raw, budget_currency, budget_origin, presence,
      field_coverage_json, observed_at, captured_at, run_completeness, state_hash
    ) VALUES (
      ${resurrectionRunId}, ${businessId}, ${businessId}, ${account.id},
      ${providerAccountId}, 'campaign', 'campaign_state_seam', 'campaign_state_seam',
      'ACTIVE', 'ACTIVE', 'not_observed', '10000', 'USD', 'campaign', 'present',
      ${{ status: true, budget: true }}::jsonb,
      '2026-07-12T03:10:00Z'::timestamptz,
      '2026-07-12T03:10:01Z'::timestamptz, 'complete', ${stateHash}
    )
  `;
  const resurrectedTruth = await readMetaEntityTruthAsOf({
    businessId,
    providerAccountId,
    entityType: "campaign",
    entityIds: ["campaign_state_seam"],
    cutoff: "2026-07-12T03:11:00Z",
  });
  assert(
    resurrectedTruth.length === 1 && resurrectedTruth[0]?.eventKind === "state",
    "A later complete observation did not supersede the earlier tombstone.",
  );

  const [verifiedAction] = await sql<IdRow>`
    INSERT INTO meta_ads_action_log (
      business_id, ad_id, creative_id, action, source, requested_at, status,
      resulting_ad_id, verified_at
    ) VALUES (
      ${businessId}, 'ad_action_source', 'creative_action', 'duplicate',
      'entity_state_seam', '2026-07-12T03:19:00Z'::timestamptz, 'success',
      'ad_action_target', '2026-07-12T03:20:00Z'::timestamptz
    )
    RETURNING id
  `;
  assert(verifiedAction?.id, "Could not create verified action receipt.");
  const adState = (adId: string, creativeId: string) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    entityId: adId,
    campaignId: "campaign_lineage",
    adsetId: "adset_lineage",
    adId,
    creativeId,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { creativeId: true, parents: true },
    observedAt: "2026-07-12T03:20:30Z",
  });
  const lineageObservation = await persistMetaEntityObservation({
    businessId,
    providerAccountId,
    entityType: "ad",
    endpoint: "ad_configs_lineage",
    observedAt: "2026-07-12T03:21:00Z",
    capturedAt: "2026-07-12T03:21:01Z",
    completeness: "complete",
    pageCount: 1,
    providerRowCount: 4,
    states: [
      adState("ad_source", "creative_reused"),
      adState("ad_target", "creative_reused"),
      adState("ad_action_source", "creative_action"),
      adState("ad_action_target", "creative_action"),
    ],
    adCreativeRelationships: [
      {
        adId: "ad_source",
        creativeId: "creative_reused",
        providerCreatedAt: "2026-07-01T03:00:00Z",
      },
      {
        adId: "ad_target",
        creativeId: "creative_reused",
        providerCreatedAt: "2026-07-02T03:00:00Z",
      },
    ],
  });
  assert(
    lineageObservation.lineageCount === 2,
    "Observed relationship and verified action lineage were not both persisted.",
  );
  const lineage = await readMetaCreativeLineageAsOf({
    businessId,
    providerAccountId,
    creativeId: "creative_reused",
    cutoff: "2026-07-12T03:22:00Z",
  });
  assert(
    lineage.length === 1 &&
      lineage[0]?.lineageType === "reuse_same_creative" &&
      lineage[0]?.observationRunEntityType === "ad",
    "Account-authoritative observed creative lineage did not round-trip.",
  );
  const actionLineage = await readMetaCreativeLineageAsOf({
    businessId,
    providerAccountId,
    creativeId: "creative_action",
    cutoff: "2026-07-12T03:22:00Z",
  });
  assert(
    actionLineage.length === 1 &&
      actionLineage[0]?.actionType === "duplicate" &&
      actionLineage[0]?.actionStatus === "success" &&
      actionLineage[0]?.actionVerifiedAt != null,
    "Verified action lineage did not round-trip.",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, observation_run_id, observation_run_entity_type,
        observation_run_completeness, evidence_json, observed_at, captured_at, lineage_hash
      ) VALUES (
        ${businessId}, ${businessId}, ${account.id}, ${providerAccountId},
        'ad_source', 'creative_reused', 'ad_wrong_target', 'creative_reused',
        'reuse_same_creative', 'observation_run', ${lineageObservation.runId}, 'ad',
        'complete', '{}'::jsonb, '2026-07-12T03:21:00Z'::timestamptz,
        '2026-07-12T03:21:01Z'::timestamptz, ${"5".repeat(64)}
      )
    `,
    "23503",
    "lineage target account-authoritative identity",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, observation_run_id, observation_run_entity_type,
        observation_run_completeness, action_log_id, evidence_json,
        observed_at, captured_at, lineage_hash
      ) VALUES (
        ${businessId}, ${businessId}, ${account.id}, ${providerAccountId},
        'ad_action_source', 'creative_action', 'ad_action_target', 'creative_action',
        'reuse_same_creative', 'verified_action', ${lineageObservation.runId}, 'ad',
        'complete', ${verifiedAction.id}, '{}'::jsonb,
        '2026-07-12T03:21:00Z'::timestamptz,
        '2026-07-12T03:21:01Z'::timestamptz, ${"3".repeat(64)}
      )
    `,
    "23514",
    "untyped verified action lineage",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, observation_run_id, observation_run_entity_type,
        observation_run_completeness, evidence_json, observed_at, captured_at, lineage_hash
      ) VALUES (
        ${businessId}, ${businessId}, ${account.id}, ${providerAccountId},
        'ad_source', 'creative_reused', 'ad_target', 'creative_reused',
        'reuse_same_creative', 'observation_run', ${lineageObservation.runId}, 'ad',
        'complete', '{}'::jsonb, '2026-07-12T03:20:59Z'::timestamptz,
        '2026-07-12T03:21:01Z'::timestamptz, ${"4".repeat(64)}
      )
    `,
    "23503",
    "observation lineage cutoff backdating",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, observation_run_id, observation_run_entity_type,
        observation_run_completeness, evidence_json,
        observed_at, captured_at, lineage_hash
      ) VALUES (
        ${otherBusiness.id}, ${otherBusiness.id}, ${account.id}, ${providerAccountId},
        'ad_source', 'creative_reused', 'ad_target', 'creative_reused',
        'reuse_same_creative', 'observation_run', ${lineageObservation.runId}, 'ad', 'complete', '{}'::jsonb,
        '2026-07-12T03:21:00Z'::timestamptz,
        '2026-07-12T03:21:01Z'::timestamptz, ${"1".repeat(64)}
      )
    `,
    "23503",
    "cross-tenant observation lineage",
  );
  await expectPostgresError(
    () => sql`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, evidence_json, observed_at, captured_at, lineage_hash
      ) VALUES (
        ${businessId}, ${businessId}, ${account.id}, ${providerAccountId},
        'ad_one', 'creative_one', 'ad_two', 'creative_two',
        'rebuild_successor', 'manual_verified', '{}'::jsonb,
        '2026-07-12T03:21:00Z'::timestamptz,
        '2026-07-12T03:21:01Z'::timestamptz, ${"f".repeat(64)}
      )
    `,
    "23514",
    "manual lineage without provider evidence",
  );

  // ── H1-H7. Semantic heartbeat and stable lineage identity ────────────────
  //
  // `run_hash` included observedAt and capturedAt, so replaying the same
  // provider truth one second later was a different run — and every run writes
  // a full state set. Identical inventory observed hourly therefore stored
  // itself hourly, in full. Lineage had the same shape one level down:
  // `lineage_hash` included observationRunId, so "this ad reuses that creative"
  // got a fresh identity on every observation and deduplicated nothing.
  await verifySemanticHeartbeat({
    sql,
    businessId,
    providerAccountId,
  });

  console.log(
    "[entity-state-history-seam] PASS: label history transaction/no-op/as-of, capture cutoff, run authority, explicit tombstones, truth ordering, creative lineage constraints, and the semantic observation heartbeat.",
  );
}

async function verifySemanticHeartbeat(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const ENDPOINT = "campaign_configs_heartbeat";
  void context;

  const census = async () => {
    const [row] = await sql<{
      runs: string;
      states: string;
      repeats: string;
    }>`
      SELECT
        count(DISTINCT run.id)::text AS runs,
        count(state.id)::text AS states,
        COALESCE(max(run.repeat_count), 0)::text AS repeats
      FROM meta_entity_observation_runs run
      LEFT JOIN meta_entity_state_history state ON state.run_id = run.id
      WHERE run.business_id = ${businessId}
        AND run.provider_account_id = ${providerAccountId}
        AND run.endpoint = ${ENDPOINT}
    `;
    return {
      runs: Number(row!.runs),
      states: Number(row!.states),
      repeats: Number(row!.repeats),
    };
  };

  const observation = (input: {
    observedAt: string;
    capturedAt: string;
    status: string;
    completeness?: "complete" | "partial" | "failed";
  }) => ({
    businessId,
    providerAccountId,
    entityType: "campaign" as const,
    endpoint: ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: (input.completeness ?? "complete") as "complete" | "partial" | "failed",
    pageCount: 1,
    providerRowCount: 1,
    ...(input.completeness === "failed"
      ? { states: [], error: { code: "provider_failed" } }
      : {
          states: [
            {
              businessId,
              providerAccountId,
              entityType: "campaign" as const,
              entityId: "campaign_heartbeat",
              campaignId: "campaign_heartbeat",
              learningSource: "not_observed" as const,
              budgetOrigin: "not_applicable" as const,
              presence: "present" as const,
              fieldCoverage: { configuredStatus: true },
              configuredStatus: input.status,
              effectiveStatus: input.status,
              providerUpdatedAt: "2026-06-30T08:00:00Z",
              observedAt: input.observedAt,
            },
          ],
        }),
  });

  // H1: the same truth at MOVING clocks. Ten observations an hour apart, each
  // with a different observedAt and capturedAt, all reporting exactly the same
  // campaign state. Under the old run identity this was ten runs and ten state
  // rows.
  const first = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T00:00:00Z",
      capturedAt: "2026-08-01T00:00:01Z",
      status: "ACTIVE",
    }),
  );
  assert(!first.coalesced, "H1: the first observation should not coalesce.");
  for (let hour = 1; hour <= 9; hour += 1) {
    const repeat = await persistMetaEntityObservation(
      observation({
        observedAt: `2026-08-01T0${hour}:00:00Z`,
        capturedAt: `2026-08-01T0${hour}:00:01Z`,
        status: "ACTIVE",
      }),
    );
    assert(
      repeat.coalesced && repeat.runId === first.runId,
      `H1: observation ${hour} did not coalesce into the first run: ${JSON.stringify(repeat)}`,
    );
  }
  const afterRepeats = await census();
  assert(
    afterRepeats.runs === 1 && afterRepeats.states === 1,
    `H1: 10 identical observations at 10 different clocks produced ${afterRepeats.runs} runs and ${afterRepeats.states} state rows; expected 1 and 1.`,
  );
  assert(
    afterRepeats.repeats === 10,
    `H1: repeat_count is ${afterRepeats.repeats}, expected 10.`,
  );

  // H2: replaying the SAME run — identical clocks included — must add nothing.
  const replay = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T00:00:00Z",
      capturedAt: "2026-08-01T00:00:01Z",
      status: "ACTIVE",
    }),
  );
  assert(replay.runId === first.runId, "H2: a replay created a new run.");
  const afterReplay = await census();
  assert(
    afterReplay.runs === 1 && afterReplay.states === 1,
    `H2: replaying the same run added rows: ${JSON.stringify(afterReplay)}`,
  );

  // H3: concurrency. Eight workers observing the same account and endpoint at
  // once. Without the advisory lock each reads "no matching truth" and each
  // writes a full state set.
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      persistMetaEntityObservation(
        observation({
          observedAt: `2026-08-01T10:0${index}:00Z`,
          capturedAt: `2026-08-01T10:0${index}:01Z`,
          status: "ACTIVE",
        }),
      ),
    ),
  );
  const afterConcurrency = await census();
  assert(
    afterConcurrency.runs === 1 && afterConcurrency.states === 1,
    `H3: 8 concurrent identical observations produced ${afterConcurrency.runs} runs and ${afterConcurrency.states} state rows; the coalescing lock did not serialize them.`,
  );

  // H4: A -> B -> A. Every genuine transition must append, including the return
  // to a previous state — an operator reading history needs to see that the
  // campaign went back, not that nothing happened.
  const toPaused = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T12:00:00Z",
      capturedAt: "2026-08-01T12:00:01Z",
      status: "PAUSED",
    }),
  );
  assert(!toPaused.coalesced, "H4: a state change coalesced instead of appending.");
  const backToActive = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T13:00:00Z",
      capturedAt: "2026-08-01T13:00:01Z",
      status: "ACTIVE",
    }),
  );
  assert(
    !backToActive.coalesced && backToActive.runId !== first.runId,
    "H4: returning to a previous state coalesced into the original run, erasing the transition.",
  );
  const afterTransitions = await census();
  assert(
    afterTransitions.runs === 3 && afterTransitions.states === 3,
    `H4: A->B->A produced ${afterTransitions.runs} runs; expected 3.`,
  );

  // H5: a completeness change is a truth change even when the entity states are
  // byte-identical. "Complete with this campaign" and "partial with this
  // campaign" are different claims.
  const partial = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T14:00:00Z",
      capturedAt: "2026-08-01T14:00:01Z",
      status: "ACTIVE",
      completeness: "partial",
    }),
  );
  assert(
    !partial.coalesced,
    "H5: a complete -> partial change coalesced, so a degraded observation was recorded as a healthy one.",
  );
  // ...and repeated partial truth uses the SHORTER cadence, so a persistent
  // degradation still leaves periodic evidence rather than one row from hours
  // ago. Two minutes later is inside that window, so it coalesces.
  const partialRepeat = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T14:02:00Z",
      capturedAt: "2026-08-01T14:02:01Z",
      status: "ACTIVE",
      completeness: "partial",
    }),
  );
  assert(
    partialRepeat.coalesced && partialRepeat.runId === partial.runId,
    "H5: repeated partial truth did not coalesce inside its cadence.",
  );
  // A degraded receipt is an observation-health event, not an entity-state
  // transition. Returning to the same complete payload must resume the
  // complete heartbeat instead of rewriting every entity merely because the
  // immediately preceding receipt was partial.
  const completeRecovery = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T14:03:00Z",
      capturedAt: "2026-08-01T14:03:01Z",
      status: "ACTIVE",
      completeness: "complete",
    }),
  );
  assert(
    completeRecovery.coalesced && completeRecovery.runId === backToActive.runId,
    "H5: complete recovery after a partial receipt rewrote the identical complete payload.",
  );
  // Past the degraded cadence, a full checkpoint is forced even though nothing
  // changed.
  const partialCheckpoint = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T16:00:00Z",
      capturedAt: "2026-08-01T16:00:01Z",
      status: "ACTIVE",
      completeness: "partial",
    }),
  );
  assert(
    !partialCheckpoint.coalesced,
    "H5: unchanged partial truth never produced a checkpoint, so a long degradation would leave no auditable trail.",
  );

  // H6: a failure is its own truth and must append immediately.
  const failure = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T18:00:00Z",
      capturedAt: "2026-08-01T18:00:01Z",
      status: "ACTIVE",
      completeness: "failed",
    }),
  );
  assert(!failure.coalesced, "H6: a failure coalesced into a successful run.");

  // H6b: complete -> failed -> same complete. The failed receipt lives in its
  // own lane; recovering with the byte-identical complete payload must resume
  // the complete heartbeat instead of rewriting the unchanged payload. This is
  // the exact sequence that produced the production full-manifest rewrites.
  const completeAfterFailure = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T18:05:00Z",
      capturedAt: "2026-08-01T18:05:01Z",
      status: "ACTIVE",
      completeness: "complete",
    }),
  );
  assert(
    completeAfterFailure.coalesced &&
      completeAfterFailure.runId === backToActive.runId,
    "H6b: complete recovery after a FAILED receipt rewrote the identical complete payload.",
  );
  // ...and the heartbeat must have advanced BOTH freshness clocks on the kept
  // run without ever letting captured fall behind seen.
  const [heartbeatClocks] = await sql<{
    last_seen_at: string;
    last_captured_at: string | null;
  }>`
    SELECT last_seen_at::text AS last_seen_at,
           last_captured_at::text AS last_captured_at
    FROM meta_entity_observation_runs
    WHERE id = ${backToActive.runId}::uuid
  `;
  assert(
    heartbeatClocks?.last_captured_at != null &&
      new Date(heartbeatClocks.last_captured_at).getTime() ===
        Date.parse("2026-08-01T18:05:01Z") &&
      new Date(heartbeatClocks.last_seen_at).getTime() ===
        Date.parse("2026-08-01T18:05:00Z") &&
      Date.parse(heartbeatClocks.last_captured_at) >=
        Date.parse(heartbeatClocks.last_seen_at),
    `H6b: heartbeat did not advance last_seen_at/last_captured_at to the latest re-observation (got seen=${heartbeatClocks?.last_seen_at}, captured=${heartbeatClocks?.last_captured_at}).`,
  );

  // H6c: a REAL payload change that first appears while the lane is degraded
  // must still append on the complete lane. Coalescing may only ever reuse
  // byte-identical truth; a status change discovered after a partial/failed
  // window is a genuine transition.
  const pausedWhileDegraded = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T18:10:00Z",
      capturedAt: "2026-08-01T18:10:01Z",
      status: "PAUSED",
      completeness: "partial",
    }),
  );
  assert(
    !pausedWhileDegraded.coalesced,
    "H6c: a changed payload coalesced on the partial lane.",
  );
  const pausedComplete = await persistMetaEntityObservation(
    observation({
      observedAt: "2026-08-01T18:15:00Z",
      capturedAt: "2026-08-01T18:15:01Z",
      status: "PAUSED",
      completeness: "complete",
    }),
  );
  assert(
    !pausedComplete.coalesced && pausedComplete.runId !== backToActive.runId,
    "H6c: a real payload change after a degraded window coalesced into the stale complete run instead of appending.",
  );

  // H7: the PK-collision negative control. Forcing a duplicate primary key must
  // surface as a real error, not be absorbed by the selective legacy handling.
  const [existingState] = await sql<{ id: string }>`
    SELECT id::text AS id FROM meta_entity_state_history
    WHERE business_id = ${businessId} LIMIT 1
  `;
  assert(existingState?.id, "H7: no state row to collide with.");
  const collided = await sql
    .query(
      `INSERT INTO meta_entity_state_history
       SELECT * FROM meta_entity_state_history WHERE id = $1::uuid`,
      [existingState.id],
    )
    .then(
      () => null,
      (error: unknown) => (error as { code?: string })?.code ?? "unknown",
    );
  // 23505 either way: the primary key or the (run_id, entity_id) unique. What
  // matters is that a duplicate surfaces as a real integrity error rather than
  // being absorbed by the selective legacy-conflict handling, which only ever
  // recognises one named constraint.
  assert(
    collided === "23505",
    `H7: a duplicate row did not raise 23505; got ${collided}.`,
  );

  console.log(
    `[entity-state-history-seam] H1-H7 PASS semantic heartbeat: 10 identical observations at 10 different clocks, a same-clock replay and 8 concurrent writers all collapse to ONE run and ONE state row with repeat_count ${afterRepeats.repeats}; A->B->A appends 3; complete->partial appends, repeated partial coalesces inside its shorter cadence, complete recovery resumes the complete heartbeat without rewriting state (after partial AND after failed, advancing last_seen_at/last_captured_at), a payload change first seen while degraded still appends on the complete lane, and partial truth checkpoints past its cadence; a failure appends immediately; and a duplicate primary key still raises 23505`,
  );

  await verifyRelationshipOnlyLineage(context);
  await verifyConfigHistoryTransitions(context);
  await verifyLegacyLineageCollapse(context);
  await verifyStorageContainment(context);
  await verifyDeltaManifests(context);
  await verifyD075ConsumerSweep(context);
}

/**
 * H8 — a relationship that becomes available on a LATER identical observation.
 *
 * The semantic identity is built from entity states alone, so an observation
 * whose states are byte-identical coalesces. That is correct and is the whole
 * point of the heartbeat. What was not correct is that the coalescing branch
 * returned before touching lineage at all, so an ad-creative link the provider
 * omitted on the first response and returned on the second was discarded — and
 * discarded again on every subsequent identical observation.
 */
async function verifyRelationshipOnlyLineage(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const ENDPOINT = "ad_configs_relationship";
  const CREATIVE_ID = "creative_shared_1";

  const adState = (adId: string, createdAt: string) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    entityId: adId,
    campaignId: "campaign_relationship",
    adsetId: "adset_relationship",
    adId,
    creativeId: CREATIVE_ID,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { configuredStatus: true },
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    providerUpdatedAt: createdAt,
    observedAt: "2026-09-01T00:00:00Z",
  });

  const observation = (input: {
    observedAt: string;
    withRelationships: boolean;
  }) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    endpoint: ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.observedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: 2,
    // IDENTICAL in both observations. `observedAt` on the states is fixed, so
    // the semantic hash cannot differ between the two calls: the only thing that
    // changes is whether the provider returned the ad-creative link.
    states: [
      adState("ad_source_1", "2026-06-01T00:00:00Z"),
      adState("ad_target_1", "2026-06-02T00:00:00Z"),
    ],
    ...(input.withRelationships
      ? {
          adCreativeRelationships: [
            {
              adId: "ad_source_1",
              creativeId: CREATIVE_ID,
              providerCreatedAt: "2026-06-01T00:00:00Z",
            },
            {
              adId: "ad_target_1",
              creativeId: CREATIVE_ID,
              providerCreatedAt: "2026-06-02T00:00:00Z",
            },
          ],
        }
      : {}),
  });

  const lineageCount = async () =>
    Number(
      (
        await sql<{ count: string }>`
          SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
          WHERE business_id = ${businessId}
            AND provider_account_id = ${providerAccountId}
            AND source_creative_id = ${CREATIVE_ID}
        `
      )[0]!.count,
    );

  const withoutLinks = await persistMetaEntityObservation(
    observation({ observedAt: "2026-09-01T00:00:00Z", withRelationships: false }) as never,
  );
  assert(!withoutLinks.coalesced, "H8: the first ad observation should append.");
  assert(
    (await lineageCount()) === 0,
    "H8: a lineage edge was recorded from an observation that carried no relationships.",
  );

  const withLinks = await persistMetaEntityObservation(
    observation({ observedAt: "2026-09-01T01:00:00Z", withRelationships: true }) as never,
  );
  assert(
    withLinks.coalesced && withLinks.runId === withoutLinks.runId,
    `H8: the identical state payload did not coalesce, so this proves nothing about the coalesced path: ${JSON.stringify(withLinks)}`,
  );
  assert(
    withLinks.stateCount === 0,
    `H8: the coalesced observation rewrote ${withLinks.stateCount} state rows; identical states must stay coalesced.`,
  );
  const afterLinks = await lineageCount();
  assert(
    afterLinks === 1 && withLinks.lineageCount === 1,
    `H8: a relationship-only change persisted ${afterLinks} edges (writer reported ${withLinks.lineageCount}); the new logical edge must be recorded even though the states coalesced.`,
  );

  // ...and repeating it is a no-op, because the logical arbiter is DO NOTHING.
  const repeated = await persistMetaEntityObservation(
    observation({ observedAt: "2026-09-01T02:00:00Z", withRelationships: true }) as never,
  );
  assert(
    repeated.coalesced && repeated.lineageCount === 0 && (await lineageCount()) === 1,
    `H8: repeating the same relationship appended another edge: ${JSON.stringify(repeated)}`,
  );

  // H8b: the AS-OF cutoff. The edge is attached to the kept run for the
  // composite foreign key's sake, so it carries that run's t1 clocks — and a
  // reader that trusted them reported the relationship as observed at t1, an
  // hour before anyone saw it.
  const { readMetaCreativeLineageAsOf } = await import(
    "@/lib/meta/entity-state-history"
  );
  const asOf = async (cutoff: string) =>
    (
      await readMetaCreativeLineageAsOf({
        businessId,
        providerAccountId,
        cutoff,
        creativeId: CREATIVE_ID,
      })
    ).length;

  // BEFORE t1: the run did not exist.
  assert(
    (await asOf("2026-08-31T23:59:59Z")) === 0,
    "H8b: an edge is visible before the observation run that carries it existed.",
  );
  // BETWEEN t1 and t2: the states were observed, the relationship was not.
  assert(
    (await asOf("2026-09-01T00:30:00Z")) === 0,
    "H8b: the relationship is visible at t1, an hour before it was observed — the coalesced run's clocks are being reported as the observation time.",
  );
  // AT t2 and AFTER: observed.
  assert(
    (await asOf("2026-09-01T01:00:00Z")) === 1 &&
      (await asOf("2026-09-02T00:00:00Z")) === 1,
    "H8b: the relationship is not visible at or after the observation that recorded it.",
  );
  // The row still carries the RUN's clocks, which is what the foreign key needs.
  const [edgeClocks] = await sql<{
    observed_at: string;
    relationship_observed_at: string | null;
  }>`
    SELECT observed_at::text AS observed_at,
           relationship_observed_at::text AS relationship_observed_at
    FROM meta_creative_lineage_edges
    WHERE business_id = ${businessId}
      AND provider_account_id = ${providerAccountId}
      AND source_creative_id = ${CREATIVE_ID}
  `;
  assert(
    edgeClocks != null &&
      edgeClocks.relationship_observed_at != null &&
      edgeClocks.observed_at !== edgeClocks.relationship_observed_at,
    `H8b: the edge does not distinguish the run's clock from the observation's: ${JSON.stringify(edgeClocks)}`,
  );

  console.log(
    "[entity-state-history-seam] H8 PASS relationship-only lineage: an observation with byte-identical states but newly-available ad-creative links coalesces its states (stateCount 0) AND persists the new logical edge; repeating it adds nothing; and an as-of read returns 0 edges before t1, 0 between t1 and t2, and 1 at and after t2 while the row still carries the run's own clocks for its foreign key",
  );
}

/**
 * H14-H17 — config-history transitions, concurrently and out of order.
 *
 * The decision "is this a new configuration?" used to live in a BEFORE INSERT
 * trigger: read the latest fingerprint for the entity, return NULL if unchanged.
 * With no per-entity serialisation two observations of the SAME entity arriving
 * together both read the same latest, so an A -> B -> A sequence could lose the
 * revert — B lands, and the return to A is skipped as "unchanged" against a
 * stale read. Its `ORDER BY captured_at DESC` had no id tie-break either, so two
 * rows at the same instant made the answer nondeterministic.
 */
async function verifyConfigHistoryTransitions(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const { appendMetaCurrentConfigHistory } = await import("@/lib/meta/warehouse");
  const CAMPAIGN_ID = "campaign_transition_probe";

  const campaignRow = (dailyBudget: number) => ({
    businessId,
    providerAccountId,
    date: "2026-10-01",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
    campaignId: CAMPAIGN_ID,
    campaignNameCurrent: "Probe",
    campaignNameHistorical: "Probe",
    campaignStatus: "ACTIVE",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    optimizationGoal: null,
    bidStrategyType: null,
    bidStrategyLabel: null,
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    dailyBudget,
    lifetimeBudget: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    frequency: 0,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 0,
    cpc: 0,
  });

  const write = (dailyBudget: number, observedAt: string, complete = true) =>
    appendMetaCurrentConfigHistory({
      campaignRows: [campaignRow(dailyBudget) as never],
      adsetRows: [],
      campaignReceipt: { complete, observedAt },
      adsetReceipt: { complete: true, observedAt },
    });

  const history = async () =>
    (
      await sql<{ config_fingerprint: string; captured_at: string }>`
        SELECT config_fingerprint, captured_at::text AS captured_at
        FROM meta_campaign_config_history
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND campaign_id = ${CAMPAIGN_ID}
        ORDER BY captured_at ASC, id ASC
      `
    ).map((row) => row.config_fingerprint);

  // H14: an INCOMPLETE receipt records nothing. A partial page set is missing
  // entities, and absence is indistinguishable from deletion downstream.
  const incomplete = await write(1000, "2026-10-01T09:00:00Z", false);
  assert(
    incomplete.campaignRowsWritten === 0 &&
      incomplete.campaignSkippedIncompleteReceipt === true &&
      (await history()).length === 0,
    `H14: an incomplete receipt was recorded as a configuration: ${JSON.stringify(incomplete)}`,
  );

  // H15: exact counts. The writer used to report the ATTEMPTED chunk length, so
  // a chunk the arbiter rejected entirely still reported progress.
  const firstWrite = await write(1000, "2026-10-01T10:00:00Z");
  assert(
    firstWrite.campaignRowsWritten === 1,
    `H15: the first transition reported ${firstWrite.campaignRowsWritten} rows written, expected 1.`,
  );
  const repeatWrite = await write(1000, "2026-10-01T10:00:00Z");
  assert(
    repeatWrite.campaignRowsWritten === 0,
    `H15: an identical repeat reported ${repeatWrite.campaignRowsWritten} rows written; the arbiter rejected it, so the count must be 0.`,
  );

  // H16a: CONCURRENT identical observations. Eight writers, eight distinct
  // instants, one configuration. `captured_at` is part of the arbiter, so
  // without a serialized skip-unchanged decision this is eight rows — which is
  // exactly the growth that made these tables ~22 GB.
  const beforeBurst = (await history()).length;
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      write(1000, `2026-10-01T10:${String(10 + index).padStart(2, "0")}:00Z`),
    ),
  );
  const afterBurst = await history();
  assert(
    afterBurst.length === beforeBurst,
    `H16a: 8 concurrent identical observations appended ${afterBurst.length - beforeBurst} rows; an unchanged configuration must coalesce.`,
  );

  // H16b: SEQUENTIAL A -> B -> A. The revert is itself a transition and must be
  // recorded; the trigger's stale read is what could drop it.
  await write(2000, "2026-10-01T11:00:00Z");
  await write(1000, "2026-10-01T12:00:00Z");
  const afterRevert = await history();
  assert(
    afterRevert.length === beforeBurst + 2 &&
      afterRevert[afterRevert.length - 1] === afterRevert[beforeBurst - 1],
    `H16b: A->B->A did not preserve the revert: ${JSON.stringify(afterRevert)}`,
  );

  // H16c: CONCURRENT DISTINCT transitions. Three different configurations
  // arriving together must all be recorded whatever the interleaving —
  // serialisation is what makes that deterministic. Unserialised, two writers
  // reading the same "latest" is how one of them is lost.
  const beforeDistinct = (await history()).length;
  await Promise.all([
    write(4000, "2026-10-01T13:00:00Z"),
    write(5000, "2026-10-01T13:01:00Z"),
    write(6000, "2026-10-01T13:02:00Z"),
  ]);
  const afterDistinct = await history();
  assert(
    afterDistinct.length === beforeDistinct + 3,
    `H16c: 3 concurrent DISTINCT transitions produced ${afterDistinct.length - beforeDistinct} rows, expected 3: ${JSON.stringify(afterDistinct)}`,
  );
  assert(
    new Set(afterDistinct.slice(beforeDistinct)).size === 3,
    `H16c: concurrent transitions collapsed into fewer distinct configurations: ${JSON.stringify(afterDistinct)}`,
  );

  // H17: OUT-OF-ORDER arrival. An observation from 09:30 arriving after the
  // 12:00 one must still be recorded at its own instant rather than compared
  // against a later row and discarded.
  const outOfOrder = await write(3000, "2026-10-01T09:30:00Z");
  assert(
    outOfOrder.campaignRowsWritten === 1,
    `H17: an out-of-order observation was dropped: ${JSON.stringify(outOfOrder)}`,
  );
  // Compared in UTC: `::text` renders in the server's local time zone, so a
  // substring match on the wall clock would be asserting the server's offset
  // rather than the recorded instant.
  const afterOutOfOrder = await sql<{ captured_at: string }>`
    SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             AS captured_at
    FROM meta_campaign_config_history
    WHERE business_id = ${businessId}
      AND provider_account_id = ${providerAccountId}
      AND campaign_id = ${CAMPAIGN_ID}
    ORDER BY captured_at ASC
    LIMIT 1
  `;
  assert(
    afterOutOfOrder[0]?.captured_at === "2026-10-01T09:30:00Z",
    `H17: the out-of-order row was not filed at its own observation instant: ${JSON.stringify(afterOutOfOrder[0])}`,
  );

  // The triggers that used to make this racy are GONE.
  const triggers = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'trg_skip_unchanged_meta_campaign_config_history',
        'trg_skip_unchanged_meta_adset_config_history'
      )
  `;
  assert(
    Number(triggers[0]!.count) === 0,
    "H14-H17: a config-history trigger still exists; it would silently drop rows the serialized writer decided to keep.",
  );

  console.log(
    `[entity-state-history-seam] H14-H17 PASS config transitions: an incomplete receipt records nothing; counts come from RETURNING so an identical repeat reports 0; 8 concurrent identical observations append 0 rows while 3 concurrent DISTINCT transitions all land; a sequential A->B->A preserves the revert; an out-of-order observation is filed at its own instant; and both racy triggers are gone`,
  );
}

/**
 * H18 — the OPERATIONAL containment pass.
 *
 * Every individual fix was correct and none of them ran. The gate prune had no
 * caller, the lineage collapse existed only inside a seam, and nothing measured
 * whether forward growth had stopped — so the census stayed at ~22 GB of config
 * history, ~3.27 GB of lineage and ~1.35 GB of gates regardless.
 */
async function verifyStorageContainment(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql } = context;
  const { runStorageContainmentPass, measureConfigHistoryForwardGrowth } =
    await import("@/lib/sync/storage-containment");

  const lineageBefore = Number(
    (
      await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
      `
    )[0]!.count,
  );

  // DEFAULT-OFF. The retention lane is disabled, so the pass plans and stamps
  // nothing — and it still reports what it found.
  const savedLane = process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  const dryRun = await runStorageContainmentPass({ lineageBatchLimit: 5 });
  const lineageAfterDryRun = Number(
    (
      await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
      `
    )[0]!.count,
  );
  assert(
    dryRun.mode === "dry_run" && dryRun.lineageCollapse.applied === 0,
    `H18: the default-off pass stamped keepers: ${JSON.stringify(dryRun.lineageCollapse)}`,
  );
  assert(
    lineageAfterDryRun === lineageBefore,
    `H18: the containment pass changed the lineage row count (${lineageBefore} -> ${lineageAfterDryRun}); it has no delete path.`,
  );
  assert(
    dryRun.lineageCollapse.completed,
    `H18: the bounded pass did not reach the end of the table: ${JSON.stringify(dryRun.lineageCollapse)}`,
  );

  // FORWARD GROWTH. Every config-history row written in the last day must be a
  // genuine transition. A redundant row is the per-observation append that made
  // the table 22 GB, and it is the only measurement that says the writer-side
  // containment actually holds.
  for (const measurement of dryRun.configGrowth) {
    assert(
      measurement.redundantLastDay === 0,
      `H18: ${measurement.table} gained ${measurement.redundantLastDay} redundant rows in the last day; forward growth is NOT contained: ${JSON.stringify(measurement)}`,
    );
    assert(
      measurement.rowsLastDay === measurement.transitionsLastDay,
      `H18: ${measurement.table} rows and transitions disagree: ${JSON.stringify(measurement)}`,
    );
  }
  // ...and the measurement is not vacuous: the transitions written earlier in
  // this seam are visible to it.
  const campaignGrowth = await measureConfigHistoryForwardGrowth({
    table: "meta_campaign_config_history",
    entityColumn: "campaign_id",
  });
  assert(
    campaignGrowth.rowsLastDay > 0,
    `H18: the growth measurement sees no rows at all, so "0 redundant" proves nothing: ${JSON.stringify(campaignGrowth)}`,
  );

  // DETERMINISTIC PROGRESS. With the lane on, the pass stamps keepers and a
  // rerun stamps none — the plan converges rather than proposing the same work
  // forever.
  // Both switches: the destructive decision requires the global switch AND the
  // retention lane, which is exactly why "retention stays off" is a real
  // guarantee rather than one flag away from deleting.
  const savedGlobal = process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
  process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
  process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
  // Even with both switches on it stays dry-run unless the CALLER asks: three
  // independent conditions, not one flag.
  const switchesOnButNotRequested = await runStorageContainmentPass({
    lineageBatchLimit: 5,
  });
  assert(
    switchesOnButNotRequested.mode === "dry_run",
    `H18: the pass executed without the caller requesting it: ${JSON.stringify(switchesOnButNotRequested)}`,
  );
  const firstApply = await runStorageContainmentPass({
    lineageBatchLimit: 5,
    forceExecute: true,
  });
  const secondApply = await runStorageContainmentPass({
    lineageBatchLimit: 5,
    forceExecute: true,
  });
  const lineageAfterApply = Number(
    (
      await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
      `
    )[0]!.count,
  );
  assert(
    firstApply.mode === "execute",
    `H18: the pass did not switch to execute with the lane on: ${JSON.stringify(firstApply)}`,
  );
  if (savedLane == null) delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  else process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = savedLane;
  if (savedGlobal == null) delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
  else process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = savedGlobal;

  assert(
    secondApply.lineageCollapse.applied === 0,
    `H18: a second pass stamped ${secondApply.lineageCollapse.applied} more keepers; the plan does not converge.`,
  );
  assert(
    lineageAfterApply === lineageBefore,
    `H18: applying the collapse deleted rows (${lineageBefore} -> ${lineageAfterApply}); it must never delete.`,
  );

  console.log(
    `[entity-state-history-seam] H18 PASS storage containment: the pass is default-off and stays dry-run even with both switches on unless the caller explicitly requests execution, deletes NOTHING in either mode (${lineageBefore} lineage rows before and after), converges (a second apply stamps 0), and measures forward growth as ${campaignGrowth.rowsLastDay} rows / ${campaignGrowth.transitionsLastDay} transitions / ${campaignGrowth.redundantLastDay} redundant in the last day`,
  );
}

/**
 * H9-H13 — the legacy lineage collapse, across page boundaries.
 *
 * Legacy rows carry no logical key, so the pass has to derive one and stamp a
 * single keeper per logical group. Grouping WITHIN a batch is not enough: a
 * group whose rows straddle the batch limit is seen on two pages, and a pass
 * that picks a keeper per page stamps two rows with the same logical key and
 * fails 23505 against its own previous work.
 */
async function verifyLegacyLineageCollapse(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const { planMetaCreativeLineageLegacyCollapse, runMetaCreativeLineageLegacyCollapse } =
    await import("@/lib/meta/creative-lineage-legacy-collapse");
  const ACCOUNT = `${providerAccountId}_collapse`;

  const [existingBinding] = await sql<{ business_ref_id: string }>`
    SELECT business_ref_id::text AS business_ref_id
    FROM meta_creative_lineage_edges
    WHERE business_id = ${businessId}
    LIMIT 1
  `;
  assert(existingBinding, "H9: no existing lineage row to copy a binding from.");
  // Its own provider account, so the row counts below are exact rather than
  // "whatever the earlier cases happened to leave behind".
  const [collapseAccount] = await sql<IdRow>`
    INSERT INTO provider_accounts (provider, external_account_id, account_name)
    VALUES ('meta', ${ACCOUNT}, 'Legacy collapse seam')
    RETURNING id
  `;
  assert(collapseAccount?.id, "H9: could not create the collapse provider account.");
  await sql`
    INSERT INTO business_provider_accounts (
      business_id, provider, provider_account_ref_id, provider_account_id
    ) VALUES (
      ${businessId}, 'meta', ${collapseAccount.id}, ${ACCOUNT}
    )
  `;
  const binding = {
    business_ref_id: existingBinding.business_ref_id,
    provider_account_ref_id: collapseAccount.id,
  };
  // A real observation run, written by the real writer, to anchor the legacy
  // edges to. `meta_creative_lineage_edges` carries composite foreign keys onto
  // both the run identity AND the source/target state rows within it, so a
  // fabricated run would fail for a fixture reason rather than a behavioural
  // one — and would let the collapse pass be tested against rows production
  // could never produce.
  const LEGACY_OBSERVED_AT = "2026-05-01T00:00:00.000Z";
  const legacyPairs: Array<[string, string]> = [
    ["ad_span", "creative_span"],
    ["ad_manual", "creative_manual"],
    ["ad_live", "creative_live"],
    ["ad_race", "creative_race"],
  ];
  const legacyObservation = await persistMetaEntityObservation({
    businessId,
    providerAccountId: ACCOUNT,
    entityType: "ad",
    endpoint: "ad_configs_legacy",
    observedAt: LEGACY_OBSERVED_AT,
    capturedAt: LEGACY_OBSERVED_AT,
    completeness: "complete",
    pageCount: 1,
    providerRowCount: legacyPairs.length * 2,
    states: legacyPairs.flatMap(([prefix, creativeId]) =>
      (["source", "target"] as const).map((role) => ({
        businessId,
        providerAccountId: ACCOUNT,
        entityType: "ad" as const,
        entityId: `${prefix}_${role}`,
        campaignId: "campaign_legacy",
        adsetId: "adset_legacy",
        adId: `${prefix}_${role}`,
        creativeId,
        learningSource: "not_observed" as const,
        budgetOrigin: "not_applicable" as const,
        presence: "present" as const,
        fieldCoverage: { configuredStatus: true },
        configuredStatus: "ACTIVE",
        effectiveStatus: "ACTIVE",
        providerUpdatedAt: LEGACY_OBSERVED_AT,
        observedAt: LEGACY_OBSERVED_AT,
      })),
    ),
  } as never);
  const legacyRun = { id: legacyObservation.runId };
  assert(
    legacyObservation.lineageCount === 0,
    `H9: the anchoring observation created ${legacyObservation.lineageCount} edges of its own, which would contaminate the counts below.`,
  );

  const insertLegacy = async (input: {
    sourceAdId: string;
    targetAdId: string;
    creativeId: string;
    createdAt: string;
    evidenceSource: "observation_run";
    lineageHashSuffix: string;
    evidence?: Record<string, unknown>;
  }) =>
    (
      await sql<{ id: string }>`
        INSERT INTO meta_creative_lineage_edges (
          business_ref_id, business_id, provider_account_ref_id, provider_account_id,
          source_ad_id, source_creative_id, target_ad_id, target_creative_id,
          lineage_type, evidence_source, observation_run_id,
          observation_run_entity_type,
          observation_run_completeness, evidence_json, observed_at, captured_at,
          lineage_hash, logical_lineage_key, created_at
        ) VALUES (
          ${binding.business_ref_id}::uuid, ${businessId},
          ${binding.provider_account_ref_id}::uuid, ${ACCOUNT},
          ${input.sourceAdId}, ${input.creativeId}, ${input.targetAdId},
          ${input.creativeId}, 'reuse_same_creative', ${input.evidenceSource},
          ${legacyRun.id}, 'ad',
          'complete', ${JSON.stringify(input.evidence ?? { legacy: true })}::jsonb,
          ${LEGACY_OBSERVED_AT}::timestamptz, ${LEGACY_OBSERVED_AT}::timestamptz,
          ${createHash("sha256").update(`legacy_${input.lineageHashSuffix}`).digest("hex")},
          NULL, ${input.createdAt}::timestamptz
        )
        RETURNING id::text AS id
      `
    )[0]!.id;

  // One logical group with SIX legacy rows, created at six distinct instants.
  // With limit=2 this group spans three pages.
  const spanning: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    spanning.push(
      await insertLegacy({
        sourceAdId: "ad_span_source",
        targetAdId: "ad_span_target",
        creativeId: "creative_span",
        createdAt: `2026-05-0${i + 1}T00:00:00Z`,
        evidenceSource: "observation_run",
        lineageHashSuffix: `span_${i}`,
      }),
    );
  }
  // An edge carrying CURATED evidence — an operator's verification receipt
  // recorded in evidence_json. The collapse must never rewrite or drop that
  // payload; stamping a logical key is the only mutation it is allowed to make.
  const manualId = await insertLegacy({
    sourceAdId: "ad_manual_source",
    targetAdId: "ad_manual_target",
    creativeId: "creative_manual",
    createdAt: "2026-05-07T00:00:00Z",
    evidenceSource: "observation_run",
    lineageHashSuffix: "manual",
    evidence: { reviewer: "operator-1", note: "confirmed by hand", verified: true },
  });
  // A logical group whose fact is ALREADY represented by a live keyed edge.
  const liveLogicalKey = (
    await import("@/lib/meta/entity-state-history")
  ).buildMetaCreativeLineageLogicalKey({
    businessId,
    providerAccountId: ACCOUNT,
    lineageType: "reuse_same_creative",
    sourceAdId: "ad_live_source",
    sourceCreativeId: "creative_live",
    targetAdId: "ad_live_target",
    targetCreativeId: "creative_live",
    evidenceSource: "observation_run",
  });
  const liveId = (
    await sql<{ id: string }>`
      INSERT INTO meta_creative_lineage_edges (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        source_ad_id, source_creative_id, target_ad_id, target_creative_id,
        lineage_type, evidence_source, observation_run_id,
        observation_run_entity_type,
        observation_run_completeness, evidence_json, observed_at, captured_at,
        lineage_hash, logical_lineage_key, created_at
      ) VALUES (
        ${binding.business_ref_id}::uuid, ${businessId},
        ${binding.provider_account_ref_id}::uuid, ${ACCOUNT},
        'ad_live_source', 'creative_live', 'ad_live_target', 'creative_live',
        'reuse_same_creative', 'observation_run', ${legacyRun.id}, 'ad', 'complete',
        '{"live":true}'::jsonb, ${LEGACY_OBSERVED_AT}::timestamptz,
        ${LEGACY_OBSERVED_AT}::timestamptz,
        ${createHash("sha256").update("live_hash").digest("hex")}, ${liveLogicalKey},
        '2026-05-10T00:00:00Z'::timestamptz
      )
      RETURNING id::text AS id
    `
  )[0]!.id;
  const liveDuplicates: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    liveDuplicates.push(
      await insertLegacy({
        sourceAdId: "ad_live_source",
        targetAdId: "ad_live_target",
        creativeId: "creative_live",
        createdAt: `2026-05-1${i + 1}T00:00:00Z`,
        evidenceSource: "observation_run",
        lineageHashSuffix: `live_dupe_${i}`,
      }),
    );
  }

  const keyedCount = async (sourceAdId: string) =>
    Number(
      (
        await sql<{ count: string }>`
          SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
          WHERE provider_account_id = ${ACCOUNT}
            AND source_ad_id = ${sourceAdId}
            AND logical_lineage_key IS NOT NULL
        `
      )[0]!.count,
    );

  // H9: plan mode mutates nothing.
  const planOnly = await planMetaCreativeLineageLegacyCollapse({ limit: 2 });
  assert(
    planOnly.mode === "plan" && planOnly.applied === 0 && (await keyedCount("ad_span_source")) === 0,
    `H9: plan mode stamped rows: ${JSON.stringify(planOnly)}`,
  );

  // H10: multi-page resume. limit=2 forces the six-row group across pages; the
  // pass must produce exactly ONE keeper for it and never raise 23505.
  const applied = await runMetaCreativeLineageLegacyCollapse({ limit: 2, apply: true });
  assert(
    applied.completed && applied.conflicted === 0,
    `H10: the resumable pass did not complete cleanly: ${JSON.stringify(applied)}`,
  );
  assert(
    applied.batches >= 3,
    `H10: the pass finished in ${applied.batches} batches at limit=2, so it never crossed a page boundary and proves nothing.`,
  );
  const spanKeyed = await keyedCount("ad_span_source");
  assert(
    spanKeyed === 1,
    `H10: a logical group spanning ${applied.batches} pages produced ${spanKeyed} keyed rows; exactly one keeper must carry the logical key.`,
  );
  // The keeper is the OLDEST row: lineage records when a relationship was first
  // observed, so keeping a later row would move that date forward on every pass.
  const [keeper] = await sql<{ id: string }>`
    SELECT id::text AS id FROM meta_creative_lineage_edges
    WHERE provider_account_id = ${ACCOUNT} AND source_ad_id = 'ad_span_source'
      AND logical_lineage_key IS NOT NULL
  `;
  assert(
    keeper!.id === spanning[0],
    `H10: the keeper is ${keeper!.id}, expected the oldest row ${spanning[0]}.`,
  );

  // H11: an existing LIVE keyed edge wins; its legacy duplicates stay unstamped
  // and, crucially, are not stamped into a 23505.
  assert(
    (await keyedCount("ad_live_source")) === 1,
    `H11: the live keyed edge plus ${liveDuplicates.length} legacy duplicates produced ${await keyedCount("ad_live_source")} keyed rows.`,
  );
  const [liveOwner] = await sql<{ id: string }>`
    SELECT id::text AS id FROM meta_creative_lineage_edges
    WHERE provider_account_id = ${ACCOUNT} AND source_ad_id = 'ad_live_source'
      AND logical_lineage_key IS NOT NULL
  `;
  assert(
    liveOwner!.id === liveId,
    `H11: the legacy pass moved the logical key off the live edge (${liveOwner!.id} != ${liveId}).`,
  );

  // H12: nothing was deleted, and manual/verified evidence is byte-intact.
  const total = Number(
    (
      await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
        WHERE provider_account_id = ${ACCOUNT}
      `
    )[0]!.count,
  );
  assert(
    total === spanning.length + 1 + 1 + liveDuplicates.length,
    `H12: the collapse changed the row count to ${total}; it must never delete.`,
  );
  const [manual] = await sql<{
    evidence_json: Record<string, unknown>;
    evidence_source: string;
    logical_lineage_key: string | null;
  }>`
    SELECT evidence_json, evidence_source, logical_lineage_key
    FROM meta_creative_lineage_edges WHERE id = ${manualId}::uuid
  `;
  assert(
    manual!.evidence_json.reviewer === "operator-1" &&
      manual!.evidence_json.note === "confirmed by hand" &&
      manual!.evidence_json.verified === true &&
      manual!.logical_lineage_key != null,
    `H12: curated verification evidence was not preserved with its own logical identity: ${JSON.stringify(manual)}`,
  );

  // H13: idempotent completion. Running the whole pass again stamps nothing new
  // and still reports completion — which is what makes an interrupted run safe
  // to simply restart from the beginning.
  const rerun = await runMetaCreativeLineageLegacyCollapse({ limit: 2, apply: true });
  assert(
    rerun.completed && rerun.applied === 0 && rerun.conflicted === 0,
    `H13: re-running the completed pass was not a no-op: ${JSON.stringify(rerun)}`,
  );

  // H13b: concurrency. Four passes racing from scratch over a fresh group must
  // produce exactly one keeper between them, with losers recorded as conflicts
  // rather than thrown.
  for (let i = 0; i < 4; i += 1) {
    await insertLegacy({
      sourceAdId: "ad_race_source",
      targetAdId: "ad_race_target",
      creativeId: "creative_race",
      createdAt: `2026-05-2${i + 1}T00:00:00Z`,
      evidenceSource: "observation_run",
      lineageHashSuffix: `race_${i}`,
    });
  }
  const racers = await Promise.all(
    Array.from({ length: 4 }, () =>
      runMetaCreativeLineageLegacyCollapse({ limit: 2, apply: true }),
    ),
  );
  const raceKeyed = await keyedCount("ad_race_source");
  assert(
    raceKeyed === 1,
    `H13b: 4 concurrent passes produced ${raceKeyed} keyed rows for one logical group.`,
  );
  assert(
    racers.every((racer) => racer.completed),
    `H13b: a concurrent pass failed instead of recording a conflict: ${JSON.stringify(racers)}`,
  );

  console.log(
    `[entity-state-history-seam] H9-H13 PASS legacy lineage collapse: plan mode stamps nothing; a 6-row logical group split across ${applied.batches} pages at limit=2 yields exactly ONE keeper and it is the oldest row; a live keyed edge keeps the key while its ${liveDuplicates.length} legacy duplicates stay unstamped; no row is ever deleted and curated verification evidence survives byte-intact; re-running the completed pass applies 0; and 4 concurrent passes over a fresh group produce exactly 1 keeper with conflicts recorded rather than thrown`,
  );
}

/**
 * D14 — delta-bounded complete manifests (D075).
 *
 * A complete observation whose endpoint scope already has a complete-lane
 * baseline persists only changed, new, and scope-exited entities; unchanged
 * entities write nothing. `row_count` keeps the LOGICAL full-scope meaning on
 * every run, so a reader reconstructs the exact authoritative membership from
 * the complete lane at or before the run's payload capture clock.
 */
async function verifyDeltaManifests(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const ENDPOINT = "adset_configs_delta";
  const SECOND_ACCOUNT = "act_entity_state_seam_2";

  const census = async (endpoint: string, accountId = providerAccountId) => {
    const [row] = await sql<{
      runs: string;
      states: string;
      delta_runs: string;
      full_runs: string;
    }>`
      SELECT
        count(DISTINCT run.id)::text AS runs,
        count(state.id)::text AS states,
        count(DISTINCT run.id) FILTER (WHERE run.manifest_kind = 'delta')::text
          AS delta_runs,
        count(DISTINCT run.id) FILTER (WHERE run.manifest_kind = 'full')::text
          AS full_runs
      FROM meta_entity_observation_runs run
      LEFT JOIN meta_entity_state_history state ON state.run_id = run.id
      WHERE run.business_id = ${businessId}
        AND run.provider_account_id = ${accountId}
        AND run.endpoint = ${endpoint}
    `;
    return {
      runs: Number(row!.runs),
      states: Number(row!.states),
      deltaRuns: Number(row!.delta_runs),
      fullRuns: Number(row!.full_runs),
    };
  };

  const expectStats = (
    label: string,
    actual: unknown,
    expected: {
      logicalEntityCount: number;
      changedEntityCount: number;
      newEntityCount: number;
      exitedEntityCount: number;
      lineageCarriedEntityCount: number;
      physicalStateRows: number;
    },
  ) => {
    const stats = actual as Record<string, number> | null;
    assert(stats != null, `${label}: deltaStats missing.`);
    for (const [key, value] of Object.entries(expected)) {
      assert(
        stats[key] === value,
        `${label}: deltaStats.${key} is ${stats[key]}, expected ${value}: ${JSON.stringify(stats)}`,
      );
    }
  };

  const adsetObservation = (input: {
    observedAt: string;
    capturedAt: string;
    entities: Array<{ id: string; status: string }>;
    accountId?: string;
  }) => ({
    businessId,
    providerAccountId: input.accountId ?? providerAccountId,
    entityType: "adset" as const,
    endpoint: ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) => ({
      businessId,
      providerAccountId: input.accountId ?? providerAccountId,
      entityType: "adset" as const,
      entityId: entity.id,
      campaignId: "campaign_delta_scope",
      adsetId: entity.id,
      learningSource: "not_observed" as const,
      budgetOrigin: "not_applicable" as const,
      presence: "present" as const,
      fieldCoverage: { configuredStatus: true },
      configuredStatus: entity.status,
      effectiveStatus: entity.status,
      providerUpdatedAt: "2026-08-10T00:00:00Z",
      observedAt: input.observedAt,
    })),
  });

  const A = "adset_delta_a";
  const B = "adset_delta_b";
  const C = "adset_delta_c";
  const active = (id: string) => ({ id, status: "ACTIVE" });
  const paused = (id: string) => ({ id, status: "PAUSED" });

  // D14a: the first complete observation of a scope is a FULL manifest.
  const firstFull = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T00:00:00Z",
      capturedAt: "2026-10-01T00:00:01Z",
      entities: [active(A), active(B), active(C)],
    }),
  );
  assert(
    firstFull.manifestKind === "full" && firstFull.stateCount === 3,
    `D14a: first observation should be a 3-row full manifest: ${JSON.stringify(firstFull)}`,
  );
  expectStats("D14a", firstFull.deltaStats, {
    logicalEntityCount: 3,
    changedEntityCount: 0,
    newEntityCount: 3,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 3,
  });

  // D14b: byte-identical truth still coalesces regardless of manifest kind.
  const heartbeat = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T01:00:00Z",
      capturedAt: "2026-10-01T01:00:01Z",
      entities: [active(A), active(B), active(C)],
    }),
  );
  assert(
    heartbeat.coalesced &&
      heartbeat.runId === firstFull.runId &&
      heartbeat.manifestKind === null,
    `D14b: identical payload did not coalesce into the full run: ${JSON.stringify(heartbeat)}`,
  );

  // D14c: a 1-of-3 change appends exactly ONE physical row, while row_count
  // keeps the logical scope of 3.
  const oneOfThree = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T02:00:00Z",
      capturedAt: "2026-10-01T02:00:01Z",
      entities: [active(A), paused(B), active(C)],
    }),
  );
  assert(
    !oneOfThree.coalesced &&
      oneOfThree.manifestKind === "delta" &&
      oneOfThree.stateCount === 1,
    `D14c: a 1-of-3 change should append one delta row: ${JSON.stringify(oneOfThree)}`,
  );
  expectStats("D14c", oneOfThree.deltaStats, {
    logicalEntityCount: 3,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });
  const [deltaRunRow] = await sql<{
    manifest_kind: string | null;
    base_run_id: string | null;
    row_count: number | string;
    delta_stats_json: unknown;
  }>`
    SELECT manifest_kind, base_run_id, row_count, delta_stats_json
    FROM meta_entity_observation_runs
    WHERE id = ${oneOfThree.runId}::uuid
  `;
  assert(
    deltaRunRow?.manifest_kind === "delta" &&
      deltaRunRow.base_run_id === firstFull.runId &&
      Number(deltaRunRow.row_count) === 3,
    `D14c: the delta run row does not carry kind/base/logical count: ${JSON.stringify(deltaRunRow)}`,
  );
  expectStats(
    "D14c run row",
    deltaRunRow.delta_stats_json,
    {
      logicalEntityCount: 3,
      changedEntityCount: 1,
      newEntityCount: 0,
      exitedEntityCount: 0,
      lineageCarriedEntityCount: 0,
      physicalStateRows: 1,
    },
  );
  const afterOneOfThree = await census(ENDPOINT);
  assert(
    afterOneOfThree.runs === 2 && afterOneOfThree.states === 4,
    `D14c: expected 2 runs and 4 state rows total, got ${JSON.stringify(afterOneOfThree)}`,
  );

  // D14d: scope exit. C leaves the payload; ONE absent_unconfirmed row is
  // appended so no reader can resurrect the stale present row past it.
  const exit = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T03:00:00Z",
      capturedAt: "2026-10-01T03:00:01Z",
      entities: [active(A), paused(B)],
    }),
  );
  assert(
    exit.manifestKind === "delta" && exit.stateCount === 1,
    `D14d: a shrink-by-one should append exactly the exit row: ${JSON.stringify(exit)}`,
  );
  expectStats("D14d", exit.deltaStats, {
    logicalEntityCount: 2,
    changedEntityCount: 0,
    newEntityCount: 0,
    exitedEntityCount: 1,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });
  const [absentRow] = await sql<{
    presence: string;
    learning_source: string;
    budget_origin: string;
    campaign_id: string | null;
    adset_id: string | null;
  }>`
    SELECT presence, learning_source, budget_origin, campaign_id, adset_id
    FROM meta_entity_state_history
    WHERE run_id = ${exit.runId}::uuid AND entity_id = ${C}
  `;
  assert(
    absentRow?.presence === "absent_unconfirmed" &&
      absentRow.learning_source === "not_observed" &&
      absentRow.budget_origin === "not_observed" &&
      absentRow.campaign_id === "campaign_delta_scope" &&
      absentRow.adset_id === C,
    `D14d: the exit row is not an identity-preserving absent record: ${JSON.stringify(absentRow)}`,
  );
  const winnersAt = async (cutoff: string) => {
    const rows = await readMetaEntityStatesAsOf({
      businessId,
      providerAccountId,
      entityType: "adset",
      entityIds: [A, B, C],
      cutoff,
    });
    return new Map(rows.map((row) => [row.entityId, row]));
  };
  const afterExit = await winnersAt("2026-10-01T03:30:00Z");
  assert(
    afterExit.get(C)?.presence === "absent_unconfirmed" &&
      afterExit.get(A)?.presence === "present" &&
      afterExit.get(B)?.presence === "present" &&
      afterExit.get(B)?.configuredStatus === "PAUSED",
    "D14d: as-of after the exit must show C absent and A/B present.",
  );
  const beforeExit = await winnersAt("2026-10-01T02:30:00Z");
  assert(
    beforeExit.get(C)?.presence === "present" &&
      beforeExit.get(C)?.configuredStatus === "ACTIVE",
    "D14d: an as-of cutoff BEFORE the exit must still show C present.",
  );

  // D14e: re-observation after an exit re-enters as a new member.
  const reentry = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T04:00:00Z",
      capturedAt: "2026-10-01T04:00:01Z",
      entities: [active(A), paused(B), active(C)],
    }),
  );
  assert(
    reentry.manifestKind === "delta" && reentry.stateCount === 1,
    `D14e: re-entry should append one present row: ${JSON.stringify(reentry)}`,
  );
  expectStats("D14e", reentry.deltaStats, {
    logicalEntityCount: 3,
    changedEntityCount: 0,
    newEntityCount: 1,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });
  const afterReentry = await winnersAt("2026-10-01T04:30:00Z");
  assert(
    afterReentry.get(C)?.presence === "present" &&
      afterReentry.get(C)?.configuredStatus === "ACTIVE",
    "D14e: as-of after re-entry must show C present again.",
  );

  // D14f: past the checkpoint cadence, unchanged truth forces a NEW run that
  // owns ZERO state rows — the audit checkpoint costs run metadata only.
  const checkpoint = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-02T05:00:00Z",
      capturedAt: "2026-10-02T05:00:01Z",
      entities: [active(A), paused(B), active(C)],
    }),
  );
  assert(
    !checkpoint.coalesced &&
      checkpoint.manifestKind === "delta" &&
      checkpoint.stateCount === 0,
    `D14f: a forced checkpoint should be a zero-row delta run: ${JSON.stringify(checkpoint)}`,
  );
  expectStats("D14f", checkpoint.deltaStats, {
    logicalEntityCount: 3,
    changedEntityCount: 0,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 0,
  });
  const [checkpointRow] = await sql<{ row_count: number | string }>`
    SELECT row_count FROM meta_entity_observation_runs
    WHERE id = ${checkpoint.runId}::uuid
  `;
  assert(
    Number(checkpointRow?.row_count) === 3,
    `D14f: the checkpoint run must keep the logical row_count of 3: ${JSON.stringify(checkpointRow)}`,
  );
  const resumed = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-02T06:00:00Z",
      capturedAt: "2026-10-02T06:00:01Z",
      entities: [active(A), paused(B), active(C)],
    }),
  );
  assert(
    resumed.coalesced && resumed.runId === checkpoint.runId,
    `D14f: the heartbeat should resume on the checkpoint run: ${JSON.stringify(resumed)}`,
  );

  // D14g: a failed receipt stays a FULL-schema lane (manifest_kind NULL) and
  // does not break the complete lane's heartbeat.
  const failure = await persistMetaEntityObservation({
    businessId,
    providerAccountId,
    entityType: "adset",
    endpoint: ENDPOINT,
    observedAt: "2026-10-02T07:00:00Z",
    capturedAt: "2026-10-02T07:00:01Z",
    completeness: "failed",
    pageCount: 1,
    providerRowCount: 1,
    states: [],
    error: { code: "provider_failed" },
  });
  assert(
    failure.manifestKind === null && failure.deltaStats === null,
    `D14g: a failed run must not claim a manifest kind: ${JSON.stringify(failure)}`,
  );
  const afterFailure = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-02T08:00:00Z",
      capturedAt: "2026-10-02T08:00:01Z",
      entities: [active(A), paused(B), active(C)],
    }),
  );
  assert(
    afterFailure.coalesced && afterFailure.runId === checkpoint.runId,
    `D14g: the complete lane did not survive an interleaved failure: ${JSON.stringify(afterFailure)}`,
  );

  // D14h: replaying the exact bytes of the historical shrink run adds nothing.
  const beforeReplay = await census(ENDPOINT);
  const replay = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-01T03:00:00Z",
      capturedAt: "2026-10-01T03:00:01Z",
      entities: [active(A), paused(B)],
    }),
  );
  const afterReplay = await census(ENDPOINT);
  assert(
    replay.runId === exit.runId &&
      afterReplay.runs === beforeReplay.runs &&
      afterReplay.states === beforeReplay.states,
    `D14h: a replay of the shrink run changed storage: ${JSON.stringify({ replay, beforeReplay, afterReplay })}`,
  );

  // D14i: 8 concurrent observers of the SAME changed truth serialize into one
  // delta run with one physical row.
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      persistMetaEntityObservation(
        adsetObservation({
          observedAt: `2026-10-02T09:0${index}:00Z`,
          capturedAt: `2026-10-02T09:0${index}:01Z`,
          entities: [paused(A), paused(B), active(C)],
        }),
      ),
    ),
  );
  const appended = results.filter((result) => !result.coalesced);
  const afterRace = await census(ENDPOINT);
  assert(
    appended.length === 1 &&
      appended[0]!.stateCount === 1 &&
      afterRace.runs === beforeReplay.runs + 1 &&
      afterRace.states === beforeReplay.states + 1,
    `D14i: 8 concurrent changed observations must produce ONE delta run and ONE row: ${JSON.stringify({ appended: appended.length, afterRace })}`,
  );

  // D14j: account isolation. The same endpoint on a different account starts
  // its own FULL manifest; the first account's baseline never leaks in as
  // fabricated exits.
  const otherAccount = await persistMetaEntityObservation(
    adsetObservation({
      observedAt: "2026-10-02T10:00:00Z",
      capturedAt: "2026-10-02T10:00:01Z",
      entities: [active("adset_delta_other")],
      accountId: SECOND_ACCOUNT,
    }),
  );
  assert(
    otherAccount.manifestKind === "full" && otherAccount.stateCount === 1,
    `D14j: the second account should begin with its own full manifest: ${JSON.stringify(otherAccount)}`,
  );
  expectStats("D14j", otherAccount.deltaStats, {
    logicalEntityCount: 1,
    changedEntityCount: 0,
    newEntityCount: 1,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });

  // D14k: endpoint isolation. A second complete endpoint over the SAME entity
  // type diffs only against its own scope — the delta baseline must not treat
  // the first endpoint's adsets as scope exits.
  const SIBLING_ENDPOINT = "adset_configs_delta_sibling";
  const siblingFirst = await persistMetaEntityObservation({
    ...adsetObservation({
      observedAt: "2026-10-02T11:00:00Z",
      capturedAt: "2026-10-02T11:00:01Z",
      entities: [active("adset_delta_sibling")],
    }),
    endpoint: SIBLING_ENDPOINT,
  });
  const siblingSecond = await persistMetaEntityObservation({
    ...adsetObservation({
      observedAt: "2026-10-02T12:00:00Z",
      capturedAt: "2026-10-02T12:00:01Z",
      entities: [paused("adset_delta_sibling")],
    }),
    endpoint: SIBLING_ENDPOINT,
  });
  assert(
    siblingFirst.manifestKind === "full" &&
      siblingSecond.manifestKind === "delta" &&
      siblingSecond.stateCount === 1,
    `D14k: sibling endpoint runs have the wrong shape: ${JSON.stringify({ siblingFirst, siblingSecond })}`,
  );
  expectStats("D14k", siblingSecond.deltaStats, {
    logicalEntityCount: 1,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });

  // D14l: lineage force-include. An UNCHANGED ad named by this observation's
  // creative relationships still gets a durable row in the delta run, because
  // lineage edges FK-reference state rows by run.
  const LINEAGE_ENDPOINT = "ad_configs_delta_lineage";
  const LINEAGE_CREATIVE = "creative_delta_lineage";
  const lineageAd = (adId: string, status: string) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    entityId: adId,
    campaignId: "campaign_delta_lineage",
    adsetId: "adset_delta_lineage",
    adId,
    creativeId: LINEAGE_CREATIVE,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { configuredStatus: true },
    configuredStatus: status,
    effectiveStatus: status,
    providerUpdatedAt: "2026-08-10T00:00:00Z",
    observedAt: "2026-10-03T00:00:00Z",
  });
  const lineageBase = await persistMetaEntityObservation({
    businessId,
    providerAccountId,
    entityType: "ad",
    endpoint: LINEAGE_ENDPOINT,
    observedAt: "2026-10-03T00:00:00Z",
    capturedAt: "2026-10-03T00:00:01Z",
    completeness: "complete",
    pageCount: 1,
    providerRowCount: 2,
    states: [lineageAd("ad_delta_l1", "ACTIVE"), lineageAd("ad_delta_l2", "ACTIVE")],
  });
  assert(
    lineageBase.manifestKind === "full" && lineageBase.stateCount === 2,
    `D14l: lineage baseline should be a 2-row full manifest: ${JSON.stringify(lineageBase)}`,
  );
  const lineageDelta = await persistMetaEntityObservation({
    businessId,
    providerAccountId,
    entityType: "ad",
    endpoint: LINEAGE_ENDPOINT,
    observedAt: "2026-10-03T01:00:00Z",
    capturedAt: "2026-10-03T01:00:01Z",
    completeness: "complete",
    pageCount: 1,
    providerRowCount: 2,
    states: [
      { ...lineageAd("ad_delta_l1", "ACTIVE"), observedAt: "2026-10-03T01:00:00Z" },
      { ...lineageAd("ad_delta_l2", "PAUSED"), observedAt: "2026-10-03T01:00:00Z" },
    ],
    adCreativeRelationships: [
      {
        adId: "ad_delta_l1",
        creativeId: LINEAGE_CREATIVE,
        providerCreatedAt: "2026-06-01T00:00:00Z",
      },
      {
        adId: "ad_delta_l2",
        creativeId: LINEAGE_CREATIVE,
        providerCreatedAt: "2026-06-02T00:00:00Z",
      },
    ],
  });
  assert(
    lineageDelta.manifestKind === "delta" && lineageDelta.stateCount === 2,
    `D14l: the delta must carry the unchanged relationship ad too: ${JSON.stringify(lineageDelta)}`,
  );
  expectStats("D14l", lineageDelta.deltaStats, {
    logicalEntityCount: 2,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 1,
    physicalStateRows: 2,
  });
  const [lineageEdges] = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
    WHERE business_id = ${businessId}
      AND provider_account_id = ${providerAccountId}
      AND source_creative_id = ${LINEAGE_CREATIVE}
      AND observation_run_id = ${lineageDelta.runId}::uuid
  `;
  assert(
    Number(lineageEdges?.count) >= 1,
    `D14l: no lineage edge landed on the delta run: ${JSON.stringify(lineageEdges)}`,
  );

  // D14n: a relationship first seen on a COALESCING observation whose kept
  // delta run lacks the named ad's row. The row is carried into the kept run
  // (byte-identical to the lane winner) so the edge can attach, the run's
  // delta stats stay truthful, and repeating the observation adds nothing.
  const LC_ENDPOINT = "ad_configs_delta_lineage_coalesce";
  const LC_CREATIVE = "creative_delta_lc";
  const lcAd = (adId: string, status: string, observedAt: string) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    entityId: adId,
    campaignId: "campaign_delta_lc",
    adsetId: "adset_delta_lc",
    adId,
    creativeId: LC_CREATIVE,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { configuredStatus: true },
    configuredStatus: status,
    effectiveStatus: status,
    providerUpdatedAt: "2026-08-10T00:00:00Z",
    observedAt,
  });
  const lcObservation = (input: {
    observedAt: string;
    capturedAt: string;
    secondStatus: string;
    withRelationships: boolean;
  }) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    endpoint: LC_ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: 2,
    states: [
      lcAd("ad_lc_1", "ACTIVE", input.observedAt),
      lcAd("ad_lc_2", input.secondStatus, input.observedAt),
    ],
    ...(input.withRelationships
      ? {
          adCreativeRelationships: [
            {
              adId: "ad_lc_1",
              creativeId: LC_CREATIVE,
              providerCreatedAt: "2026-06-01T00:00:00Z",
            },
            {
              adId: "ad_lc_2",
              creativeId: LC_CREATIVE,
              providerCreatedAt: "2026-06-02T00:00:00Z",
            },
          ],
        }
      : {}),
  });
  const lcFull = await persistMetaEntityObservation(
    lcObservation({
      observedAt: "2026-10-05T00:00:00Z",
      capturedAt: "2026-10-05T00:00:01Z",
      secondStatus: "ACTIVE",
      withRelationships: false,
    }),
  );
  const lcDelta = await persistMetaEntityObservation(
    lcObservation({
      observedAt: "2026-10-05T01:00:00Z",
      capturedAt: "2026-10-05T01:00:01Z",
      secondStatus: "PAUSED",
      withRelationships: false,
    }),
  );
  assert(
    lcFull.manifestKind === "full" &&
      lcDelta.manifestKind === "delta" &&
      lcDelta.stateCount === 1,
    `D14n: setup runs have the wrong shape: ${JSON.stringify({ lcFull, lcDelta })}`,
  );
  const lcCoalesced = await persistMetaEntityObservation(
    lcObservation({
      observedAt: "2026-10-05T02:00:00Z",
      capturedAt: "2026-10-05T02:00:01Z",
      secondStatus: "PAUSED",
      withRelationships: true,
    }),
  );
  assert(
    lcCoalesced.coalesced &&
      lcCoalesced.runId === lcDelta.runId &&
      lcCoalesced.lineageCount === 1 &&
      lcCoalesced.stateCount === 1,
    `D14n: the coalescing relationship observation did not carry + record: ${JSON.stringify(lcCoalesced)}`,
  );
  const [lcCarriedRow] = await sql<{
    presence: string;
    captured_at: string;
    state_hash: string;
  }>`
    SELECT presence, captured_at::text AS captured_at, state_hash
    FROM meta_entity_state_history
    WHERE run_id = ${lcDelta.runId}::uuid AND entity_id = 'ad_lc_1'
  `;
  const [lcKeptRun] = await sql<{
    captured_at: string;
    delta_stats_json: unknown;
  }>`
    SELECT captured_at::text AS captured_at, delta_stats_json
    FROM meta_entity_observation_runs
    WHERE id = ${lcDelta.runId}::uuid
  `;
  assert(
    lcCarriedRow?.presence === "present" &&
      lcKeptRun != null &&
      lcCarriedRow.captured_at === lcKeptRun.captured_at,
    `D14n: the carried row is missing or does not take the kept run's clocks: ${JSON.stringify({ lcCarriedRow, lcKeptRun })}`,
  );
  expectStats(
    "D14n kept-run stats",
    lcKeptRun.delta_stats_json,
    {
      logicalEntityCount: 2,
      changedEntityCount: 1,
      newEntityCount: 0,
      exitedEntityCount: 0,
      lineageCarriedEntityCount: 1,
      physicalStateRows: 2,
    },
  );
  const [lcEdge] = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM meta_creative_lineage_edges
    WHERE business_id = ${businessId}
      AND provider_account_id = ${providerAccountId}
      AND source_creative_id = ${LC_CREATIVE}
      AND observation_run_id = ${lcDelta.runId}::uuid
  `;
  assert(
    Number(lcEdge?.count) === 1,
    `D14n: the coalesced relationship edge did not land on the kept run: ${JSON.stringify(lcEdge)}`,
  );
  const lcRepeat = await persistMetaEntityObservation(
    lcObservation({
      observedAt: "2026-10-05T03:00:00Z",
      capturedAt: "2026-10-05T03:00:01Z",
      secondStatus: "PAUSED",
      withRelationships: true,
    }),
  );
  const [lcStatsAfterRepeat] = await sql<{ delta_stats_json: unknown }>`
    SELECT delta_stats_json FROM meta_entity_observation_runs
    WHERE id = ${lcDelta.runId}::uuid
  `;
  assert(
    lcRepeat.coalesced &&
      lcRepeat.stateCount === 0 &&
      lcRepeat.lineageCount === 0,
    `D14n: repeating the relationship observation was not a no-op: ${JSON.stringify(lcRepeat)}`,
  );
  expectStats(
    "D14n stats after repeat",
    lcStatsAfterRepeat?.delta_stats_json,
    {
      logicalEntityCount: 2,
      changedEntityCount: 1,
      newEntityCount: 0,
      exitedEntityCount: 0,
      lineageCarriedEntityCount: 1,
      physicalStateRows: 2,
    },
  );

  // D14m: the acceptance measurement. A 1,042-ad full scope followed by a
  // 1-ad change appends exactly ONE row, not 1,042.
  const BULK_ENDPOINT = "ad_configs_delta_bulk";
  const bulkAd = (index: number, status: string, observedAt: string) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    entityId: `ad_bulk_${String(index).padStart(4, "0")}`,
    campaignId: "campaign_delta_bulk",
    adsetId: "adset_delta_bulk",
    adId: `ad_bulk_${String(index).padStart(4, "0")}`,
    learningSource: "not_observed" as const,
    budgetOrigin: "not_applicable" as const,
    presence: "present" as const,
    fieldCoverage: { configuredStatus: true },
    configuredStatus: status,
    effectiveStatus: status,
    providerUpdatedAt: "2026-08-10T00:00:00Z",
    observedAt,
  });
  const bulkObservation = (input: {
    observedAt: string;
    capturedAt: string;
    changedIndex: number | null;
  }) => ({
    businessId,
    providerAccountId,
    entityType: "ad" as const,
    endpoint: BULK_ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 11,
    providerRowCount: 1042,
    states: Array.from({ length: 1042 }, (_, index) =>
      bulkAd(
        index,
        index === input.changedIndex ? "PAUSED" : "ACTIVE",
        input.observedAt,
      ),
    ),
  });
  const bulkFull = await persistMetaEntityObservation(
    bulkObservation({
      observedAt: "2026-10-04T00:00:00Z",
      capturedAt: "2026-10-04T00:00:01Z",
      changedIndex: null,
    }),
  );
  assert(
    bulkFull.manifestKind === "full" && bulkFull.stateCount === 1042,
    `D14m: the bulk baseline should persist all 1,042 rows once: ${JSON.stringify({ manifestKind: bulkFull.manifestKind, stateCount: bulkFull.stateCount })}`,
  );
  const bulkDelta = await persistMetaEntityObservation(
    bulkObservation({
      observedAt: "2026-10-04T01:00:00Z",
      capturedAt: "2026-10-04T01:00:01Z",
      changedIndex: 421,
    }),
  );
  assert(
    bulkDelta.manifestKind === "delta" && bulkDelta.stateCount === 1,
    `D14m: a 1-of-1,042 change appended ${bulkDelta.stateCount} rows; expected 1.`,
  );
  expectStats("D14m", bulkDelta.deltaStats, {
    logicalEntityCount: 1042,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });
  const bulkCensus = await census(BULK_ENDPOINT);
  assert(
    bulkCensus.runs === 2 && bulkCensus.states === 1043,
    `D14m: bulk storage should hold 2 runs and 1,043 rows, got ${JSON.stringify(bulkCensus)}`,
  );

  // D14o: an older observation may be captured after newer live truth. The
  // delta predecessor is selected by observed_at first (bounded by the
  // incoming observation), with captured_at only breaking equal-observed
  // ties. Otherwise the backfill becomes a false baseline and the next live
  // transition is silently omitted.
  const ORDER_ENDPOINT = "adset_configs_delta_observation_order";
  const OA = "adset_delta_order_a";
  const OB = "adset_delta_order_b";
  const orderedObservation = (input: {
    observedAt: string;
    capturedAt: string;
    aStatus: string;
    bStatus: string;
  }) => ({
    ...adsetObservation({
      observedAt: input.observedAt,
      capturedAt: input.capturedAt,
      entities: [
        { id: OA, status: input.aStatus },
        { id: OB, status: input.bStatus },
      ],
    }),
    endpoint: ORDER_ENDPOINT,
  });

  const orderFull = await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T10:00:00Z",
      capturedAt: "2026-10-06T10:00:01Z",
      aStatus: "ACTIVE",
      bStatus: "ACTIVE",
    }),
  );
  const orderLive = await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T12:00:00Z",
      capturedAt: "2026-10-06T12:00:01Z",
      aStatus: "PAUSED",
      bStatus: "ACTIVE",
    }),
  );
  const orderBackfill = await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T11:00:00Z",
      capturedAt: "2026-10-06T13:00:00Z",
      aStatus: "ACTIVE",
      bStatus: "ACTIVE",
    }),
  );
  assert(
    orderFull.manifestKind === "full" &&
      orderLive.stateCount === 1 &&
      orderBackfill.manifestKind === "delta" &&
      orderBackfill.stateCount === 0,
    `D14o: the out-of-order backfill compared against future truth: ${JSON.stringify({ orderFull, orderLive, orderBackfill })}`,
  );
  const orderNextLive = await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T14:00:00Z",
      capturedAt: "2026-10-06T14:00:01Z",
      aStatus: "ACTIVE",
      bStatus: "ACTIVE",
    }),
  );
  expectStats("D14o observed-at predecessor", orderNextLive.deltaStats, {
    logicalEntityCount: 2,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });

  // Two different facts can share an observation timestamp. Insert the
  // later-captured fact first, then the earlier-captured fact, so created_at
  // cannot accidentally masquerade as the required captured_at tie-breaker.
  await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T15:00:00Z",
      capturedAt: "2026-10-06T15:00:02Z",
      aStatus: "PAUSED",
      bStatus: "ACTIVE",
    }),
  );
  await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T15:00:00Z",
      capturedAt: "2026-10-06T15:00:01Z",
      aStatus: "ARCHIVED",
      bStatus: "ACTIVE",
    }),
  );
  const captureTieProbe = await persistMetaEntityObservation(
    orderedObservation({
      observedAt: "2026-10-06T16:00:00Z",
      capturedAt: "2026-10-06T16:00:01Z",
      aStatus: "PAUSED",
      bStatus: "PAUSED",
    }),
  );
  expectStats("D14o captured-at tie-breaker", captureTieProbe.deltaStats, {
    logicalEntityCount: 2,
    changedEntityCount: 1,
    newEntityCount: 0,
    exitedEntityCount: 0,
    lineageCarriedEntityCount: 0,
    physicalStateRows: 1,
  });

  console.log(
    "[entity-state-history-seam] D14 PASS delta manifests: first-complete stays a full manifest; identical truth coalesces across kinds; 1-of-3 appends one row with logical row_count 3; a scope exit appends one absent_unconfirmed row that as-of reads honor (and earlier cutoffs ignore); re-entry appends one present row; a forced checkpoint is a zero-row delta run the heartbeat resumes on; failed lanes stay kind-less and do not break the complete lane; replays add nothing; 8 concurrent changed observers serialize to one delta row; account and sibling-endpoint scopes never fabricate exits; relationship-named unchanged ads are carried for the lineage FK on the append path AND on the coalesced path (with truthful kept-run stats and no-op repeats); a 1-of-1,042 change appends exactly ONE physical row (2 runs / 1,043 rows total); and out-of-order backfills use an incoming-bounded observed_at predecessor with a deterministic captured_at tie-breaker.",
  );
}


/**
 * D15 — D075 consumer sweep (real-Postgres proofs for the reader fixes).
 *
 * a) confirmed_until: the operator-response truth query certifies window-end
 *    truth for UNCHANGED entities from the run heartbeat and later delta
 *    manifests, caps every confirmation at the target cutoff, and never
 *    extends a superseded row past its own confirmation.
 * b) generic status projection: an absent_unconfirmed winner serves NULL —
 *    never a fabricated DELETED, never a resurrected present status.
 * c) history transitions: computed over present rows only — a scope exit is
 *    not a status change, and a re-entry change is not masked by absence.
 * d) the natural-wave verifier's membership count is manifest-kind-aware: a
 *    delta run counts its reconstructed members, not its run-bound rows.
 */
async function verifyD075ConsumerSweep(context: {
  sql: ReturnType<typeof getDb>;
  businessId: string;
  providerAccountId: string;
}) {
  const { sql, businessId, providerAccountId } = context;
  const ENDPOINT = "adset_configs_sweep";
  const S1 = "adset_sweep_stable";
  const S2 = "adset_sweep_changing";

  const observation = (input: {
    observedAt: string;
    capturedAt: string;
    entities: Array<{ id: string; status: string }>;
  }) => ({
    businessId,
    providerAccountId,
    entityType: "adset" as const,
    endpoint: ENDPOINT,
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    completeness: "complete" as const,
    pageCount: 1,
    providerRowCount: input.entities.length,
    states: input.entities.map((entity) => ({
      businessId,
      providerAccountId,
      entityType: "adset" as const,
      entityId: entity.id,
      campaignId: "campaign_sweep_scope",
      adsetId: entity.id,
      learningSource: "not_observed" as const,
      budgetOrigin: "not_applicable" as const,
      presence: "present" as const,
      fieldCoverage: { configuredStatus: true },
      configuredStatus: entity.status,
      effectiveStatus: entity.status,
      providerUpdatedAt: "2026-11-01T00:00:00Z",
      observedAt: input.observedAt,
    })),
  });

  const T1 = "2026-11-01T00:00:00Z";
  const T2 = "2026-11-01T06:00:00Z"; // inside the complete cadence: heartbeat
  const T3 = "2026-11-01T12:00:00Z"; // S2 changes: delta run

  await persistMetaEntityObservation(
    observation({
      observedAt: T1,
      capturedAt: T1,
      entities: [
        { id: S1, status: "ACTIVE" },
        { id: S2, status: "ACTIVE" },
      ],
    }),
  );
  const heartbeat = await persistMetaEntityObservation(
    observation({
      observedAt: T2,
      capturedAt: T2,
      entities: [
        { id: S1, status: "ACTIVE" },
        { id: S2, status: "ACTIVE" },
      ],
    }),
  );
  assert(
    heartbeat.stateCount === 0,
    `D15: identical observation should coalesce, got ${JSON.stringify(heartbeat)}`,
  );
  const delta = await persistMetaEntityObservation(
    observation({
      observedAt: T3,
      capturedAt: T3,
      entities: [
        { id: S1, status: "ACTIVE" },
        { id: S2, status: "PAUSED" },
      ],
    }),
  );
  assert(
    delta.manifestKind === "delta" && delta.stateCount === 1,
    `D15: 1-of-2 change should append one delta row, got ${JSON.stringify(delta)}`,
  );

  const [binding] = await sql<{ ref: string }>`
    SELECT provider_account_ref_id::text AS ref
    FROM business_provider_accounts
    WHERE business_id = ${businessId}
      AND provider_account_id = ${providerAccountId}
  `;
  assert(binding?.ref, "D15: missing provider binding.");

  // ---- (a) confirmed_until through the operator-response truth query ----
  const truthRows = async (windowEnd: string, cutoff: string) => {
    const targets = [S1, S2].map((entityId) => ({
      episode_key: "e".repeat(64),
      business_id: businessId,
      provider_account_ref_id: binding.ref,
      provider_account_id: providerAccountId,
      entity_type: "adset",
      entity_id: entityId,
      recommended_at: "2026-11-01T00:01:00Z",
      window_end: windowEnd,
      cutoff,
    }));
    return sql.query<{
      entity_id: string;
      configured_status: string | null;
      observed_at: string;
      captured_at: string;
      confirmed_until: string;
    }>(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY, [JSON.stringify(targets)]);
  };

  // Window ends after the heartbeat and before the delta: S1's only row was
  // first-captured at T1 but is confirmed through T3 (heartbeat T2, then the
  // delta manifest re-observed it unchanged). Pre-fix no row could certify
  // this window end.
  const midWindow = await truthRows("2026-11-01T09:00:00Z", "2026-11-01T13:00:00Z");
  const s1Mid = midWindow.filter((row) => row.entity_id === S1);
  assert(
    s1Mid.length === 1 &&
      new Date(s1Mid[0]!.confirmed_until).toISOString() ===
        new Date(T3).toISOString(),
    `D15a: S1 confirmed_until should be the delta clock ${T3}: ${JSON.stringify(s1Mid)}`,
  );
  // S2's superseded T1 row gains no delta extension (a newer row exists); its
  // confirmation stops at the heartbeat T2. Its T3 row is its own capture.
  const s2Mid = midWindow.filter((row) => row.entity_id === S2);
  const s2Old = s2Mid.find((row) => row.configured_status === "ACTIVE");
  const s2New = s2Mid.find((row) => row.configured_status === "PAUSED");
  assert(
    s2Old &&
      new Date(s2Old.confirmed_until).toISOString() ===
        new Date(T2).toISOString(),
    `D15a: superseded S2 row must stop at the heartbeat ${T2}: ${JSON.stringify(s2Mid)}`,
  );
  assert(
    s2New == null ||
      new Date(s2New.confirmed_until).toISOString() ===
        new Date(T3).toISOString(),
    `D15a: S2's changed row confirms only itself: ${JSON.stringify(s2New)}`,
  );

  // Cutoff capping: with a cutoff before the heartbeat, no post-cutoff
  // confirmation may leak — S1's row confirms only to its own capture.
  const earlyCutoff = await truthRows("2026-11-01T00:30:00Z", "2026-11-01T01:00:00Z");
  const s1Early = earlyCutoff.filter((row) => row.entity_id === S1);
  assert(
    s1Early.length === 1 &&
      new Date(s1Early[0]!.confirmed_until).toISOString() ===
        new Date(T1).toISOString(),
    `D15a: pre-heartbeat cutoff must cap confirmation at ${T1}: ${JSON.stringify(s1Early)}`,
  );

  // ---- (d) manifest-kind-aware verifier membership count ----
  const runs = await sql<{ id: string; manifest_kind: string | null }>`
    SELECT run.id, run.manifest_kind
    FROM meta_entity_observation_runs run
    WHERE run.business_id = ${businessId}
      AND run.provider_account_id = ${providerAccountId}
      AND run.endpoint = ${ENDPOINT}
    ORDER BY run.captured_at
  `;
  assert(runs.length === 2, `D15d: expected full+delta runs: ${JSON.stringify(runs)}`);
  const verifierRows = await sql.query<{
    id: string;
    expected_row_count: number;
    persisted_row_count: number;
  }>(SOURCE_RUNS_SQL, [[runs[0]!.id, runs[1]!.id]]);
  for (const row of verifierRows) {
    assert(
      Number(row.expected_row_count) === 2 &&
        Number(row.persisted_row_count) === 2,
      `D15d: verifier membership must be kind-aware (delta reconstructs 2, not its 1 run-bound row): ${JSON.stringify(verifierRows)}`,
    );
  }

  // ---- (b) + (c): absence is evidence — projection and history ----
  const X = "adset_sweep_exit";
  const Y = "adset_sweep_reenter";
  const H_ENDPOINT = "adset_configs_sweep_history";
  const historyObservation = (input: {
    observedAt: string;
    entities: Array<{ id: string; status: string }>;
  }) => ({
    ...observation({
      observedAt: input.observedAt,
      capturedAt: input.observedAt,
      entities: input.entities,
    }),
    endpoint: H_ENDPOINT,
  });
  const H1 = "2026-11-02T00:00:00Z";
  const H2 = "2026-11-02T06:00:00Z";
  const H3 = "2026-11-02T12:00:00Z";
  await persistMetaEntityObservation(
    historyObservation({
      observedAt: H1,
      entities: [
        { id: X, status: "ACTIVE" },
        { id: Y, status: "ACTIVE" },
      ],
    }),
  );
  // Both exit the scope: two absent_unconfirmed rows.
  await persistMetaEntityObservation(
    historyObservation({ observedAt: H2, entities: [] }),
  );
  // Y re-enters PAUSED (a real change that absence must not mask).
  await persistMetaEntityObservation(
    historyObservation({ observedAt: H3, entities: [{ id: Y, status: "PAUSED" }] }),
  );

  // (b) The workspace projection CASE: an absent winner serves NULL — never
  // DELETED, never the stale ACTIVE.
  const projected = await sql<{ entity_id: string; status: string | null }>`
    SELECT ids.entity_id, (
      SELECT CASE
        WHEN state.presence = 'present' THEN COALESCE(
          state.effective_status, state.configured_status
        )
        ELSE NULL
      END
      FROM meta_entity_state_history state
      WHERE state.business_id = ${businessId}
        AND state.provider_account_id = ${providerAccountId}
        AND state.entity_type = 'adset'
        AND state.entity_id = ids.entity_id
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) AS status
    FROM (VALUES (${X}), (${Y})) AS ids(entity_id)
  `;
  const xStatus = projected.find((row) => row.entity_id === X)?.status;
  const yStatus = projected.find((row) => row.entity_id === Y)?.status;
  assert(
    xStatus === null,
    `D15b: exited entity must project NULL, never DELETED/ACTIVE: ${JSON.stringify(projected)}`,
  );
  assert(
    yStatus === "PAUSED",
    `D15b: re-entered entity must project its present status: ${JSON.stringify(projected)}`,
  );

  // (c) History transitions over present rows only (the exact predicate set
  // the production read model now carries).
  const transitions = await sql<{ entity_id: string; new_status: string | null }>`
    SELECT entity_state.entity_id, entity_state.configured_status AS new_status
    FROM meta_entity_state_history entity_state
    LEFT JOIN LATERAL (
      SELECT prior.configured_status
      FROM meta_entity_state_history prior
      WHERE prior.business_id = entity_state.business_id
        AND prior.provider_account_id = entity_state.provider_account_id
        AND prior.entity_type = entity_state.entity_type
        AND prior.entity_id = entity_state.entity_id
        AND prior.observed_at < entity_state.observed_at
        AND prior.presence = 'present'
      ORDER BY prior.observed_at DESC
      LIMIT 1
    ) entity_previous ON TRUE
    WHERE entity_state.business_id = ${businessId}
      AND entity_state.provider_account_id = ${providerAccountId}
      AND entity_state.entity_type = 'adset'
      AND entity_state.entity_id IN (${X}, ${Y})
      AND entity_state.presence = 'present'
      AND entity_previous.configured_status IS NOT NULL
      AND entity_previous.configured_status IS DISTINCT FROM entity_state.configured_status
  `;
  assert(
    transitions.length === 1 &&
      transitions[0]!.entity_id === Y &&
      transitions[0]!.new_status === "PAUSED",
    `D15c: exactly one transition (Y ACTIVE->PAUSED across absence); scope exits fabricate none: ${JSON.stringify(transitions)}`,
  );

  // ---- D15e (acceptance correction 1, gap B): replay monotonicity ----
  // A later heartbeat advances the delta run's confirmation clock; replaying
  // the run's older exact receipt must not move either heartbeat clock
  // backward nor erase an established window-end confirmation.
  const T4 = "2026-11-01T18:00:00Z";
  const t4Heartbeat = await persistMetaEntityObservation(
    observation({
      observedAt: T4,
      capturedAt: T4,
      entities: [
        { id: S1, status: "ACTIVE" },
        { id: S2, status: "PAUSED" },
      ],
    }),
  );
  assert(
    t4Heartbeat.stateCount === 0,
    `D15e: T4 identical payload should coalesce: ${JSON.stringify(t4Heartbeat)}`,
  );
  const deltaRunClock = async () => {
    const [row] = await sql<{ last_seen_at: string; last_captured_at: string }>`
      SELECT last_seen_at::text AS last_seen_at,
             last_captured_at::text AS last_captured_at
      FROM meta_entity_observation_runs
      WHERE business_id = ${businessId}
        AND provider_account_id = ${providerAccountId}
        AND endpoint = ${ENDPOINT}
        AND manifest_kind = 'delta'
    `;
    assert(row, "D15e: delta run missing.");
    return row;
  };
  const beforeReplay = await deltaRunClock();
  assert(
    new Date(beforeReplay.last_captured_at).toISOString() ===
      new Date(T4).toISOString(),
    `D15e: heartbeat should advance last_captured_at to ${T4}: ${JSON.stringify(beforeReplay)}`,
  );
  const confirmedAfterHeartbeat = await truthRows(
    "2026-11-01T15:00:00Z",
    "2026-11-01T19:00:00Z",
  );
  const s1AfterHeartbeat = confirmedAfterHeartbeat.filter(
    (row) => row.entity_id === S1,
  );
  assert(
    s1AfterHeartbeat.length === 1 &&
      new Date(s1AfterHeartbeat[0]!.confirmed_until).toISOString() ===
        new Date(T4).toISOString(),
    `D15e: S1 should be confirmed through the T4 heartbeat: ${JSON.stringify(s1AfterHeartbeat)}`,
  );
  // Exact replay of the T3 receipt (older clocks) — the coalescing path.
  const replay = await persistMetaEntityObservation(
    observation({
      observedAt: T3,
      capturedAt: T3,
      entities: [
        { id: S1, status: "ACTIVE" },
        { id: S2, status: "PAUSED" },
      ],
    }),
  );
  assert(
    replay.stateCount === 0,
    `D15e: replay must coalesce and write nothing: ${JSON.stringify(replay)}`,
  );
  const afterReplay = await deltaRunClock();
  assert(
    new Date(afterReplay.last_captured_at).toISOString() ===
      new Date(T4).toISOString() &&
      new Date(afterReplay.last_seen_at).toISOString() ===
        new Date(T4).toISOString() &&
      new Date(afterReplay.last_captured_at).getTime() >=
        new Date(afterReplay.last_seen_at).getTime(),
    `D15e: an older exact replay must not move heartbeat clocks backward: ${JSON.stringify(afterReplay)}`,
  );
  const confirmedAfterReplay = await truthRows(
    "2026-11-01T15:00:00Z",
    "2026-11-01T19:00:00Z",
  );
  const s1AfterReplay = confirmedAfterReplay.filter(
    (row) => row.entity_id === S1,
  );
  assert(
    s1AfterReplay.length === 1 &&
      new Date(s1AfterReplay[0]!.confirmed_until).toISOString() ===
        new Date(T4).toISOString(),
    `D15e: replay must not erase the established confirmation: ${JSON.stringify(s1AfterReplay)}`,
  );

  // ---- D15f (acceptance correction 1): equal-captured tie-break ----
  // Two complete-lane rows for one identity with EQUAL captured_at: only the
  // deterministic D075 winner (captured_at DESC, created_at DESC, id DESC)
  // may receive later delta confirmation; the tuple-lesser row must not.
  const TIE_ENDPOINT = "adset_configs_sweep_tie";
  const W = "adset_sweep_tie_entity";
  const TT = "2026-11-03T00:00:00Z";
  const TT_DELTA = "2026-11-03T01:00:00Z";
  const tieRun = async (runHash: string, capturedAt: string, kind: string | null) => {
    const [row] = await sql<IdRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, endpoint, observed_at, captured_at,
        completeness, page_count, row_count, run_hash, manifest_kind
      ) VALUES (
        ${businessId}, ${businessId}, ${binding.ref}, ${providerAccountId},
        'adset', ${TIE_ENDPOINT}, ${capturedAt}::timestamptz,
        ${capturedAt}::timestamptz, 'complete', 1, 1, ${runHash}, ${kind}
      )
      RETURNING id
    `;
    assert(row?.id, `D15f: could not insert run ${runHash.slice(0, 8)}.`);
    return row.id;
  };
  const tieState = async (input: {
    runId: string;
    entityId: string;
    capturedAt: string;
    createdAt: string;
    stateHash: string;
  }) => {
    const [row] = await sql<IdRow>`
      INSERT INTO meta_entity_state_history (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, campaign_id, adset_id,
        learning_source, budget_origin, presence, field_coverage_json,
        configured_status, effective_status, observed_at, captured_at,
        run_completeness, state_hash, created_at
      ) VALUES (
        ${input.runId}, ${businessId}, ${businessId}, ${binding.ref},
        ${providerAccountId}, 'adset', ${input.entityId},
        'campaign_sweep_direct', ${input.entityId},
        'not_observed', 'not_applicable', 'present', '{}'::jsonb,
        'ACTIVE', 'ACTIVE', ${input.capturedAt}::timestamptz,
        ${input.capturedAt}::timestamptz, 'complete', ${input.stateHash},
        ${input.createdAt}::timestamptz
      )
      RETURNING id
    `;
    assert(row?.id, `D15f: could not insert state for ${input.entityId}.`);
    return row.id;
  };
  const tieRunA = await tieRun("a1".repeat(32), TT, null);
  const tieRunB = await tieRun("b2".repeat(32), TT, null);
  const tieLoserId = await tieState({
    runId: tieRunA,
    entityId: W,
    capturedAt: TT,
    createdAt: "2026-11-03T00:00:01Z",
    stateHash: "c3".repeat(32),
  });
  const tieWinnerId = await tieState({
    runId: tieRunB,
    entityId: W,
    capturedAt: TT,
    createdAt: "2026-11-03T00:00:02Z",
    stateHash: "d4".repeat(32),
  });
  await tieRun("e5".repeat(32), TT_DELTA, "delta");
  // Per-row assertion through the EXACT production lateral fragment (the
  // outer query's DISTINCT ON would hide the losing row): only the
  // deterministic D075 winner may receive the delta confirmation.
  const perRowConfirmation = `
    SELECT state.id::text AS id, scope_confirmation.confirmed_until::text AS confirmed_until
    FROM (SELECT $2::timestamptz AS cutoff) target
    CROSS JOIN meta_entity_state_history state
    JOIN meta_entity_observation_runs observation_run
      ON observation_run.id = state.run_id
    LEFT JOIN LATERAL (
${AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL}
    ) scope_confirmation ON TRUE
    WHERE state.id = ANY($1::uuid[])
  `;
  const tieRows = await sql.query<{
    id: string;
    confirmed_until: string | null;
  }>(perRowConfirmation, [[tieLoserId, tieWinnerId], "2026-11-03T02:00:00Z"]);
  const tieWinner = tieRows.find((row) => row.id === tieWinnerId);
  const tieLoser = tieRows.find((row) => row.id === tieLoserId);
  assert(
    tieWinner?.confirmed_until != null &&
      new Date(tieWinner.confirmed_until).toISOString() ===
        new Date(TT_DELTA).toISOString(),
    `D15f: the deterministic winner must be confirmed by the later delta: ${JSON.stringify(tieRows)}`,
  );
  assert(
    tieLoser != null && tieLoser.confirmed_until == null,
    `D15f: the equal-captured tuple-lesser row must NOT receive scope confirmation: ${JSON.stringify(tieRows)}`,
  );

  // ---- D15g (acceptance correction 1): sibling-endpoint isolation ----
  // Supersession and confirmation are ENDPOINT-scoped, matching the D075
  // reconstruction authority: a later sibling-endpoint row for the same
  // identity neither supersedes this endpoint's winner nor receives this
  // endpoint's delta confirmation.
  const E1 = "adset_configs_sweep_e1";
  const E2 = "adset_configs_sweep_e2";
  const Z = "adset_sweep_sibling_entity";
  const U1 = "2026-11-04T00:00:00Z";
  const U2 = "2026-11-04T01:00:00Z";
  const U3 = "2026-11-04T02:00:00Z";
  const siblingRun = async (runHash: string, endpoint: string, capturedAt: string, kind: string | null) => {
    const [row] = await sql<IdRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, endpoint, observed_at, captured_at,
        completeness, page_count, row_count, run_hash, manifest_kind
      ) VALUES (
        ${businessId}, ${businessId}, ${binding.ref}, ${providerAccountId},
        'adset', ${endpoint}, ${capturedAt}::timestamptz,
        ${capturedAt}::timestamptz, 'complete', 1, 1, ${runHash}, ${kind}
      )
      RETURNING id
    `;
    assert(row?.id, `D15g: could not insert run ${runHash.slice(0, 8)}.`);
    return row.id;
  };
  const zE1Run = await siblingRun("11".repeat(32), E1, U1, null);
  const zE2Run = await siblingRun("22".repeat(32), E2, U2, null);
  const zE1Row = await tieState({
    runId: zE1Run,
    entityId: Z,
    capturedAt: U1,
    createdAt: U1,
    stateHash: "33".repeat(32),
  });
  const zE2Row = await tieState({
    runId: zE2Run,
    entityId: Z,
    capturedAt: U2,
    createdAt: U2,
    stateHash: "44".repeat(32),
  });
  await siblingRun("55".repeat(32), E1, U3, "delta");
  const siblingTargets = [
    {
      episode_key: "a".repeat(64),
      business_id: businessId,
      provider_account_ref_id: binding.ref,
      provider_account_id: providerAccountId,
      entity_type: "adset",
      entity_id: Z,
      recommended_at: "2026-11-04T00:00:05Z",
      window_end: "2026-11-04T00:30:00Z",
      cutoff: "2026-11-04T03:00:00Z",
    },
  ];
  const siblingRows = await sql.query<{
    state_history_id: string | null;
    confirmed_until: string;
  }>(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY, [
    JSON.stringify(siblingTargets),
  ]);
  const zE1 = siblingRows.find((row) => row.state_history_id === zE1Row);
  assert(
    zE1 &&
      new Date(zE1.confirmed_until).toISOString() ===
        new Date(U3).toISOString(),
    `D15g: the sibling-endpoint row must not supersede this endpoint's winner (expect E1 confirmation ${U3}): ${JSON.stringify(siblingRows)}`,
  );
  // Cross-confirmation isolation, asserted per row through the exact
  // production fragment: E2 has no delta run, and E1's delta must not leak
  // its confirmation across the endpoint boundary.
  const siblingPerRow = await sql.query<{
    id: string;
    confirmed_until: string | null;
  }>(perRowConfirmation, [[zE1Row, zE2Row], "2026-11-04T03:00:00Z"]);
  const zE1Confirm = siblingPerRow.find((row) => row.id === zE1Row);
  const zE2Confirm = siblingPerRow.find((row) => row.id === zE2Row);
  assert(
    zE1Confirm?.confirmed_until != null &&
      new Date(zE1Confirm.confirmed_until).toISOString() ===
        new Date(U3).toISOString(),
    `D15g: E1's winner takes its own endpoint's delta confirmation: ${JSON.stringify(siblingPerRow)}`,
  );
  assert(
    zE2Confirm != null && zE2Confirm.confirmed_until == null,
    `D15g: the E1 delta must not confirm the sibling-endpoint row: ${JSON.stringify(siblingPerRow)}`,
  );

  // ── D16 (D083 C2): the real round trip ───────────────────────────────────
  // Raw Graph row + client-known API version -> the ACTUAL production mapper ->
  // state hash -> append-only writer -> DB row -> PIT reader -> audit mapper ->
  // canonical builder. Nothing here hand-builds a normalised state or injects a
  // coverage bit; every value under test comes from the code being proven.
  {
    const meta = await import("@/lib/api/meta");
    const { toBudgetObservation } = await import(
      "@/scripts/audits/d083-meta-budget-fact-observation"
    );
    const { buildCanonicalBudgetFact } = await import("@/lib/meta/budget-fact");

    assert(
      meta.deriveMetaBudgetOrigin("campaign", { daily: undefined, lifetime: undefined }) ===
        "not_observed",
      "D16a: absent budget fields must be not_observed, not not_applicable.",
    );
    assert(
      meta.deriveMetaBudgetOrigin("campaign", { daily: "0", lifetime: "0" }) === "not_applicable",
      "D16a: the provider zero sentinel must not make a grain the owner.",
    );
    assert(
      meta.deriveMetaBudgetOrigin("adset", { daily: "30000", lifetime: "0" }) === "adset",
      "D16a: a positive amount must make this grain the owner.",
    );

    const credentials = {
      businessId,
      accountIds: [providerAccountId],
      currency: "KWD",
      accountProfiles: { [providerAccountId]: { currency: "KWD" } },
    } as never;
    const observedAt = "2026-07-14T09:00:00Z";
    const capturedAt = "2026-07-14T09:00:01Z";

    // The raw Graph shapes, exactly as the client requests them.
    const rawCampaign = {
      id: "campaign_d083_c2",
      name: "c2 campaign",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      updated_time: observedAt,
      daily_budget: "0",
      lifetime_budget: "1234567",
      start_time: "2026-07-01T00:00:00+0000",
      stop_time: "2026-07-31T00:00:00+0000",
    };
    const rawAdSet = {
      id: "adset_d083_c2",
      name: "c2 adset",
      campaign_id: "campaign_d083_c2",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      updated_time: observedAt,
      daily_budget: "0",
      lifetime_budget: "0",
    };

    const campaignMapped = meta.mapCampaignObservationState({
      credentials,
      accountId: providerAccountId,
      row: rawCampaign as never,
      responseObservedAt: observedAt,
      capturedAt,
    });
    const adsetMapped = meta.mapAdSetObservationState({
      credentials,
      accountId: providerAccountId,
      row: rawAdSet as never,
      responseObservedAt: observedAt,
      capturedAt,
    });
    assert(
      campaignMapped.state !== null && adsetMapped.state !== null,
      "D16b: the production mapper refused the fixture rows.",
    );
    const campaignState = campaignMapped.state!;
    const adsetState = adsetMapped.state!;

    // The mapper's own derivations, not values the seam supplied.
    assert(
      campaignState.budgetOrigin === "campaign" && adsetState.budgetOrigin === "not_applicable",
      `D16b: owner derivation wrong: ${campaignState.budgetOrigin}/${adsetState.budgetOrigin}`,
    );
    assert(
      campaignState.campaignLifetimeBudgetRaw === "1234567" &&
        campaignState.campaignDailyBudgetRaw === "0",
      "D16b: raw amounts were not carried verbatim by the mapper.",
    );
    assert(
      campaignState.budgetCurrencyExponent === 3 &&
        typeof campaignState.budgetCurrencyRegistryVersion === "string",
      `D16b: the mapper did not stamp the KWD exponent: ${JSON.stringify(campaignState.budgetCurrencyExponent)}`,
    );
    assert(
      campaignState.providerApiVersion === meta.META_GRAPH_API_VERSION,
      "D16b: the mapper did not stamp the client-known API version.",
    );
    const coverage = campaignState.fieldCoverage as Record<string, unknown>;
    assert(
      coverage.campaignStartTime === true &&
        coverage.campaignEndTime === true &&
        coverage.budgetCurrencyExponent === "client_registry" &&
        coverage.providerApiVersion === "client_known",
      `D16b: field coverage does not state presence and source: ${JSON.stringify(coverage)}`,
    );

    const roundTripRun = await persistMetaEntityObservation({
      businessId,
      providerAccountId,
      entityType: "campaign",
      endpoint: "campaign_configs_d083_c2",
      observedAt,
      capturedAt,
      completeness: "complete",
      pageCount: 1,
      providerRowCount: 1,
      // Real source provenance, so the canonical builder's identity gate is
      // exercised rather than tripped by a fixture that omits it.
      sourceSnapshotId: "00000000-0000-4000-8000-0000000d0831",
      payloadHash: "d".repeat(64),
      states: [campaignState],
    });
    await persistMetaEntityObservation({
      businessId,
      providerAccountId,
      entityType: "adset",
      endpoint: "adset_configs_d083_c2",
      observedAt,
      capturedAt,
      completeness: "complete",
      pageCount: 1,
      providerRowCount: 1,
      sourceSnapshotId: "00000000-0000-4000-8000-0000000d0832",
      payloadHash: "e".repeat(64),
      states: [adsetState],
    });
    assert(roundTripRun.runId.length > 0, "D16c: the observation did not persist.");

    const [storedCampaign] = await readMetaEntityStatesAsOf({
      businessId,
      providerAccountId,
      entityType: "campaign",
      entityIds: ["campaign_d083_c2"],
      cutoff: "2026-07-14T10:00:00Z",
    });
    assert(
      storedCampaign?.providerApiVersion === meta.META_GRAPH_API_VERSION &&
        storedCampaign?.budgetCurrencyExponent === 3 &&
        storedCampaign?.campaignStartTime !== null &&
        storedCampaign?.campaignEndTime !== null,
      `D16c: the new fields did not survive writer to reader: ${JSON.stringify(storedCampaign)}`,
    );
    assert(
      typeof storedCampaign?.stateHash === "string" && storedCampaign.stateHash.length === 64,
      "D16c: the state hash is missing.",
    );

    // A second observation differing ONLY in API version must hash differently,
    // which is what binds that field into change detection.
    const rebased = meta.mapCampaignObservationState({
      credentials,
      accountId: providerAccountId,
      row: rawCampaign as never,
      responseObservedAt: observedAt,
      capturedAt,
    }).state!;
    const { buildMetaEntityStateHash } = await import("@/lib/meta/entity-state-history");
    const baseHash = buildMetaEntityStateHash(rebased as never);
    const shiftedHash = buildMetaEntityStateHash({
      ...rebased,
      providerApiVersion: "v99.0",
    } as never);
    assert(
      baseHash !== shiftedHash,
      "D16d: the provider API version is not bound into the state hash.",
    );

    // DB row -> audit mapper -> canonical builder, through the real code.
    const [dbRow] = await sql<Record<string, unknown>>`
      SELECT h.id::text AS observation_id, h.entity_type, h.entity_id, h.campaign_id,
             h.observed_at::text AS observed_at, h.observed_at::date::text AS observed_on,
             h.captured_at::text AS captured_at, h.run_id::text AS run_id,
             h.run_completeness, h.presence, h.configured_status, h.effective_status,
             h.budget_origin, h.budget_currency,
             h.campaign_daily_budget_raw, h.campaign_lifetime_budget_raw,
             h.adset_daily_budget_raw, h.adset_lifetime_budget_raw,
             h.campaign_start_time::text AS campaign_start_time,
             h.campaign_end_time::text AS campaign_end_time,
             h.adset_start_time::text AS adset_start_time,
             h.adset_end_time::text AS adset_end_time,
             h.budget_currency_exponent, h.budget_currency_registry_version,
             h.provider_api_version, h.field_coverage_json, h.state_hash,
             r.source_snapshot_id, r.payload_hash, r.run_hash
        FROM meta_entity_state_history h
        LEFT JOIN meta_entity_observation_runs r ON r.id = h.run_id
       WHERE h.business_id = ${businessId}
         AND h.provider_account_id = ${providerAccountId}
         AND h.entity_id = 'campaign_d083_c2'
       LIMIT 1
    `;
    assert(dbRow !== undefined, "D16e: the persisted row could not be read back.");
    const observation = toBudgetObservation(dbRow, { businessId, providerAccountId });
    assert(observation !== null, "D16e: the audit mapper refused the persisted row.");
    assert(
      observation!.parentCampaignId === null,
      "D16e: a campaign observation must normalise its parent to null.",
    );
    assert(
      observation!.providerApiVersion === meta.META_GRAPH_API_VERSION &&
        observation!.budgetCurrencyExponent === 3 &&
        observation!.startTime !== null &&
        observation!.endTime !== null,
      `D16e: the audit mapper lost a persisted field: ${JSON.stringify(observation)}`,
    );
    assert(
      observation!.statusFieldCoverage.configuredStatus === true &&
        observation!.statusFieldCoverage.effectiveStatus === true,
      "D16e: status presence evidence did not survive the round trip.",
    );

    const fact = buildCanonicalBudgetFact({
      businessId,
      providerAccountId,
      entityGrain: "campaign",
      entityId: "campaign_d083_c2",
      parentCampaignId: null,
      pit: { asOf: "2026-07-16", timeZone: "UTC", requireRecordedByCutoff: true },
      entityObservations: [observation!],
      parentObservations: [],
    });
    // Shape is still unobservable, so the honest terminal state is a refusal
    // naming exactly that gate - not a green intent.
    assert(
      fact.ownerResolved === true &&
        fact.intentReady === false &&
        fact.blockers.includes("budget_shape_not_observed") &&
        fact.blockers.every((b) => b === "budget_shape_not_observed"),
      `D16f: unexpected canonical verdict: ${JSON.stringify({ owner: fact.ownerResolved, intent: fact.intentReady, blockers: fact.blockers })}`,
    );
    assert(
      fact.budgetField === "lifetime" &&
        fact.bindingAmountRaw === "1234567" &&
        fact.schedule.complete === true &&
        fact.ownerProvenance?.payloadHash !== fact.ownerProvenance?.runHash,
      `D16f: the canonical fact lost a value from the real path: ${JSON.stringify(fact)}`,
    );

    // ---- D17: the point-in-time statement returns the EXACT winner set, at
    // every cutoff the seeded clocks can distinguish, on both lanes.
    //
    // Correction 3 shipped a single-pass "frontier" reduction that was wrong in
    // two independent ways. Its seam missed both, because its only same-clock
    // case shared BOTH clocks, so nothing was ever dropped. This seam seeds the
    // shapes that break a reduction, derives the cutoffs from the data instead
    // of hand-picking them, and keeps the rejected reduction as a live control
    // so the regression it guards is demonstrated rather than described.
    {
      const { D083_QUERIES } = await import(
        "@/scripts/audits/d083-meta-budget-fact-observation"
      );
      const { selectObservationAtPitDetailed } = await import("@/lib/meta/budget-fact");

      const entityId = "adset_d083_c4_pit";
      // Every ordering that can break a bi-temporal reduction:
      //   t1/t2/t3  one observed_at, three captures  (Correction 3 defect A)
      //   ancient   effective in 2023, recorded in 2026 (a very late record)
      //   twinA/B   identical observed AND captured   (conflict must survive)
      //   plain     a normal monotone pair
      //   later     a newer row, so the sweep crosses a real boundary
      //
      // Correction 3's reduction also loses the winner when a LATER-effective
      // row was recorded EARLIER. That shape is not seeded because it cannot
      // exist: `meta_entity_state_history_time_check` is
      // `CHECK (captured_at >= observed_at)`, asserted below. Under that
      // invariant the equal-`observed_at` case is the only reachable loss, and
      // that is exactly what these rows exercise.
      const clocks: Array<{ label: string; observed: string; captured: string }> = [
        { label: "ancient", observed: "2023-03-29T00:00:00Z", captured: "2026-02-01T00:00:00Z" },
        { label: "plain", observed: "2025-01-02T00:00:00Z", captured: "2025-01-02T00:30:00Z" },
        { label: "t1", observed: "2026-01-01T00:00:00Z", captured: "2026-01-01T01:00:00Z" },
        { label: "t2", observed: "2026-01-01T00:00:00Z", captured: "2026-01-02T01:00:00Z" },
        { label: "t3", observed: "2026-01-01T00:00:00Z", captured: "2026-01-03T01:00:00Z" },
        { label: "twinA", observed: "2026-03-01T00:00:00Z", captured: "2026-03-01T00:10:00Z" },
        { label: "twinB", observed: "2026-03-01T00:00:00Z", captured: "2026-03-01T00:10:00Z" },
        { label: "later", observed: "2026-04-01T00:00:00Z", captured: "2026-04-01T00:05:00Z" },
      ];

      // The invariant that makes the other loss class unreachable. If this ever
      // stops throwing, a later-effective/earlier-recorded row becomes storable
      // and the completeness argument below must be re-derived.
      let recordedBeforeEffectiveRefused = false;
      try {
        await persistMetaEntityObservation({
          businessId,
          providerAccountId,
          entityType: "adset",
          endpoint: "adset_pit_d083_c4_invariant",
          observedAt: "2026-06-01T00:00:00Z",
          capturedAt: "2026-01-15T00:00:00Z",
          completeness: "complete",
          pageCount: 1,
          providerRowCount: 1,
          sourceSnapshotId: "00000000-0000-4000-8000-00000c084999",
          payloadHash: "9".repeat(64),
          states: [
            {
              ...adsetState,
              entityId: "adset_d083_c4_pit",
              adsetId: "adset_d083_c4_pit",
              observedAt: "2026-06-01T00:00:00Z",
              adsetDailyBudgetRaw: "9999",
            },
          ],
        });
      } catch {
        recordedBeforeEffectiveRefused = true;
      }
      assert(
        recordedBeforeEffectiveRefused,
        "D17-invariant: a row recorded before it was effective was accepted; the unreachability argument no longer holds.",
      );
      const [timeCheck] = await sql.query<Record<string, unknown>>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'meta_entity_state_history'::regclass
            AND conname = 'meta_entity_state_history_time_check'`,
      );
      assert(
        String(timeCheck?.def ?? "").includes("captured_at >= observed_at"),
        `D17-invariant: the bi-temporal CHECK is not what the argument assumes: ${JSON.stringify(timeCheck)}`,
      );
      for (const [index, clock] of clocks.entries()) {
        await persistMetaEntityObservation({
          businessId,
          providerAccountId,
          entityType: "adset",
          endpoint: `adset_pit_d083_c4_${index}`,
          observedAt: clock.observed,
          capturedAt: clock.captured,
          completeness: "complete",
          pageCount: 1,
          providerRowCount: 1,
          sourceSnapshotId: `00000000-0000-4000-8000-00000c084${String(index).padStart(3, "0")}`,
          payloadHash: String(index).repeat(64).slice(0, 64),
          states: [
            {
              ...adsetState,
              entityId,
              adsetId: entityId,
              observedAt: clock.observed,
              // A distinct amount per row, so dropping a candidate changes the
              // answer instead of coinciding with it.
              adsetDailyBudgetRaw: String(1000 + index),
            },
          ],
        });
      }

      // Postgres renders an hours-only offset ("+03") that `Date.parse` refuses.
      const instant = (value: unknown): number => {
        const text = String(value).replace(" ", "T");
        return Date.parse(/[+-]\d{2}$/.test(text) ? `${text}:00` : text);
      };
      const toObservation = (row: Record<string, unknown>) => ({
        businessId,
        providerAccountId,
        entityGrain: "adset" as const,
        entityId: String(row.entity_id),
        parentCampaignId: null,
        observedAtMs: instant(row.observed_at),
        observedOn: String(row.observed_on),
        capturedAtMs: instant(row.captured_at),
        presence: "present" as const,
        runCompleteness: "complete" as const,
        configuredStatus: "ACTIVE",
        effectiveStatus: "ACTIVE",
        budgetOrigin: "adset" as const,
        budgetCurrency: "USD",
        budgetCurrencyExponent: 2,
        budgetCurrencyRegistryVersion: "iso4217.minor-units.2026-09-01",
        campaignDailyRaw: null,
        campaignLifetimeRaw: null,
        adsetDailyRaw: String(row.adset_daily_budget_raw ?? ""),
        adsetLifetimeRaw: "0",
        startTime: null,
        endTime: null,
        shapeSupport: "supported" as const,
        statusFieldCoverage: { configuredStatus: true, effectiveStatus: true },
        observationId: String(row.observation_id),
        sourceRunId: String(row.run_id),
        sourceSnapshotId: String(row.source_snapshot_id ?? "s"),
        payloadHash: String(row.payload_hash ?? "p"),
        runHash: String(row.run_hash ?? "r"),
        stateHash: String(row.state_hash),
        providerApiVersion: "v25.0",
      });

      const historyColumns = `h.id::text AS observation_id, h.entity_id,
                h.observed_at::text AS observed_at,
                h.observed_at::date::text AS observed_on,
                h.captured_at::text AS captured_at,
                h.run_id::text AS run_id, h.state_hash,
                h.adset_daily_budget_raw,
                r.source_snapshot_id, r.payload_hash, r.run_hash`;
      const everything = await sql.query<Record<string, unknown>>(
        `SELECT ${historyColumns}
           FROM meta_entity_state_history h
           LEFT JOIN meta_entity_observation_runs r ON r.id = h.run_id
          WHERE h.business_id = $1 AND h.provider_account_id = $2 AND h.entity_id = $3`,
        [businessId, providerAccountId, entityId],
      );
      assert(
        everything.length === clocks.length,
        `D17a: expected ${clocks.length} seeded rows, saw ${everything.length}`,
      );
      const all = everything.map(toObservation);
      const idByAmount = new Map(
        all.map((o) => [o.adsetDailyRaw, o.observationId] as const),
      );
      const labelOf = (observationId: string | null): string => {
        if (observationId === null) return "none";
        for (const [index, clock] of clocks.entries()) {
          if (idByAmount.get(String(1000 + index)) === observationId) return clock.label;
        }
        return observationId;
      };

      // ---- D17b: the rejected Correction 3 reduction, kept as a live control.
      // It must still drop t2 at a cutoff between t2 and t3. If this ever
      // passes, the counterexample has stopped being a counterexample and the
      // whole proof below needs re-reading.
      const rejectedReduction = `
        WITH scoped AS (
          SELECT ${historyColumns}, h.observed_at AS o, h.captured_at AS c
            FROM meta_entity_state_history h
            LEFT JOIN meta_entity_observation_runs r ON r.id = h.run_id
           WHERE h.business_id = $1 AND h.provider_account_id = $2
             AND h.entity_id = $3 AND h.observed_at < $4::timestamptz
        ),
        frontier AS (
          SELECT scoped.*,
                 RANK() OVER (ORDER BY o DESC, c DESC) AS finalized_rank,
                 MIN(c) OVER (ORDER BY o DESC
                   RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS best_captured
            FROM scoped
        )
        SELECT ${"observation_id"} FROM frontier
         WHERE c = best_captured OR finalized_rank = 1`;
      const betweenT2AndT3 = "2026-01-02T12:00:00Z";
      const rejectedKept = new Set(
        (
          await sql.query<Record<string, unknown>>(rejectedReduction, [
            businessId,
            providerAccountId,
            entityId,
            betweenT2AndT3,
          ])
        ).map((r) => labelOf(String(r.observation_id))),
      );
      assert(
        !rejectedKept.has("t2") && rejectedKept.has("t1") && rejectedKept.has("t3"),
        `D17b: the rejected Correction 3 reduction no longer drops t2; it kept ${JSON.stringify([...rejectedKept])}`,
      );

      // ---- D17c: cutoffs derived from the data, not hand-picked. Every
      // distinct clock instant, one millisecond either side of it, and the
      // midpoint of every adjacent pair - which is what actually separates
      // t1 from t2 from t3.
      const instants = [
        ...new Set(all.flatMap((o) => [o.observedAtMs, o.capturedAtMs])),
      ].sort((a, b) => a - b);
      const cutoffMs = [
        ...new Set(
          instants.flatMap((ms, i) => {
            const next = instants[i + 1];
            return next === undefined ? [ms - 1, ms, ms + 1] : [ms - 1, ms, ms + 1, Math.floor((ms + next) / 2)];
          }),
        ),
      ].sort((a, b) => a - b);

      let comparisons = 0;
      let strictWins = 0;
      let finalizedWins = 0;
      let conflicts = 0;
      const winnersSeen = new Set<string>();
      for (const ms of cutoffMs) {
        const cutoffIso = new Date(ms).toISOString();
        for (const requireRecordedByCutoff of [true, false]) {
          const rows = await sql.query<Record<string, unknown>>(
            D083_QUERIES.budgetObservationPitWinners,
            [businessId, providerAccountId, cutoffIso, "adset", requireRecordedByCutoff],
          );
          const kept = rows
            .filter((r) => String(r.entity_id) === entityId)
            .map(toObservation);
          // The canonical selector is fed the SQL-reduced set and, separately,
          // the entity's entire history. `asOf` is a UTC calendar day here only
          // because the seam controls the clocks directly; the audit's own
          // account-local cutoffs are exercised by the production path.
          const pit = {
            asOf: cutoffIso.slice(0, 10),
            timeZone: "UTC",
            requireRecordedByCutoff,
          };
          // Compare at the exact instant, not the day, by filtering to it.
          const visible = (rowsIn: typeof all) =>
            rowsIn.filter(
              (o) =>
                o.observedAtMs !== null &&
                o.observedAtMs < ms &&
                (!requireRecordedByCutoff || (o.capturedAtMs !== null && o.capturedAtMs <= ms)),
            );
          const pickAt = (rowsIn: typeof all) => {
            const scoped = visible(rowsIn);
            if (scoped.length === 0) return { status: "none" as const, ids: null };
            const selected = selectObservationAtPitDetailed(scoped, {
              ...pit,
              // Every scoped row is already inside the instant bound, so the
              // day-level cutoff must not exclude any of them.
              asOf: new Date(ms + 86_400_000).toISOString().slice(0, 10),
              requireRecordedByCutoff: false,
            });
            return {
              status: selected.status,
              ids:
                selected.status === "selected"
                  ? selected.observation.observationId
                  : selected.status === "conflict"
                    ? selected.observations.map((o) => o.observationId).sort().join(",")
                    : null,
            };
          };
          const overAll = pickAt(all);
          const overKept = pickAt(kept);
          assert(
            overAll.status === overKept.status && overAll.ids === overKept.ids,
            `D17c: the reduced set lost the winner at ${cutoffIso} (strict=${requireRecordedByCutoff}): whole-history=${overAll.status}/${labelOf(overAll.ids)} reduced=${overKept.status}/${labelOf(overKept.ids)}`,
          );
          comparisons += 1;
          if (overAll.status === "conflict") conflicts += 1;
          if (overAll.status !== "none") {
            if (requireRecordedByCutoff) strictWins += 1;
            else finalizedWins += 1;
            if (overAll.ids !== null) {
              for (const id of overAll.ids.split(",")) winnersSeen.add(labelOf(id));
            }
          }
        }
      }

      // ---- D17d: non-vacuity. The sweep must actually have exercised both
      // lanes, produced a conflict, and - decisively - selected t2, the row the
      // rejected reduction deleted.
      assert(
        comparisons >= 40 &&
          strictWins >= 10 &&
          finalizedWins >= 10 &&
          conflicts >= 2 &&
          winnersSeen.has("t2") &&
          winnersSeen.has("later") &&
          winnersSeen.has("ancient"),
        `D17d: the sweep was vacuous: ${JSON.stringify({ comparisons, strictWins, finalizedWins, conflicts, winners: [...winnersSeen].sort() })}`,
      );

      // ---- D17e: the exact-clock twins must reach the selector together, as a
      // conflict, rather than being adjudicated away in SQL.
      const twinCutoff = "2026-03-02T00:00:00Z";
      const twinRows = (
        await sql.query<Record<string, unknown>>(D083_QUERIES.budgetObservationPitWinners, [
          businessId,
          providerAccountId,
          twinCutoff,
          "adset",
          true,
        ])
      )
        .filter((r) => String(r.entity_id) === entityId)
        .map(toObservation);
      const twinPick = selectObservationAtPitDetailed(twinRows, {
        asOf: "2026-03-03",
        timeZone: "UTC",
        requireRecordedByCutoff: true,
      });
      assert(
        twinPick.status === "conflict" && twinPick.observations.length === 2,
        `D17e: the exact-clock pair did not survive as a conflict: ${twinPick.status}`,
      );

      console.log(
        `[entity-state-history-seam] D17 PASS D083 C4 exact point-in-time candidates: the rejected Correction 3 reduction is retained as a live control and still drops t2 at a cutoff between t2 and t3 (kept ${JSON.stringify([...rejectedKept].sort())}); the shipped statement is then run over ${cutoffMs.length} cutoffs derived from the seeded clocks themselves x 2 lanes = ${comparisons} comparisons, and the canonical selector returns the identical verdict over the SQL-reduced set as over the entity's entire history at every one, including ${conflicts} conflicts; the sweep selected t2 - the row the rejected reduction deleted - along with the 2023 row and the newest row, so it is not vacuous; the writer and \`meta_entity_state_history_time_check\` are asserted to refuse a row recorded before it was effective, which is what makes the reduction's other loss class unreachable rather than merely unobserved; and the exact-clock pair reaches the selector as a conflict rather than being adjudicated in SQL.`,
      );
    }

    console.log(
      "[entity-state-history-seam] D16 PASS D083 real round trip: raw Graph rows through the ACTUAL production campaign and ad-set mappers derive owner from explicit zero-sentinel semantics, stamp the KWD exponent, registry version, client-known API version and exact coverage bits; the writer persists them; the API version is bound into the state hash; the point-in-time reader and audit mapper return them intact with the campaign parent normalised to null and payload and run hashes kept apart; and the canonical builder resolves the owner and lifetime amount while refusing intent on exactly budget_shape_not_observed.",
    );
  }

  console.log(
    "[entity-state-history-seam] D15 PASS D075 consumer sweep: an unchanged entity's truth row is confirmed through the run heartbeat and later delta manifests (S1 confirmed to the delta clock; a superseded row stops at its heartbeat; a pre-heartbeat cutoff caps at first capture); the natural-wave verifier counts a delta run's reconstructed members (2/2) instead of its run-bound rows; an absent_unconfirmed winner projects NULL (never DELETED, never the stale present status) while re-entry restores the present status; and history transitions span present rows only — the scope exits fabricate no status-change entries and the re-entry change is not masked. Correction-1 legs: an older exact replay cannot move the heartbeat clocks backward or erase an established confirmation (D15e); an equal-captured tuple-loser never receives scope confirmation while the deterministic winner does (D15f, per-row through the production fragment); and supersession/confirmation stay endpoint-scoped — a sibling endpoint neither supersedes this endpoint's winner nor borrows its delta confirmation (D15g).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // PostgreSQL puts the useful part of an integrity failure in `detail` and
    // the offending statement in `where`; printing only `message` turns a
    // precise constraint violation into a guessing game.
    const pg = error as { detail?: string; constraint?: string; table?: string };
    if (pg?.detail || pg?.constraint) {
      console.error(
        `pg error: constraint=${pg.constraint ?? "?"} table=${pg.table ?? "?"} detail=${pg.detail ?? "?"}`,
      );
    }
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
