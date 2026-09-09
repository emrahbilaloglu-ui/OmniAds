/**
 * D088 C3 — a projected budget row, executed through the ACTUAL manual route.
 *
 * The row this file approves is the one `budget-production-path.c3.test.ts`
 * projects: same envelope builder, same decision hash, same lineage. Nothing
 * between the HTTP boundary and the Meta POST is stubbed — the real route, the
 * real `executeMetaAutomationProposal`, the real server runtime and readers,
 * the real shared lifecycle, the real D085 composition and the real D087
 * adapter all run. The mocks are the low-level boundaries only: access, the
 * proposal store, the database, the credential context and `fetch`.
 *
 * What it proves:
 *  - automatic execution OFF plus an explicit operator confirmation is a valid
 *    authorization: one preflight GET, one POST, one independent read-back;
 *  - the dispatch marker is written once, immediately before that POST;
 *  - a missing confirmation, a marker that cannot be taken, and an unknown
 *    provider outcome each produce the right number of POSTs — one, zero, one —
 *    and the right settlement.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_DECISION_PROFILE_CONTRACT }
  from "@/lib/creative-decision-engine/account-decision-profile";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { D086_RETENTION_CONTRACT } from "@/lib/meta/budget-readiness-retention";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV }
  from "@/lib/creative-decision-engine/campaign-context/source";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION }
  from "@/lib/creative-decision-engine/campaign-context/resolver";
import { DEFAULT_META_AUTOMATION_GUARDRAILS } from "@/lib/meta/automation-control-plane";
import { MANUAL_CONFIRMATION } from "@/lib/zero-base/meta/dispatch-contract";

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_123";
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM = "77777777-7777-4777-8777-777777777777";
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const INPUT_FP = "a1".repeat(32);
const SOURCE_FP = "b2".repeat(32);

const CBO = {
  grain: "campaign" as const, entityId: "23851234567890123",
  parentCampaignId: null as string | null, current: 250_000, intended: 300_000,
};
const OTHER_CBO_ID = "23850000000000001";
const ABO_PARENT_ID = "23850000000000002";
const OTHER_ABO_ID = "23850000000000003";
const CAMPAIGN_RUN = "44444444-4444-4444-8444-444444444444";
const ADSET_RUN = "55555555-5555-4555-8555-555555555555";
const COHORT = "88888888-8888-4888-8888-888888888888";

/* --------------------------- low-level mocks --------------------------- */

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => [ACCOUNT]),
}));
vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(async () => null),
  // The shared posture every write family now reads. Unblocked and NOT
  // rehearsing: these suites assert on real provider calls, and a rehearsing
  // posture would turn every one of them into a dry run.
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
  metaWriteBlockedResponse: vi.fn((posture: { reason: string | null; message: string | null }) =>
    // The real refusal envelope, so a caller reading `error.code` sees what the
    // shipped helper actually answers with.
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "kill_switch_engaged",
          message: posture?.message ?? "Meta writes are disabled by kill switch.",
          reason: posture?.reason ?? null,
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )),
  metaWriteIsRehearsal: (input: { posture: { rehearsal: boolean }; requestedDryRun: boolean }) =>
    input.posture.rehearsal || input.requestedDryRun === true,
}));
vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));
vi.mock("../demo-write-authority", () => ({
  rejectIfAutomationDemoWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/meta/automation-reconciliation", () => ({
  appendMetaAutomationReconciliationReceipt: vi.fn(async () => ({
    status: "recorded" as const, id: "reconciliation_1",
  })),
}));
vi.mock("@/lib/meta/automation-control-plane", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMetaAutomationControlPlane: vi.fn(),
    getMetaWriteBlockState: vi.fn(async () => ({ blocked: false, reason: null, message: null, rehearsal: false })),
    readEffectiveMetaWriteGovernance: vi.fn(async () => ({
      verified: true, writeBlocked: false, killSwitchEngaged: false, blockReason: null,
    })),
    writeActivityLedgerRow: vi.fn(async () => undefined),
    /*
      The standing modes the sweep now reads before it claims anything.

      The sweep used to hard-code `budget`, so it never asked. It asks now, and
      a business with no family on `auto` is skipped without touching the
      queue — which is the right behaviour and would make every case here
      vacuous. These are the modes this suite's business has armed.
    */
    resolveEffectiveMetaModes: vi.fn(async () => ({
      pause: "auto", bid: "auto", budget: "auto", creative: "manual",
    })),
  };
});
vi.mock("@/lib/meta/automation-proposals", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readMetaAutomationProposal: vi.fn(),
    readMetaAutomationProposalQueue: vi.fn(async () => ({
      proposals: [], readCompleteness: { proposals: "complete" as const },
    })),
    claimMetaAutomationProposal: vi.fn(),
    claimScheduledMetaAutomationProposal: vi.fn(),
    markMetaAutomationProposalDispatchStarted: vi.fn(),
    settleMetaAutomationProposal: vi.fn(),
    forceMetaAutomationProposalReconcile: vi.fn(async () => true),
    countMetaAutomationProposalHolds: vi.fn(async () => 0),
  };
});
vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMetaAccountContext: vi.fn(async () => ({
      connected: true,
      accessToken: "secret-token", connectionGeneration: "1:connected",
      // PR #272 review: a real ad-account profile carries its currency, and
      // a budget write context refuses to exist without one.
      accountProfiles: { [ACCOUNT]: { id: ACCOUNT, currency: "TRY" } },
    })),
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized", errorMessage: null,
    })),
  };
});
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })) };
});

