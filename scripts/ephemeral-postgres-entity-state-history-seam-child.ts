import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  readMetaCampaignLabelsAsOf,
  writeMetaCampaignLabels,
} from "@/lib/meta/campaign-labels";
import {
  buildMetaEntityStateHash,
  buildMetaObservationRunHash,
  persistMetaEntityObservation,
  readMetaCreativeLineageAsOf,
  readMetaEntityStatesAsOf,
  readMetaEntityTruthAsOf,
  type MetaObservationCompleteness,
} from "@/lib/meta/entity-state-history";

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

  const created = await writeMetaCampaignLabels({
    businessId,
    labeledBy: owner.id,
    labels: [
      {
        campaignId: "campaign_label_seam",
        kind: "main",
        providerAccountId,
        campaignName: "Main campaign",
      },
    ],
  });
  assert(created.length === 1, "Campaign label create did not return one row.");

  const noOp = await writeMetaCampaignLabels({
    businessId,
    labeledBy: "different-actor",
    labels: [
      {
        campaignId: "campaign_label_seam",
        kind: "main",
        providerAccountId,
        campaignName: "Main campaign",
      },
    ],
  });
  assert(
    noOp[0]?.updatedAt === created[0]?.updatedAt,
    "No-op changed updated_at.",
  );

  const [historyAfterNoOp] = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM meta_campaign_label_history
    WHERE business_id = ${businessId}
      AND campaign_id = 'campaign_label_seam'
  `;
  assert(
    historyAfterNoOp?.count === "1",
    "No-op duplicated campaign label history.",
  );

  await writeMetaCampaignLabels({
    businessId,
    labeledBy: owner.id,
    labels: [
      {
        campaignId: "campaign_label_seam",
        kind: "test",
        testDimension: "creative",
        source: "bulk_apply_confirmed",
        providerAccountId,
        campaignName: "Creative test",
      },
    ],
  });
  const historyRows = await sql<{
    change_kind: string;
    campaign_kind: string;
    previous_campaign_kind: string | null;
  }>`
    SELECT change_kind, campaign_kind, previous_campaign_kind
    FROM meta_campaign_label_history
    WHERE business_id = ${businessId}
      AND campaign_id = 'campaign_label_seam'
    ORDER BY observed_at, id
  `;
  assert(
    historyRows.length === 2,
    "Campaign label update did not append one history row.",
  );
  assert(
    historyRows[0]?.change_kind === "created" &&
      historyRows[1]?.change_kind === "updated" &&
      historyRows[1]?.previous_campaign_kind === "main" &&
      historyRows[1]?.campaign_kind === "test",
    `Campaign label history did not preserve the prior state: ${JSON.stringify(historyRows)}`,
  );
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
    `[entity-state-history-seam] H1-H7 PASS semantic heartbeat: 10 identical observations at 10 different clocks, a same-clock replay and 8 concurrent writers all collapse to ONE run and ONE state row with repeat_count ${afterRepeats.repeats}; A->B->A appends 3; complete->partial appends, repeated partial coalesces inside its shorter cadence and checkpoints past it; a failure appends immediately; and a duplicate primary key still raises 23505`,
  );

  await verifyRelationshipOnlyLineage(context);
  await verifyConfigHistoryTransitions(context);
  await verifyLegacyLineageCollapse(context);
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
