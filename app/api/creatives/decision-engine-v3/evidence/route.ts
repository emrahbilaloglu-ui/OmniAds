import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import {
  canonicalSha256,
  type CanonicalJsonObject,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import { getDb } from "@/lib/db";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  readMetaNativeCanonicalDecisionInventory,
  type MetaNativeDecisionGeneration,
} from "@/lib/meta/decisions-workspace-read-model";

export const dynamic = "force-dynamic";

const NATIVE_AD_EVIDENCE_CONTRACT_VERSION =
  "decision-engine-v3-native-ad-evidence.v1" as const;

interface NativeDecisionEvidenceDbRow {
  snapshot_id: string;
  evaluation_id: string;
  context_id: string;
  job_run_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  ad_id: string;
  snapshot_decision_entity_type: string;
  snapshot_decision_entity_id: string;
  evaluation_decision_entity_type: string;
  evaluation_decision_entity_id: string;
  snapshot_creative_id: string | null;
  evaluation_creative_id: string | null;
  snapshot_raw_label: string;
  snapshot_published_label: string;
  evaluation_raw_label: string;
  evaluation_hysteresis_suppressed: unknown;
  as_of_date: string;
  engine_version: string;
  scope_type: string;
  scope_id: string;
  snapshot_input_hash: string;
  snapshot_decision_hash: string;
  evaluation_input_hash: string;
  evaluation_decision_hash: string;
  evaluation_contract_version: string;
  evaluation_evaluated_at: string;
  context_contract_version: string;
  context_hash: string;
  context_evaluated_at: string;
  creative_input_json: unknown;
  campaign_context_json: unknown;
  prior_hysteresis_json: unknown;
  decision_output_json: unknown;
  context_json: unknown;
  account_profile_json: unknown;
  data_health_json: unknown;
  flags_json: unknown;
}

export interface NativeAdDecisionEvidenceResponse {
  status: "available";
  contractVersion: typeof NATIVE_AD_EVIDENCE_CONTRACT_VERSION;
  businessId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string | null;
  asOf: string;
  engineVersion: string;
  generation: Readonly<MetaNativeDecisionGeneration>;
  decision: MetaCanonicalDecision;
  lineage: {
    status: "verified";
    providerAccountRefId: string;
    jobRunId: string;
    scope: { type: string; id: string };
    snapshot: {
      id: string;
      inputHash: string;
      decisionHash: string;
    };
    evaluation: {
      id: string;
      contextId: string;
      contractVersion: string;
      inputHash: string;
      decisionHash: string;
      evaluatedAt: string;
    };
    context: {
      id: string;
      contractVersion: string;
      contextHash: string;
      evaluatedAt: string;
    };
  };
  persistedEvidence: {
    creativeInput: unknown;
    campaignContext: unknown;
    priorHysteresis: unknown;
    decisionOutput: unknown;
    evaluationContext: unknown;
    accountProfile: unknown;
    dataHealth: unknown;
    flags: unknown;
  };
  flags: EngineV3Flags;
}

export interface NativeAdDecisionEvidenceDisabledResponse {
  status: "disabled";
  reason: "engine_v3_disabled_for_business";
  flags: EngineV3Flags;
}

export type DecisionEngineV3EvidenceResponse =
  | NativeAdDecisionEvidenceResponse
  | NativeAdDecisionEvidenceDisabledResponse;

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isSha256(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{64}$/.test(value));
}

function canonicalJsonObject(value: unknown): value is CanonicalJsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const PERSISTED_DECISION_LABELS = new Set([
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
]);

function exactIdentityText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : null;
}

function nullableIdentityText(value: unknown): {
  valid: boolean;
  value: string | null;
} {
  if (value === null) return { valid: true, value: null };
  const normalized = exactIdentityText(value);
  return normalized
    ? { valid: true, value: normalized }
    : { valid: false, value: null };
}

function exactCanonicalDecision(input: {
  decision: MetaCanonicalDecision;
  providerAccountId: string;
  adId: string;
  generation: Readonly<MetaNativeDecisionGeneration>;
}): boolean {
  const authority = input.decision.sourceAuthority;
  return Boolean(
    input.decision.providerAccountId === input.providerAccountId &&
      input.decision.identityGrain === "ad" &&
      input.decision.identityResolution?.basis === "native_ad_exact" &&
      input.decision.parentChain.ad?.id === input.adId &&
      authority?.status === "native_exact" &&
      authority.realAdId === input.adId &&
      nonEmpty(authority.snapshotId) &&
      nonEmpty(authority.evaluationId) &&
      authority.providerAccountRefId === input.generation.providerAccountRefId &&
      authority.jobRunId === input.generation.jobRunId &&
      authority.engineVersion === input.decision.sourceDecision.engineVersion &&
      input.decision.sourceDecision.snapshotAsOf ===
        input.generation.asOfDate &&
      isSha256(authority.inputHash) &&
      isSha256(authority.decisionHash),
  );
}