/* --------------------------- the database ------------------------------ */

const journalRows: Array<Record<string, unknown>> = [];

const observationRow = (role: "subject") => ({
  grain: CBO.grain, business_id: BIZ, provider_account_id: ACCOUNT,
  entity_id: CBO.entityId, campaign_id: CBO.entityId,
  presence: "present", run_completeness: "complete",
  configured_status: "ACTIVE", effective_status: "ACTIVE",
  budget_origin: "campaign", budget_currency: "TRY",
  budget_currency_exponent: 2,
  budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
  budget_shape_support: "supported",
  campaign_daily_budget_raw: String(CBO.current),
  campaign_lifetime_budget_raw: null,
  adset_daily_budget_raw: null, adset_lifetime_budget_raw: null,
  campaign_start_time: null, campaign_end_time: null,
  adset_start_time: null, adset_end_time: null,
  optimization_goal: null,
  provider_api_version: "v22.0", state_hash: "e".repeat(64),
  observation_id: `obs-${role}`,
  field_coverage_json: { configuredStatus: true, effectiveStatus: true },
  provider_updated_at: "2026-08-30T02:00:00.000Z",
  observed_on: "2026-08-30", observed_at: "2026-08-30T03:00:00.000Z",
  captured_at: "2026-08-30T03:00:00.000Z", created_at: "2026-08-30T03:00:05.000Z",
  id: "state-1", run_id: CAMPAIGN_RUN,
  source_snapshot_id: "55555555-5555-4555-8555-555555555555",
  payload_hash: "b".repeat(64), run_hash: "c".repeat(64),
  distinct_truths: 1, population_total: 4,
});

const accountObservation = (input: {
  grain: "campaign" | "adset";
  entityId: string;
  campaignId: string;
  amountMinor: number | null;
}) => ({
  ...observationRow("subject"),
  grain: input.grain,
  entity_id: input.entityId,
  campaign_id: input.campaignId,
  budget_origin: input.amountMinor === null
    ? "not_applicable" : input.grain === "campaign" ? "campaign" : "adset",
  campaign_daily_budget_raw:
    input.grain === "campaign" && input.amountMinor !== null
      ? String(input.amountMinor) : null,
  adset_daily_budget_raw:
    input.grain === "adset" && input.amountMinor !== null
      ? String(input.amountMinor) : null,
  run_id: input.grain === "campaign" ? CAMPAIGN_RUN : ADSET_RUN,
  source_snapshot_id: input.grain === "campaign"
    ? "campaign-snapshot" : "adset-snapshot",
  observation_id: `obs-${input.entityId}`,
  id: `state-${input.entityId}`,
  state_hash: input.entityId.padEnd(64, "a").slice(0, 64),
});

const completeRunRows = [
  {
    entity_type: "campaign", run_id: CAMPAIGN_RUN,
    endpoint: "campaign_configs", run_endpoint: "campaign_configs",
    completeness: "complete", capture_status: "complete", manifest_kind: "full",
    row_count: 3, provider_row_count: 3, persisted_members: 3,
    tombstoned_members: 0, run_reused: false, run_succeeded: true,
    source_snapshot_id: "campaign-snapshot", partition_id: COHORT,
    partition_present: true, partition_scope_ok: true, partition_lane_ok: true,
    snapshot_present: true, snapshot_partition_ok: true,
    snapshot_endpoint_ok: true, snapshot_occurrence_ok: true,
    member_run_ids: [CAMPAIGN_RUN],
    captured_at: "2026-08-30T03:00:00.000Z",
    receipt_captured_at: "2026-08-30T03:00:00.000Z",
    tied_at_clock: 1, tied_distinct_truths: 1,
    member_ids: [CBO.entityId, OTHER_CBO_ID, ABO_PARENT_ID].sort(),
  },
  {
    entity_type: "adset", run_id: ADSET_RUN,
    endpoint: "adset_configs", run_endpoint: "adset_configs",
    completeness: "complete", capture_status: "complete", manifest_kind: "full",
    row_count: 1, provider_row_count: 1, persisted_members: 1,
    tombstoned_members: 0, run_reused: false, run_succeeded: true,
    source_snapshot_id: "adset-snapshot", partition_id: COHORT,
    partition_present: true, partition_scope_ok: true, partition_lane_ok: true,
    snapshot_present: true, snapshot_partition_ok: true,
    snapshot_endpoint_ok: true, snapshot_occurrence_ok: true,
    member_run_ids: [ADSET_RUN],
    captured_at: "2026-08-30T03:00:00.000Z",
    receipt_captured_at: "2026-08-30T03:00:00.000Z",
    tied_at_clock: 1, tied_distinct_truths: 1,
    member_ids: [OTHER_ABO_ID],
  },
];

