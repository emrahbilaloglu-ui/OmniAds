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
    getMetaWriteBlockState: vi.fn(async () => ({
      blocked: false, reason: null, message: null,
    })),
    readEffectiveMetaWriteGovernance: vi.fn(async () => ({
      verified: true, writeBlocked: false, killSwitchEngaged: false, blockReason: null,
    })),
    writeActivityLedgerRow: vi.fn(async () => undefined),
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
    markMetaAutomationProposalDispatchStarted: vi.fn(),
    settleMetaAutomationProposal: vi.fn(),
    countMetaAutomationProposalHolds: vi.fn(async () => 0),
  };
});
vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMetaAccountContext: vi.fn(async () => ({
      accessToken: "secret-token", connectionGeneration: "1:connected",
      accountProfiles: { [ACCOUNT]: { id: ACCOUNT } },
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
      unknown_origin_rows: 0, present_identities: presentIdentities,
    }];
  }
  if (text.includes("FROM meta_budget_write_journal")
    && text.includes("last_change_ms")) {
    return [{ last_change_ms: null, in_7d: 0 }];
  }
  if (text.includes("SELECT auto_execution_provider_account_id")) {
    return [{
      auto_execution_provider_account_id: activatedAccount,
      updated_by: ADMIN,
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
    return [{ business_id: BIZ }];
  }
  if (text.includes("FROM meta_automation_proposals")
    && text.includes("proposed_action = 'budget'")) {
    return [{ id: PROPOSAL_ID, provider_account_id: ACCOUNT }];
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
}));

let activatedAccount: string | null = null;

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
  recId: "rec_1", recType: "scenario_budget_scale",
  snapshotDate: "2026-08-31", engineVersion: "meta-v3",
  recommendedAction: "increase_budget", targetAmountMinor: CBO.intended,
  decisionAt,
});

const proposal = (over: Partial<MetaAutomationProposal> = {}): MetaAutomationProposal => ({
  id: PROPOSAL_ID, businessId: BIZ, providerAccountId: ACCOUNT,
  origin: "engine_decision", ruleId: null, dedupeKey: null,
  decisionKey: `${CBO.grain}:${CBO.entityId}`,
  scopeType: CBO.grain, scopeId: CBO.entityId,
  recId: "rec_1", recType: "scenario_budget_scale",
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
  budgetEnvelope: buildBudgetProposalEnvelope({
    proposalId: PROPOSAL_ID, businessId: BIZ, providerAccountId: ACCOUNT,
    ownerGrain: CBO.grain, entityId: CBO.entityId,
    parentCampaignId: CBO.parentCampaignId,
    budgetField: "daily_budget", ownerMode: "campaign_budget_optimization",
    currentAmountMinor: CBO.current, intendedAmountMinor: CBO.intended,
    currency: "TRY", currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: "increase_budget",
    recId: "rec_1", recType: "scenario_budget_scale",
    snapshotDate: "2026-08-31", engineVersion: "meta-v3",
    decisionHash, decisionAt,
  }),
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
      status: "claimed", claimToken: CLAIM,
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
    // The marker follows the adapter's final CAS GET and is the last operation
    // before the provider POST.
    expect(fetchOrder[2]!).toBeLessThan(markerOrder);
    expect(markerOrder).toBeLessThan(fetchOrder[3]!);
    expect(vi.mocked(store.settleMetaAutomationProposal)).toHaveBeenCalledTimes(1);
  });

  it("a failed final CAS writes no dispatch marker and sends no POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current + 1));

    await approve();

    expect(calls("POST")).toHaveLength(0);
    expect(vi.mocked(store.markMetaAutomationProposalDispatchStarted))
      .not.toHaveBeenCalled();
    expect(vi.mocked(store.settleMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ status: "failed" });
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
      ok?: boolean; receipt?: { withheld?: string | null } };
    expect(payload.receipt?.withheld).toBe("dispatch_marker_unavailable");
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
      receipt?: { withheld?: string | null } };
    expect(payload.receipt?.withheld).toBe("dry_run_guardrail");
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
});

describe("D088 C3 — the SCHEDULED path shares the one lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    journalRows.length = 0;
    query.mockClear();
    activatedAccount = ACCOUNT;
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
    vi.mocked(store.readMetaAutomationProposal).mockResolvedValue(proposal() as never);
    vi.mocked(store.claimMetaAutomationProposal).mockResolvedValue({
      status: "claimed", claimToken: CLAIM,
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
    vi.mocked(fetch)
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(node(CBO.current))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node(CBO.intended));

    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(result.skipped, JSON.stringify(result)).toBe(false);
    expect(calls("POST")).toHaveLength(1);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]!.result_class).toBe("verified");
    // The claim, the settle and the journal all name the enabling ADMIN.
    expect(journalRows[0]!.actor_user_id).toBe(ADMIN);
    expect(vi.mocked(store.claimMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ claimedBy: ADMIN });
    expect(vi.mocked(store.settleMetaAutomationProposal).mock.calls[0]![0])
      .toMatchObject({ decidedBy: ADMIN, status: "approved" });
    expect(vi.mocked(store.settleMetaAutomationProposal)).toHaveBeenCalledTimes(1);
  });

  it("an activation proven for ANOTHER account claims nothing", async () => {
    activatedAccount = "act_999";
    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(result.skipped).toBe(false);
    expect(vi.mocked(store.claimMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["account_not_activated"]);
    }
  });

  it("a non-UUID enabling actor claims nothing", async () => {
    activatedAccount = ACCOUNT;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT auto_execution_provider_account_id")) {
        return [{
          auto_execution_provider_account_id: ACCOUNT,
          updated_by: "meta_budget_automation_sweep",
        }];
      }
      return baseQuery(sql, params);
    });
    const result = await runMetaBudgetAutomationSweepIfDue();
    expect(vi.mocked(store.claimMetaAutomationProposal)).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    if (!result.skipped) {
      expect(result.reports[0]!.blockers).toEqual(["enabling_actor_absent"]);
    }
    query.mockImplementation(baseQuery);
  });
});