async function readPersistedNativeEvidence(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  decision: MetaCanonicalDecision;
  generation: Readonly<MetaNativeDecisionGeneration>;
}): Promise<NativeDecisionEvidenceDbRow[]> {
  const authority = input.decision.sourceAuthority!;
  return getDb().query<NativeDecisionEvidenceDbRow>(
    `
    SELECT
      snapshot.id::text AS snapshot_id,
      evaluation.id::text AS evaluation_id,
      context.id::text AS context_id,
      snapshot.job_run_id::text AS job_run_id,
      snapshot.provider_account_ref_id::text AS provider_account_ref_id,
      snapshot.provider_account_id,
      snapshot.ad_id,
      snapshot.decision_entity_type AS snapshot_decision_entity_type,
      snapshot.decision_entity_id AS snapshot_decision_entity_id,
      evaluation.decision_entity_type AS evaluation_decision_entity_type,
      evaluation.decision_entity_id AS evaluation_decision_entity_id,
      snapshot.creative_id AS snapshot_creative_id,
      evaluation.creative_id AS evaluation_creative_id,
      snapshot.raw_label AS snapshot_raw_label,
      snapshot.label AS snapshot_published_label,
      evaluation.raw_label AS evaluation_raw_label,
      evaluation.hysteresis_suppressed AS evaluation_hysteresis_suppressed,
      snapshot.as_of_date::text AS as_of_date,
      snapshot.engine_version,
      snapshot.scope_type,
      snapshot.scope_id,
      snapshot.input_hash::text AS snapshot_input_hash,
      snapshot.decision_hash::text AS snapshot_decision_hash,
      evaluation.input_hash::text AS evaluation_input_hash,
      evaluation.decision_hash::text AS evaluation_decision_hash,
      evaluation.contract_version AS evaluation_contract_version,
      evaluation.evaluated_at::text AS evaluation_evaluated_at,
      context.contract_version AS context_contract_version,
      context.context_hash::text AS context_hash,
      context.evaluated_at::text AS context_evaluated_at,
      evaluation.creative_input_json,
      evaluation.campaign_context_json,
      evaluation.prior_hysteresis_json,
      evaluation.decision_output_json,
      context.context_json,
      context.account_profile_json,
      context.data_health_json,
      context.flags_json
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    INNER JOIN engine_v3_ad_decision_evaluations evaluation
      ON evaluation.id = snapshot.evaluation_id
     AND evaluation.business_ref_id = snapshot.business_ref_id
     AND evaluation.business_id = snapshot.business_id
     AND evaluation.provider_account_ref_id = snapshot.provider_account_ref_id
     AND evaluation.provider_account_id = snapshot.provider_account_id
     AND evaluation.decision_entity_type = snapshot.decision_entity_type
     AND evaluation.decision_entity_id = snapshot.decision_entity_id
     AND evaluation.ad_id = snapshot.ad_id
     AND evaluation.creative_id IS NOT DISTINCT FROM snapshot.creative_id
     AND evaluation.as_of_date = snapshot.as_of_date
     AND evaluation.engine_version = snapshot.engine_version
     AND evaluation.scope_type = snapshot.scope_type
     AND evaluation.scope_id = snapshot.scope_id
     AND evaluation.input_hash = snapshot.input_hash
     AND evaluation.decision_hash = snapshot.decision_hash
     AND evaluation.job_run_id = snapshot.job_run_id
    INNER JOIN engine_v3_ad_decision_evaluation_contexts context
      ON context.id = evaluation.context_id
     AND context.business_ref_id = evaluation.business_ref_id
     AND context.business_id = evaluation.business_id
     AND context.provider_account_ref_id = evaluation.provider_account_ref_id
     AND context.provider_account_id = evaluation.provider_account_id
     AND context.as_of_date = evaluation.as_of_date
     AND context.engine_version = evaluation.engine_version
     AND context.scope_type = evaluation.scope_type
     AND context.scope_id = evaluation.scope_id
     AND context.contract_version = evaluation.contract_version
     AND context.job_run_id = evaluation.job_run_id
    WHERE snapshot.business_ref_id = $1::uuid
      AND snapshot.business_id = $1
      AND snapshot.provider_account_id = $2
      AND snapshot.provider_account_ref_id = $3::uuid
      AND snapshot.ad_id = $4
      AND snapshot.decision_entity_type = 'ad'
      AND snapshot.decision_entity_id = $4
      AND snapshot.id = $5::uuid
      AND snapshot.evaluation_id = $6::uuid
      AND snapshot.job_run_id = $7::uuid
      AND snapshot.as_of_date = $8::date
      AND snapshot.engine_version = $9
      AND snapshot.scope_type = 'account'
      AND snapshot.scope_id = $2
      AND snapshot.input_hash = $10
      AND snapshot.decision_hash = $11
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.generation.providerAccountRefId,
      input.adId,
      authority.snapshotId,
      authority.evaluationId,
      input.generation.jobRunId,
      input.generation.asOfDate,
      authority.engineVersion,
      authority.inputHash,
      authority.decisionHash,
    ],
  );
}

function evidenceRowMatches(input: {
  row: NativeDecisionEvidenceDbRow;
  decision: MetaCanonicalDecision;
  generation: Readonly<MetaNativeDecisionGeneration>;
  businessId: string;
  providerAccountId: string;
  adId: string;
}): boolean {
  const authority = input.decision.sourceAuthority!;
  const { row } = input;
  const creativeInput = canonicalJsonObject(row.creative_input_json)
    ? row.creative_input_json
    : null;
  const campaignContext = canonicalJsonObject(row.campaign_context_json)
    ? row.campaign_context_json
    : null;
  const priorHysteresis = canonicalJsonObject(row.prior_hysteresis_json)
    ? row.prior_hysteresis_json
    : null;
  const decisionOutput = canonicalJsonObject(row.decision_output_json)
    ? row.decision_output_json
    : null;
  const contextJson = canonicalJsonObject(row.context_json)
    ? row.context_json
    : null;
  const accountProfile = canonicalJsonObject(row.account_profile_json)
    ? row.account_profile_json
    : null;
  const dataHealth = canonicalJsonObject(row.data_health_json)
    ? row.data_health_json
    : null;
  const persistedFlags = canonicalJsonObject(row.flags_json)
    ? row.flags_json
    : null;
  const snapshotCreative = nullableIdentityText(row.snapshot_creative_id);
  const evaluationCreative = nullableIdentityText(row.evaluation_creative_id);
  if (
    !creativeInput ||
    !campaignContext ||
    !priorHysteresis ||
    !decisionOutput ||
    !contextJson ||
    !accountProfile ||
    !dataHealth ||
    !persistedFlags ||
    !snapshotCreative.valid ||
    !evaluationCreative.valid
  ) {
    return false;
  }
  const creativeInputCreative = nullableIdentityText(creativeInput.creativeId);
  const decisionOutputCreative = nullableIdentityText(decisionOutput.creativeId);
  const optionalInputProviderRef = creativeInput.providerAccountRefId;
  const providerRefValid =
    optionalInputProviderRef === undefined ||
    optionalInputProviderRef === null ||
    optionalInputProviderRef === row.provider_account_ref_id;
  const rawLabel = exactIdentityText(row.evaluation_raw_label);
  const publishedLabel = exactIdentityText(row.snapshot_published_label);
  const contextScope = canonicalJsonObject(contextJson.scope)
    ? contextJson.scope
    : null;
  const profileScope = canonicalJsonObject(accountProfile.scope)
    ? accountProfile.scope
    : null;
  const contextAccountProfile = canonicalJsonObject(contextJson.accountProfile)
    ? contextJson.accountProfile
    : null;
  const contextDataHealth = canonicalJsonObject(contextJson.dataHealth)
    ? contextJson.dataHealth
    : null;
  const contextFlags = canonicalJsonObject(contextJson.flags)
    ? contextJson.flags
    : null;
  if (
    !creativeInputCreative.valid ||
    !decisionOutputCreative.valid ||
    !providerRefValid ||
    !rawLabel ||
    !publishedLabel ||
    !PERSISTED_DECISION_LABELS.has(rawLabel) ||
    !PERSISTED_DECISION_LABELS.has(publishedLabel) ||
    typeof row.evaluation_hysteresis_suppressed !== "boolean" ||
    !contextScope ||
    !profileScope ||
    !contextAccountProfile ||
    !contextDataHealth ||
    !contextFlags
  ) {
    return false;
  }
  const groupingId = snapshotCreative.value;
  const identityValid =
    row.snapshot_decision_entity_type === "ad" &&
    row.evaluation_decision_entity_type === "ad" &&
    row.snapshot_decision_entity_id === input.adId &&
    row.evaluation_decision_entity_id === input.adId &&
    evaluationCreative.value === groupingId &&
    creativeInputCreative.value === groupingId &&
    decisionOutputCreative.value === groupingId &&
    exactIdentityText(creativeInput.businessId) === input.businessId &&
    exactIdentityText(creativeInput.decisionEntityType) === "ad" &&
    exactIdentityText(creativeInput.decisionEntityId) === input.adId &&
    exactIdentityText(creativeInput.adId) === input.adId &&
    exactIdentityText(creativeInput.providerAccountId) ===
      input.providerAccountId &&
    exactIdentityText(decisionOutput.decisionEntityType) === "ad" &&
    exactIdentityText(decisionOutput.decisionEntityId) === input.adId &&
    exactIdentityText(decisionOutput.adId) === input.adId &&
    exactIdentityText(decisionOutput.providerAccountId) ===
      input.providerAccountId &&
    decisionOutput.label === publishedLabel &&
    row.snapshot_raw_label === rawLabel &&
    input.decision.sourceDecision.rawLabel === rawLabel &&
    input.decision.sourceDecision.label === publishedLabel &&
    (input.decision.parentChain.creative?.id ?? null) === groupingId;
  const contextValid =
    contextJson.contractVersion === row.context_contract_version &&
    contextJson.envelopeType === "context" &&
    contextJson.engineVersion === row.engine_version &&
    contextScope.type === "account" &&
    contextScope.id === input.providerAccountId &&
    profileScope.type === "account" &&
    profileScope.id === input.providerAccountId &&
    canonicalSha256(contextScope) === canonicalSha256(profileScope) &&
    canonicalSha256(contextAccountProfile) === canonicalSha256(accountProfile) &&
    canonicalSha256(contextDataHealth) === canonicalSha256(dataHealth) &&
    canonicalSha256(contextFlags) === canonicalSha256(persistedFlags) &&
    canonicalSha256(contextJson) === row.context_hash;
  const recomputedInputHash = canonicalSha256({
    contractVersion: row.evaluation_contract_version,
    envelopeType: "input",
    engineVersion: row.engine_version,
    contextHash: row.context_hash,
    creativeInput,
    campaignContext,
    priorHysteresis,
    decisionIdentity: {
      decisionEntityType: "ad",
      decisionEntityId: input.adId,
      adId: input.adId,
      providerAccountId: input.providerAccountId,
      providerAccountRefId: row.provider_account_ref_id,
      creativeGroupingId: groupingId,
    },
  });
  const recomputedDecisionHash = canonicalSha256({
    contractVersion: row.evaluation_contract_version,
    envelopeType: "decision",
    engineVersion: row.engine_version,
    inputHash: row.evaluation_input_hash,
    decision: decisionOutput,
    rawLabel,
    publishedLabel,
    hysteresisSuppressed: row.evaluation_hysteresis_suppressed,
  });
  return Boolean(
    row.snapshot_id === authority.snapshotId &&
      row.evaluation_id === authority.evaluationId &&
      nonEmpty(row.context_id) &&
      row.job_run_id === input.generation.jobRunId &&
      row.provider_account_ref_id === input.generation.providerAccountRefId &&
      row.provider_account_id === input.providerAccountId &&
      row.ad_id === input.adId &&
      row.as_of_date === input.generation.asOfDate &&
      row.engine_version === authority.engineVersion &&
      row.scope_type === "account" &&
      row.scope_id === input.providerAccountId &&
      row.snapshot_input_hash === authority.inputHash &&
      row.evaluation_input_hash === authority.inputHash &&
      row.snapshot_decision_hash === authority.decisionHash &&
      row.evaluation_decision_hash === authority.decisionHash &&
      isSha256(row.context_hash) &&
      nonEmpty(row.evaluation_contract_version) &&
      nonEmpty(row.context_contract_version) &&
      row.evaluation_contract_version === row.context_contract_version &&
      identityValid &&
      contextValid &&
      recomputedInputHash === row.evaluation_input_hash &&
      recomputedDecisionHash === row.evaluation_decision_hash,
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = nonEmpty(url.searchParams.get("businessId"));
  const providerAccountId = nonEmpty(
    url.searchParams.get("providerAccountId"),
  );
  const adId = nonEmpty(url.searchParams.get("adId"));
  const asOf = nonEmpty(url.searchParams.get("asOf")) ?? undefined;

  if (!businessId) {
    return NextResponse.json({ error: "businessId required" }, { status: 400 });
  }
  if (!providerAccountId) {
    return NextResponse.json(
      { error: "providerAccountId required" },
      { status: 400 },
    );
  }
  if (!adId) {
    return NextResponse.json({ error: "adId required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const resolvedBusinessId = access.membership.businessId;

  const flags = await resolveEngineV3Flags(resolvedBusinessId);
  if (!flags.enabled) {
    return NextResponse.json(
      {
        status: "disabled",
        reason: "engine_v3_disabled_for_business",
        flags: { ...flags },
      } satisfies NativeAdDecisionEvidenceDisabledResponse,
      { status: 200 },
    );
  }

  const inventory = await readMetaNativeCanonicalDecisionInventory({
    businessId: resolvedBusinessId,
    providerAccountId,
    asOfDate: asOf,
  });
  if (inventory.status === "unavailable") {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: inventory.unavailableReason,
        businessId: resolvedBusinessId,
        providerAccountId,
        adId,
      },
      { status: 409 },
    );
  }

  const matches = inventory.items.filter(
    (decision) => decision.parentChain.ad?.id === adId,
  );
  if (matches.length === 0) {
    return NextResponse.json(
      { error: "native exact Ad decision not found" },
      { status: 404 },
    );
  }
  if (
    matches.length !== 1 ||
    !exactCanonicalDecision({
      decision: matches[0]!,
      providerAccountId,
      adId,
      generation: inventory.generation,
    })
  ) {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "native_exact_ad_identity_or_lineage_invalid",
        businessId: resolvedBusinessId,
        providerAccountId,
        adId,
      },
      { status: 409 },
    );
  }
  const decision = matches[0]!;

  let rows: NativeDecisionEvidenceDbRow[];
  try {
    rows = await readPersistedNativeEvidence({
      businessId: resolvedBusinessId,
      providerAccountId,
      adId,
      decision,
      generation: inventory.generation,
    });
  } catch {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "native_persisted_evidence_read_failed",
        businessId: resolvedBusinessId,
        providerAccountId,
        adId,
      },
      { status: 409 },
    );
  }
  if (rows.length !== 1) {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "native_persisted_evidence_cardinality_invalid",
        businessId: resolvedBusinessId,
        providerAccountId,
        adId,
      },
      { status: 409 },
    );
  }
  const row = rows[0]!;
  if (
    !evidenceRowMatches({
      row,
      decision,
      generation: inventory.generation,
      businessId: resolvedBusinessId,
      providerAccountId,
      adId,
    })
  ) {
    return NextResponse.json(
      {
        status: "unavailable",
        reason: "native_persisted_evidence_lineage_invalid",
        businessId: resolvedBusinessId,
        providerAccountId,
        adId,
      },
      { status: 409 },
    );
  }

  const response: NativeAdDecisionEvidenceResponse = {
    status: "available",
    contractVersion: NATIVE_AD_EVIDENCE_CONTRACT_VERSION,
    businessId: resolvedBusinessId,
    providerAccountId,
    adId,
    creativeId: row.snapshot_creative_id,
    asOf: inventory.generation.asOfDate,
    engineVersion: decision.sourceDecision.engineVersion,
    generation: inventory.generation,
    decision,
    lineage: {
      status: "verified",
      providerAccountRefId: row.provider_account_ref_id,
      jobRunId: row.job_run_id,
      scope: { type: row.scope_type, id: row.scope_id },
      snapshot: {
        id: row.snapshot_id,
        inputHash: row.snapshot_input_hash,
        decisionHash: row.snapshot_decision_hash,
      },
      evaluation: {
        id: row.evaluation_id,
        contextId: row.context_id,
        contractVersion: row.evaluation_contract_version,
        inputHash: row.evaluation_input_hash,
        decisionHash: row.evaluation_decision_hash,
        evaluatedAt: row.evaluation_evaluated_at,
      },
      context: {
        id: row.context_id,
        contractVersion: row.context_contract_version,
        contextHash: row.context_hash,
        evaluatedAt: row.context_evaluated_at,
      },
    },
    persistedEvidence: {
      creativeInput: row.creative_input_json,
      campaignContext: row.campaign_context_json,
      priorHysteresis: row.prior_hysteresis_json,
      decisionOutput: row.decision_output_json,
      evaluationContext: row.context_json,
      accountProfile: row.account_profile_json,
      dataHealth: row.data_health_json,
      flags: row.flags_json,
    },
    flags,
  };
  return NextResponse.json(response);
}