const presentIdentities = [
  `campaign:${CBO.entityId}`,
  `campaign:${OTHER_CBO_ID}`,
  `campaign:${ABO_PARENT_ID}`,
  `adset:${OTHER_ABO_ID}`,
].sort();

const profileRow = (action: string) => ({
  contract: D086_RETENTION_CONTRACT,
  profile_contract: ACCOUNT_DECISION_PROFILE_CONTRACT,
  business_id: BIZ, provider_account_id: ACCOUNT, action,
  engine_epoch: ENGINE_VERSION, engine_version: ENGINE_VERSION,
  input_fingerprint: INPUT_FP, source_fingerprint: SOURCE_FP,
  eligible: true, blocker_code: null,
  as_of_date: "2026-08-31",
  effective_at: "2026-08-31T06:00:00.000Z",
  recorded_at: "2026-08-31T06:00:00.000Z",
  tied_rows: 1, distinct_truths: 1, population_total: 2,
});

const baseQuery = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
  const text = String(sql);
  if (text.includes("account_timezone")) return [{ account_timezone: "Europe/Istanbul" }];
  if (text.includes("FROM engine_v3_account_profile_output")) {
    return [profileRow("scale"), profileRow("cut")];
  }
  if (text.includes("FROM engine_v3_campaign_role_authority")) {
    return [{
      business_id: BIZ, campaign_id: CBO.entityId,
      provider_account_id: ACCOUNT, as_of_date: "2026-08-30",
      inferred_kind: "main", kind_source: "system_inferred",
      confidence_class: "high", resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    }];
  }
  if (text.includes("FROM meta_entity_observation_receipts")) {
    return completeRunRows;
  }
  if (text.includes("FROM owners")) {
    return [{
      owner_rows: 3, unpriced_rows: 0,
      total_minor: "1000000", subject_minor: String(CBO.current),
      max_other_minor: "500000",
      unknown_origin_rows: 0, present_identities: presentIdentities,
    }];
  }
  if (text.includes("FROM meta_budget_write_journal")
    && text.includes("last_change_ms")) {
    return [{ last_change_ms: null, in_7d: 0 }];
  }
  if (text.includes("auto_execution_enabled_by")
    && text.includes("FROM meta_automation_business_controls controls")) {
    activationReadCount += 1;
    const changed = activationChangesAfterRead !== null
      && activationReadCount > activationChangesAfterRead;
    return [{
      auto_execution_provider_account_id: activatedAccount,
      enabling_actor_user_id: changed ? replacementActivationActor : activationActor,
      activation_control_version: changed
        ? replacementActivationVersion : activationControlVersion,
    }];
  }
  if (text.includes("SELECT * FROM meta_budget_write_journal")) {
    const key = text.includes("idempotency_key") ? String(params[2]) : null;
    return journalRows.filter((row) => key === null
      ? row.id === String(params[0]) : row.idempotency_key === key);
  }
  if (text.includes("INSERT INTO meta_budget_write_journal")) {
    const row = {
      id: params[0], contract: params[1], proposal_id: params[2],
      idempotency_key: params[3], request_fingerprint: params[4],
      business_id: params[5], provider_account_id: params[6],
      owner_grain: params[7], entity_id: params[8], parent_campaign_id: params[9],
      budget_field: params[10], currency: params[11], currency_exponent: params[12],
      actor_user_id: params[13], before_amount_minor: params[14],
      intended_amount_minor: params[15], readback_amount_minor: params[16],
      provider_attempted: params[17], provider_http_status: params[18],
      result_class: params[19], blockers_json: JSON.parse(String(params[20])),
      rollback_eligible: params[21],
      requested_at: new Date(Number(params[22])).toISOString(),
      completed_at: params[23] === null
        ? null : new Date(Number(params[23])).toISOString(),
      rolled_back_at: null,
    };
    if (journalRows.some((r) => r.idempotency_key === row.idempotency_key)) {
      throw new Error("duplicate key value violates unique constraint");
    }
    journalRows.push(row);
    return [row];
  }
  if (text.includes("UPDATE meta_budget_write_journal")) {
    const row = journalRows.find((r) => r.id === String(params[0]));
    if (!row) throw new Error("journal complete matched no row");
    const set = <T,>(key: string, value: T) => {
      if (value !== null && value !== undefined) row[key] = value;
    };
    set("provider_attempted", params[1]);
    set("provider_http_status", params[2]);
    set("result_class", params[3]);
    set("readback_amount_minor", params[4]);
    set("before_amount_minor", params[5]);
    if (params[6] !== null) row.blockers_json = JSON.parse(String(params[6]));
    set("rollback_eligible", params[7]);
    if (params[9] !== null) {
      row.completed_at = new Date(Number(params[9])).toISOString();
    }
    return [row];
  }
  if (text.includes("FROM meta_automation_business_controls")
    && text.includes("auto_execution_enabled = TRUE")) {
    /*
      PR #272 review: the persisted control row carries the single bound
      account, and the sweep is required to refuse a null one. `boundAccount`
      is deliberately separate from `activatedAccount`: the first is what the
      QUEUE was selected against, the second what the FRESH gate says now, and
      the whole point of the second check is that they can differ.
    */
    return boundAccount === null
      ? []
      : [{ business_id: BIZ, provider_account_id: boundAccount }];
  }
  if (text.includes("FROM meta_automation_proposals")
    && text.includes("receipt_json->>'executionKind'")) {
    return [{ used: scheduledUsed }];
  }
  if (text.includes("UPDATE meta_automation_proposals")
    && text.includes("claimed_at <= $3::timestamptz")) {
    if (!staleSweepAvailable) {
      throw Object.assign(new Error("dispatch_started_at is absent"), { code: "42703" });
    }
    if (staleSweepRows.some((row) => row.next_status === "pending")) {
      scheduledUsed = 0;
    }
    return staleSweepRows;
  }
  if (text.includes("FROM meta_automation_proposals")
    && text.includes("proposed_action = ANY($4::text[])")) {
    /*
      The queue page, with the real predicate applied: business, THEN the exact
      account, THEN the armed action families, then order, then limit. Filtering
      here is what makes a starvation case meaningful — a mock that ignored the
      account parameter would report the fix working whether or not the SQL
      actually had one.

      The action filter used to be the literal `budget`. It is now the list the
      sweep builds from the standing modes, so the mock applies that list: a row
      for a family this business did not arm must not come back, or the test
      would prove the query returns rows rather than that it selects them.
    */
    const armed = new Set((params[3] as string[]) ?? []);
    const byAction = pendingRows.filter((row) =>
      armed.has(row.proposed_action ?? "budget"));
    const scoped = text.includes("provider_account_id = $2")
      ? byAction.filter((row) => row.provider_account_id === String(params[1]))
      : byAction;
    const ordered = text.includes("ORDER BY provider_account_id")
      ? [...scoped].sort((a, b) =>
        a.provider_account_id.localeCompare(b.provider_account_id)
        || a.created_at.localeCompare(b.created_at))
      : [...scoped].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const limit = text.includes("LIMIT $3") ? Number(params[2]) : 100;
    return ordered.slice(0, limit).map((row) => ({
      id: row.id, provider_account_id: row.provider_account_id,
    }));
  }
  if (text.includes("FROM meta_entity_state_history")) {
    return [
      observationRow("subject"),
      accountObservation({
        grain: "campaign", entityId: OTHER_CBO_ID,
        campaignId: OTHER_CBO_ID, amountMinor: 250_000,
      }),
      accountObservation({
        grain: "campaign", entityId: ABO_PARENT_ID,
        campaignId: ABO_PARENT_ID, amountMinor: null,
      }),
      accountObservation({
        grain: "adset", entityId: OTHER_ABO_ID,
        campaignId: ABO_PARENT_ID, amountMinor: 500_000,
      }),
    ];
  }
  throw new Error(`unmocked query: ${text.slice(0, 120)}`);
};

