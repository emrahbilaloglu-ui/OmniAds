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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