const query = vi.fn(baseQuery);

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
  runDbTransaction: (run: () => Promise<unknown>) => run(),
}));

let activatedAccount: string | null = null;
/** Dedicated activation provenance; unrelated control edits never replace it. */
let activationActor: string | null = ADMIN;
let activationControlVersion = "2026-08-31T11:55:00.000Z";
let activationReadCount = 0;
let activationChangesAfterRead: number | null = null;
let replacementActivationActor = "55555555-5555-4555-8555-555555555555";
let replacementActivationVersion = "2026-08-31T11:59:00.000Z";
/** The single account the persisted control row binds automatic execution to. */
let boundAccount: string | null = ACCOUNT;
/** The pending budget queue, as rows the real predicate can be applied to. */
let pendingRows: Array<{
  id: string;
  provider_account_id: string;
  created_at: string;
  /** Omitted means a budget row: the action every case here is about. */
  proposed_action?: string;
}> = [];
let scheduledUsed = 0;
let staleSweepAvailable = true;
let staleSweepRows: Array<{ next_status: "pending" | "expired" | "reconcile" }> = [];

const access = await import("@/lib/access");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const store = await import("@/lib/meta/automation-proposals");
const { buildBudgetProposalEnvelope, canonicalDecisionHash, BUDGET_PROPOSAL_ACTION } =
  await import("@/lib/meta/budget-proposal-runtime");
const { POST } = await import("./route");
const { runMetaBudgetAutomationSweepIfDue } =
  await import("@/lib/meta/budget-automation-scheduled");
const schemaReadiness = await import("@/lib/db-schema-readiness");

type MetaAutomationProposal =
  import("@/lib/meta/automation-proposals").MetaAutomationProposal;

const decisionAt = "2026-08-31T06:30:00.000Z";
const decisionHash = canonicalDecisionHash({
  businessId: BIZ, providerAccountId: ACCOUNT,
  scopeType: CBO.grain, scopeId: CBO.entityId,
  recId: "rec_1", recType: "scenario_c1_controlled_scale",
  snapshotDate: "2026-08-31", engineVersion: "meta-v3",
  recommendedAction: "increase_budget", targetAmountMinor: CBO.intended,
  decisionAt,
});

const proposal = (over: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal => ({
  id: PROPOSAL_ID, businessId: BIZ, providerAccountId: ACCOUNT,
  origin: "engine_decision", ruleId: null, dedupeKey: null,
  decisionKey: `${CBO.grain}:${CBO.entityId}`,
  scopeType: CBO.grain, scopeId: CBO.entityId,
  recId: "rec_1", recType: "scenario_c1_controlled_scale",
  snapshotDate: "2026-08-31", engineVersion: "meta-v3", decisionLabel: "scale",
  proposedAction: BUDGET_PROPOSAL_ACTION, actionLabel: "Change budget",
  primaryCaption: "Approve & apply", entityLabel: "Entity",
  reason: "ROAS 3.4 over 6 days at cap.", evidenceLabel: null,
  evidenceRef: {
    evidence: {
      profileInputFingerprint: INPUT_FP, profileSourceFingerprint: SOURCE_FP,
    },
  },
  expiresAt: new Date(NOW + 6 * 3_600_000).toISOString(),
  status: "pending", decidedBy: null, decidedAt: null, decisionNote: null,
  receipt: null,
  bidEnvelope: null,
  budgetEnvelope: buildBudgetProposalEnvelope({
    proposalId: PROPOSAL_ID, businessId: BIZ, providerAccountId: ACCOUNT,
    ownerGrain: CBO.grain, entityId: CBO.entityId,
    parentCampaignId: CBO.parentCampaignId,
    budgetField: "daily_budget", ownerMode: "campaign_budget_optimization",
    currentAmountMinor: CBO.current, intendedAmountMinor: CBO.intended,
    currency: "TRY", currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: "increase_budget",
    recId: "rec_1", recType: "scenario_c1_controlled_scale",
    snapshotDate: "2026-08-31", engineVersion: "meta-v3",
    decisionHash, decisionAt,
  }),
  launchIntentId: null,
  claimToken: null, claimedBy: null, claimedAt: null, dispatchStartedAt: null,
  createdAt: "2026-08-31T07:00:00.000Z", updatedAt: "2026-08-31T07:00:00.000Z",
  ...over,
});

const controlPayload = () => ({
  businessControl: {
    businessId: BIZ, killSwitchEngaged: false, killSwitchReason: null,
    // OFF. A manual approval must not need it.
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: {
      ...DEFAULT_META_AUTOMATION_GUARDRAILS,
      maxBudgetIncreasePct: 25, dryRunOnly: false,
      perActionSpendCeilingMinor: 500_000,
      perActionSpendCeilingCurrency: "TRY",
      budgetMinHoursBetweenChanges: 12, budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 60,
    },
    updatedAt: "2026-08-31T08:00:00.000Z", updatedBy: ADMIN, source: "persisted",
  },
  globalKillSwitch: { engaged: false, reason: null },
  execution: { writeEndpointsBlocked: false },
  decisionTypeModes: [{ decisionType: "budget", mode: "manual" }],
  activityLedger: [],
});

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  });

const node = (amount: number) => json({
  id: CBO.entityId, account_id: "123", name: "Entity",
  daily_budget: String(amount), currency: "TRY",
  status: "ACTIVE", effective_status: "ACTIVE",
});

const calls = (method: string) =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  );

const approve = (confirmation: unknown = MANUAL_CONFIRMATION) => POST(
  new NextRequest(
    `http://localhost/api/meta/automation/proposals?businessId=${BIZ}&providerAccountId=${ACCOUNT}`,
    {
      method: "POST",
      body: JSON.stringify({
        action: "approve", proposalId: PROPOSAL_ID, manualConfirmation: confirmation,
      }),
    },
  ),
);

describe("D088 C3 — a projected budget row through the real manual route", () => {
  beforeEach(() => {
    // Call counts only. Implementations are re-established below.
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    journalRows.length = 0;
    query.mockClear();
    activatedAccount = null;
    boundAccount = ACCOUNT;
    pendingRows = [{
      id: PROPOSAL_ID, provider_account_id: ACCOUNT,
      created_at: "2026-08-31T11:00:00.000Z",
    }];
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv(CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    // The family's own release gate. Test-local; no file and no row is touched.
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: OPERATOR } },
      membership: { businessId: BIZ, role: "owner" },
      context: { role: "owner", reviewerReadOnly: false },
    } as never);
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload() as never);
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(proposal() as never);
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "claimed",
      claimToken: CLAIM,
      proposal: proposal({ status: "claimed", claimToken: CLAIM }),
    } as never);
    vi.mocked(store.markMetaAutomationProposalDispatchStarted)
      .mockResolvedValue(true as never);
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(
      proposal({ status: "approved" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("executes with automatic execution OFF: exactly one POST, read-back verified", async () => {
    /*
      Three GETs precede the write, each for a different question: the D085
      preview's baseline, the D087 preflight's freshness read, and the
      compare-and-set immediately before the POST. Only the last one gates the
      write. Then one POST, then one independent read-back.
    */
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))       // D085 preview baseline
      .mockResolvedValueOnce(node(CBO.current))       // D087 preflight baseline
      .mockResolvedValueOnce(node(CBO.current))       // the pre-POST CAS re-read
      .mockResolvedValueOnce(json({ success: true })) // the POST
      .mockResolvedValueOnce(node(CBO.intended));     // the independent read-back

    const response = await approve();
    const payload = await response.json() as {
      ok?: boolean; receipt?: { withheld?: string | null } };

    expect(payload.receipt?.withheld ?? null, JSON.stringify(payload)).toBeNull();
    expect(calls("POST")).toHaveLength(1);
    expect(String((calls("POST")[0]![1] as RequestInit).body))
      .toBe(`daily_budget=${CBO.intended}`);
    // The journal recorded exactly one attempt, verified against the provider.
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]!.result_class).toBe("verified");
    expect(journalRows[0]!.readback_amount_minor).toBe(CBO.intended);
    // The dispatch marker was taken once, by the shared lifecycle.
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .toHaveBeenCalledTimes(1);
    const fetchOrder = vi.mocked(fetch).mock.invocationCallOrder;
    const markerOrder = vi.mocked(store.markMetaAutomationProposalDispatchStarted)
      .mock.invocationCallOrder[0]!;
    // Every async control/marker operation finishes first. The adapter's final
    // provider-side CAS GET is then the last awaited boundary before the POST.
    expect(markerOrder).toBeLessThan(fetchOrder[2]!);
    expect(fetchOrder[2]!).toBeLessThan(fetchOrder[3]!);
    expect(vi.mocked(store.settleMetaAutomationProposal)).toHaveBeenCalledTimes(1);
  });

  it("never reports success when the verified write cannot be settled", async () => {
    vi.mocked(store.settleMetaAutomationProposal)
      .mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const response = await approve();
    const payload = await response.json() as {
      ok?: boolean; error?: { code?: string }; reconciliation?: { required?: boolean };
    };

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("proposal_reconciliation_required");
    expect(payload.reconciliation?.required).toBe(true);
    expect(calls("POST")).toHaveLength(1);
    expect(store.forceMetaAutomationProposalReconcile).toHaveBeenCalledTimes(1);
  });

  it("a failed final CAS settles the existing marker but sends no POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current + 1));

    const payload = await (await approve()).json() as {
      providerDispatchStarted?: boolean;
      providerOutcomeKnown?: boolean;
    };

    expect(calls("POST")).toHaveLength(0);
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.settleMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ status: "failed" });
    expect(payload.providerDispatchStarted).toBe(false);
    expect(payload.providerOutcomeKnown).toBe(true);
  });

  it("refuses without the explicit confirmation, before any provider contact", async () => {
    const response = await approve("yes please");
    expect(response.status).toBe(400);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .not.toHaveBeenCalled();
  });

  it("a dispatch marker that cannot be taken prevents the POST", async () => {
    vi.mocked(store.markMetaAutomationProposalDispatchStarted)
      .mockResolvedValue(false as never);
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const payload = await (await approve()).json() as {
      ok?: boolean;
      providerOutcomeKnown?: boolean;
      receipt?: { withheld?: string | null };
    };
    expect(payload.receipt?.withheld).toBe("dispatch_marker_unavailable");
    expect(payload.providerOutcomeKnown).toBe(true);
    expect(calls("POST")).toHaveLength(0);
  });

  it("the persisted dry-run guardrail withholds before any provider contact", async () => {
    const control = controlPayload();
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      ...control,
      businessControl: {
        ...control.businessControl,
        guardrails: { ...control.businessControl.guardrails, dryRunOnly: true },
      },
    } as never);
    const payload = await (await approve()).json() as {
      providerOutcomeKnown?: boolean;
      receipt?: { withheld?: string | null };
    };
    expect(payload.receipt?.withheld).toBe("dry_run_guardrail");
    expect(payload.providerOutcomeKnown).toBe(true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .not.toHaveBeenCalled();
  });

  it("an UNKNOWN provider outcome reconciles once, with no retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockRejectedValueOnce(new Error("socket hang up"));

    await approve();
    expect(calls("POST")).toHaveLength(1);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]!.result_class).not.toBe("verified");
  });

  it("reconciles a 2xx budget POST whose verification GET is unreadable", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockRejectedValueOnce(new Error("verification connection reset"));

    const response = await approve();
    const payload = await response.json() as {
      ok?: boolean; proposalStatus?: string; providerOutcomeKnown?: boolean;
    };

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.proposalStatus).toBe("reconcile");
    expect(payload.providerOutcomeKnown).toBe(false);
    expect(calls("POST")).toHaveLength(1);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]!.provider_attempted).toBe(true);
    expect(journalRows[0]!.result_class).toBe("unknown");
    expect(store.settleMetaAutomationProposal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reconcile" }),
    );
  });
});

describe("D088 C3 — the SCHEDULED path shares the one lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    journalRows.length = 0;
    query.mockClear();
    activatedAccount = ACCOUNT;
    activationActor = ADMIN;
    activationControlVersion = "2026-08-31T11:55:00.000Z";
    activationReadCount = 0;
    activationChangesAfterRead = null;
    boundAccount = ACCOUNT;
    pendingRows = [{
      id: PROPOSAL_ID, provider_account_id: ACCOUNT,
      created_at: "2026-08-31T11:00:00.000Z",
    }];
    scheduledUsed = 0;
    staleSweepAvailable = true;
    staleSweepRows = [];
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv(CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    vi.stubEnv("META_AUTOMATION_LIVE_WRITES", "true");
    vi.mocked(schemaReadiness.getDbSchemaReadiness)
      .mockResolvedValue({ ready: true } as never);
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue({
      ...controlPayload(),
      businessControl: {
        ...controlPayload().businessControl,
        // The scheduled path DOES require it, and the budget mode with it.
        autoExecutionEnabled: true,
      },
      decisionTypeModes: [{ decisionType: "budget", mode: "auto" }],
    } as never);
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(proposal() as never);
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "claimed", claimToken: CLAIM,
      proposal: proposal({ status: "claimed", claimToken: CLAIM }),
    } as never);
    vi.mocked(store.claimScheduledMetaAutomationProposal).mockResolvedValue({
      status: "claimed", claimToken: CLAIM,
      proposal: proposal({ status: "claimed", claimToken: CLAIM }),
    } as never);
    vi.mocked(store.markMetaAutomationProposalDispatchStarted)
      .mockResolvedValue(true as never);
    vi.mocked(store.settleMetaAutomationProposal).mockResolvedValue(
      proposal({ status: "approved" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("executes with EXACT-account enablement: one POST, settled once", async () => {
    vi.mocked(store.readMetaAutomationProposal)
      .mockRejectedValueOnce(new Error("post-claim reread must not happen"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(result.skipped, JSON.stringify(result)).toBe(false);
    expect(calls("POST"), JSON.stringify(result)).toHaveLength(1);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]!.result_class).toBe("verified");
    // The claim, the settle and the journal all name the enabling ADMIN.
    expect(journalRows[0]!.actor_user_id).toBe(ADMIN);
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({
        claimedBy: ADMIN,
        expectedEnablingActorUserId: ADMIN,
        expectedActivationControlVersion: activationControlVersion,
      });
    // The proposal returned by the atomic claim is the execution input. A
    // second post-claim read could fail and strand the claimed row.
    expect(vi.mocked(store.readMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(store.settleMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ decidedBy: ADMIN, status: "approved" });
    expect(vi.mocked(store.settleMetaAutomationProposal)).toHaveBeenCalledTimes(1);
    const actorRead = query.mock.calls.find(([sql]) =>
      String(sql).includes("auto_execution_enabled_by"));
    expect(actorRead).toBeDefined();
    expect(String(actorRead![0])).not.toContain("THEN controls.updated_by");
  });

  it("honours the full quiet-hours/guard-rule choke point immediately before POST", async () => {
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: true,
      reason: "automation_guard_rule",
      message: "Configured quiet hours block Meta writes now.",
      guardRule: null,
      rehearsal: true,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    expect(controlPlane.getMetaWriteBlockState).toHaveBeenCalledWith({ businessId: BIZ });
    expect(calls("POST")).toHaveLength(0);
    expect(store.markMetaAutomationProposalDispatchStarted).not.toHaveBeenCalled();
    expect(store.settleMetaAutomationProposal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("counts a post-dispatch settlement failure as failed, never executed", async () => {
    vi.mocked(store.settleMetaAutomationProposal)
      .mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.reports[0]).toMatchObject({ executed: 0, failed: 1 });
    }
    expect(calls("POST")).toHaveLength(1);
    expect(store.forceMetaAutomationProposalReconcile).toHaveBeenCalledTimes(1);
  });

  it("an activation proven for ANOTHER account claims nothing", async () => {
    activatedAccount = "act_999";
    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(result.skipped).toBe(false);
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["account_not_activated"]);
    }
  });

  it("keeps proposals pending when the write context is temporarily unavailable", async () => {
    const accountContext = await import("@/lib/meta/account-context");
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValueOnce(null as never);

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.reports[0]).toMatchObject({
        ran: false,
        blockers: ["write_context_unavailable"],
        considered: 0,
        executed: 0,
        skipped: 0,
        failed: 0,
      });
    }
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(store.settleMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  /*
    PR #272 review — queue starvation.

    The page used to be selected across every account of the business and
    grouped afterwards, so `LIMIT 100` could be filled entirely by an account
    that is not the bound one. These cases put 150 OLDER rows on an unbound
    account and one newer row on the bound account: with the account filter
    applied before the limit, the bound row is still the one that runs.
  */
  it("claims the BOUND account's proposal even behind 150 older unbound rows", async () => {
    const unbound = "act_999000";
    pendingRows = [
      ...Array.from({ length: 150 }, (_unused, index) => ({
        id: `unbound-${index}`,
        provider_account_id: unbound,
        // Older than the bound row, so an unfiltered ORDER BY put them first.
        created_at: `2026-08-30T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      })),
      {
        id: PROPOSAL_ID, provider_account_id: ACCOUNT,
        created_at: "2026-08-31T11:00:00.000Z",
      },
    ];
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped, JSON.stringify(result)).toBe(false);
    const claims = vi.mocked(store.claimScheduledMetaAutomationProposal).mock.calls;
    expect(claims).toHaveLength(1);
    expect(claims[0]![0]).toMatchObject({
      proposalId: PROPOSAL_ID, providerAccountId: ACCOUNT,
    });
    // Not one row of the unbound account was even considered.
    if (!result.skipped) expect(result.reports[0]!.considered).toBe(1);
  });

  it("applies the exact-account filter BEFORE the limit, in the SQL itself", async () => {
    await runMetaBudgetAutomationSweepIfDue();

    const queueCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM meta_automation_proposals")
      && String(sql).includes("status = 'pending'"));
    expect(queueCall, "the queue query was never issued").toBeDefined();
    const [sql, params] = queueCall as [string, unknown[]];
    expect(sql).toContain("provider_account_id = $2");
    expect(params[1]).toBe(ACCOUNT);
    // Order matters: a filter after the limit would not be a filter.
    expect(sql.indexOf("provider_account_id = $2")).toBeLessThan(sql.indexOf("LIMIT"));
    expect(sql).toContain("LIMIT $3");
    expect(params[2]).toBe(3);
    // And the page is no longer selected across accounts.
    expect(sql).not.toContain("ORDER BY provider_account_id");
  });

  it("rechecks the exact activation tuple at the pre-POST boundary", async () => {
    // Outer gate, runtime gate, post-composition gate and write-deps gate see A.
    // The literal pre-POST gate sees a disable/re-enable by B.
    activationChangesAfterRead = 4;
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    expect(activationReadCount).toBeGreaterThanOrEqual(5);
    expect(calls("POST")).toHaveLength(0);
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .not.toHaveBeenCalled();
    expect(vi.mocked(store.settleMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ decidedBy: ADMIN, status: "failed" });
  });

  it("reads the binding in the enablement query and refuses a null one", async () => {
    boundAccount = null;

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(true);
    if (result.skipped) expect(result.reason).toBe("no_business_enabled");
    // No queue query, no claim, no provider call.
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("FROM meta_automation_proposals"))).toBe(false);
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it("refuses when the binding CHANGES after the queue was selected", async () => {
    /*
      The exact TOCTOU the fresh gate exists for: the enablement query bound
      this account, and by the time the verdict is read the activation names a
      different one. Zero claims, zero provider calls.
    */
    boundAccount = ACCOUNT;
    activatedAccount = "act_888111";

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["account_not_activated"]);
      expect(result.reports[0]!.executed).toBe(0);
    }
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it("a non-UUID enabling actor claims nothing", async () => {
    activatedAccount = ACCOUNT;
    activationActor = "meta_budget_automation_sweep";
    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["enabling_actor_absent"]);
    }
  });

  it("fails closed when stale claims cannot be classified before the cap count", async () => {
    staleSweepAvailable = false;

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.reports[0]).toMatchObject({
        ran: false,
        blockers: ["stale_claim_sweep_unavailable"],
        considered: 0,
        executed: 0,
      });
    }
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(calls("POST")).toHaveLength(0);
  });

  it("requeues an expired markerless claim before counting the daily cap", async () => {
    scheduledUsed = 3;
    staleSweepRows = [{ next_status: "pending" }];
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).toHaveBeenCalledTimes(1);
    expect(calls("POST")).toHaveLength(1);
    const sweepOrder = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("claimed_at <= $3::timestamptz"));
    const countOrder = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("receipt_json->>'executionKind'"));
    expect(sweepOrder).toBeGreaterThanOrEqual(0);
    expect(sweepOrder).toBeLessThan(countOrder);
  });

  it("keeps a stale dispatched claim in reconcile and does not reopen its slot", async () => {
    scheduledUsed = 3;
    staleSweepRows = [{ next_status: "reconcile" }];

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["daily_auto_action_cap_reached"]);
    }
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(calls("POST")).toHaveLength(0);
  });

  it("bounds the queue by the remaining daily automatic-action allowance", async () => {
    scheduledUsed = 2;
    pendingRows = [
      { id: PROPOSAL_ID, provider_account_id: ACCOUNT,
        created_at: "2026-08-31T10:00:00.000Z" },
      { id: "22222222-2222-4222-8222-222222222222",
        provider_account_id: ACCOUNT,
        created_at: "2026-08-31T11:00:00.000Z" },
    ];
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();

    expect(result.skipped).toBe(false);
    expect(vi.mocked(store.claimScheduledMetaAutomationProposal)).toHaveBeenCalledTimes(1);
    const queueCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM meta_automation_proposals")
      && String(sql).includes("LIMIT $3"));
    expect(queueCall?.[1]?.[2]).toBe(1);
  });
});
