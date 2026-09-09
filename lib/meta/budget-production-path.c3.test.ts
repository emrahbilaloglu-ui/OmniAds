/**
 * D088 C3 — the PRODUCTION projection path, end to end.
 *
 * Every earlier revision proved the composition against an injected
 * `BudgetCompositionSources`, so what it proved was the object, not the path.
 * This file starts where production starts — the candidate SQL's own rows —
 * and runs the real chain:
 *
 *   candidate SQL/map -> loadBudgetCompositionSourcesForCandidate
 *     -> projectMetaBudgetProposals -> composeBudgetExecutionCandidate
 *     -> buildBudgetProposalEnvelope -> insertBudgetProposalRow
 *
 * Nothing between those is stubbed. The only mocks are the low-level
 * boundaries: the database, the Meta credential context, `fetch`, and the
 * persisted control plane. No composed result, no readiness, no safety verdict,
 * no write-safety map, no request and no baseline is injected.
 */
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

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_123";
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const INPUT_FP = "a1".repeat(32);
const SOURCE_FP = "b2".repeat(32);

const CBO = {
  grain: "campaign" as const,
  entityId: "23851234567890123",
  parentCampaignId: null as string | null,
  current: 250_000,
  intended: 300_000,
};
const ABO = {
  grain: "adset" as const,
  entityId: "23851234567890124",
  parentCampaignId: "23859876543210987",
  current: 90_000,
  intended: 108_000,
};
const OTHER = {
  grain: "campaign" as const,
  entityId: "23850000000000000",
  parentCampaignId: null as string | null,
  current: 535_000,
  intended: 535_000,
};
const CAMPAIGN_RUN = "44444444-4444-4444-8444-444444444444";
const ADSET_RUN = "77777777-7777-4777-8777-777777777777";
const COHORT = "88888888-8888-4888-8888-888888888888";

/* ------------------------------------------------------------------ */
/* The DATABASE boundary: one dispatcher over the real SQL this path   */
/* issues. Every branch answers the query the production code wrote.   */
/* ------------------------------------------------------------------ */

const observationRow = (
  shape: typeof CBO | typeof ABO,
  role: "subject" | "parent",
) => ({
  grain: role === "parent" ? "campaign" : shape.grain,
  business_id: BIZ, provider_account_id: ACCOUNT,
  entity_id: role === "parent" ? shape.parentCampaignId : shape.entityId,
  campaign_id: role === "parent" ? shape.parentCampaignId
    : shape.grain === "campaign" ? shape.entityId : shape.parentCampaignId,
  presence: "present", run_completeness: "complete",
  configured_status: "ACTIVE", effective_status: "ACTIVE",
  budget_origin: role === "parent" ? "not_applicable"
    : shape.grain === "campaign" ? "campaign" : "adset",
  budget_currency: "TRY", budget_currency_exponent: 2,
  budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
  budget_shape_support: "supported",
  campaign_daily_budget_raw: role === "subject" && shape.grain === "campaign"
    ? String(shape.current) : null,
  campaign_lifetime_budget_raw: null,
  adset_daily_budget_raw: role === "subject" && shape.grain === "adset"
    ? String(shape.current) : null,
  adset_lifetime_budget_raw: null,
  campaign_start_time: null, campaign_end_time: null,
  adset_start_time: null, adset_end_time: null,
  optimization_goal: shape.grain === "adset" && role === "subject"
    ? "OFFSITE_CONVERSIONS" : null,
  provider_api_version: "v22.0",
  state_hash: (role === "parent" ? "d" : shape.grain === "campaign" ? "e" : "f").repeat(64),
  observation_id: `obs-${shape.entityId}-${role}`,
  field_coverage_json: { configuredStatus: true, effectiveStatus: true },
  provider_updated_at: "2026-08-30T02:00:00.000Z",
  observed_on: "2026-08-30", observed_at: "2026-08-30T03:00:00.000Z",
  captured_at: "2026-08-30T03:00:00.000Z", created_at: "2026-08-30T03:00:05.000Z",
  id: `state-${shape.entityId}-${role}`,
  run_id: role === "parent" || shape.grain === "campaign"
    ? CAMPAIGN_RUN : ADSET_RUN,
  source_snapshot_id: "55555555-5555-4555-8555-555555555555",
  payload_hash: "b".repeat(64), run_hash: "c".repeat(64),
  distinct_truths: 1, population_total: 4,
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
    member_ids: [CBO.entityId, ABO.parentCampaignId, OTHER.entityId].sort(),
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
    member_ids: [ABO.entityId],
  },
];

const presentIdentities = [
  `campaign:${CBO.entityId}`,
  `campaign:${ABO.parentCampaignId}`,
  `campaign:${OTHER.entityId}`,
  `adset:${ABO.entityId}`,
].sort();

const candidateRow = (shape: typeof CBO | typeof ABO) => ({
  scope_type: shape.grain,
  scope_id: shape.entityId,
  provider_account_id: ACCOUNT,
  rec_id: `rec_${shape.entityId}`,
  rec_type: shape.grain === "campaign"
    ? "scenario_c1_controlled_scale"
    : "adset_scale_budget",
  snapshot_date: "2026-08-31",
  engine_version: "meta-v3",
  decision_label: "scale",
  recommended_action: "increase_budget",
  target_amount_minor: shape.intended,
  reasoning: "ROAS 3.4 over 6 days at cap.",
  entity_label: "Entity",
  parent_campaign_id: shape.parentCampaignId,
  created_at: "2026-08-31T06:30:00.000Z",
  evidence: {
    profileInputFingerprint: INPUT_FP,
    profileSourceFingerprint: SOURCE_FP,
  },
});

const profileRow = (action: string) => ({
  contract: D086_RETENTION_CONTRACT,
  profile_contract: ACCOUNT_DECISION_PROFILE_CONTRACT,
  business_id: BIZ, provider_account_id: ACCOUNT,
  action,
  engine_epoch: ENGINE_VERSION, engine_version: ENGINE_VERSION,
  input_fingerprint: INPUT_FP, source_fingerprint: SOURCE_FP,
  eligible: true, blocker_code: null,
  as_of_date: "2026-08-31",
  effective_at: "2026-08-31T06:00:00.000Z",
  recorded_at: "2026-08-31T06:00:00.000Z",
  tied_rows: 1, distinct_truths: 1, population_total: 2,
});

const roleRow = (campaignId: string) => ({
  business_id: BIZ, provider_account_id: ACCOUNT,
  as_of_date: "2026-08-30",
  inferred_kind: "main",
  kind_source: "system_inferred",
  confidence_class: "high",
  resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  campaign_id: campaignId,
});

const inserted: Array<Record<string, unknown>> = [];
let profileActions: string[] = ["scale", "cut"];
let roleRowsPresent = true;
let concentrationKnown = true;

const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  const text = String(sql);
  if (text.includes("FROM meta_decision_snapshots_daily")) {
    return [candidateRow(CBO), candidateRow(ABO)];
  }
  if (text.includes("account_timezone")) {
    return [{ account_timezone: "Europe/Istanbul" }];
  }
  if (text.includes("FROM engine_v3_account_profile_output")) {
    return profileActions.map(profileRow);
  }
  if (text.includes("FROM engine_v3_campaign_role_authority")) {
    return roleRowsPresent ? [roleRow(String(params[1]))] : [];
  }
  if (text.includes("FROM meta_entity_observation_receipts_v2")) {
    return completeRunRows;
  }
  if (text.includes("FROM owners")) {
    // The owner-deduplicated retained population for the concentration share.
    if (!concentrationKnown) {
      // An owner row whose amount could not be priced: the population is
      // incomplete, so the share is UNKNOWN.
      return [{
        owner_rows: 3, unpriced_rows: 1, total_minor: "875000",
        subject_minor: String(CBO.current),
        max_other_minor: String(OTHER.current),
        unknown_origin_rows: 0, present_identities: presentIdentities,
      }];
    }
    return [{
      owner_rows: 3, unpriced_rows: 0,
      total_minor: "875000",
      subject_minor: String(params[2] === CBO.entityId ? CBO.current : ABO.current),
      max_other_minor: String(OTHER.current),
      unknown_origin_rows: 0, present_identities: presentIdentities,
    }];
  }
  if (text.includes("FROM meta_budget_write_journal")) {
    return [{ last_change_ms: null, in_7d: 0 }];
  }
  if (text.includes("AND claim_token IS NOT NULL")) {
    return [{ open_claims: 0 }];
  }
  if (text.includes("INSERT INTO meta_automation_proposals")) {
    inserted.push({ sql: text, params });
    return [{ id: String(params[18]) }];
  }
  if (text.includes("FROM meta_entity_state_history")) {
    // The D086 current-state read, for both entities and the ABO parent.
    return [
      observationRow(CBO, "subject"),
      observationRow(ABO, "subject"),
      observationRow(ABO, "parent"),
      observationRow(OTHER, "subject"),
    ];
  }
  throw new Error(`unmocked query: ${text.slice(0, 120)}`);
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
}));

vi.mock("@/lib/meta/automation-control-plane", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getMetaAutomationControlPlane: vi.fn() };
});

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getMetaAccountContext: vi.fn(async () => ({
      connected: true,
      accessToken: "secret-token",
      connectionGeneration: "1:connected",
      // PR #272 review: a usable ad account reports its currency, and the
      // budget write context refuses to exist without one.
      accountProfiles: { [ACCOUNT]: { id: ACCOUNT, currency: "TRY" } },
    })),
  };
});

const controlPlane = await import("@/lib/meta/automation-control-plane");
const {
  TYPED_BUDGET_CANDIDATE_SQL,
  projectMetaBudgetProposals,
  listTypedBudgetCandidates,
  insertBudgetProposalRow,
} =
  await import("@/lib/meta/budget-proposal-producer");
const { loadBudgetCompositionSourcesForCandidate } =
  await import("@/lib/meta/budget-proposal-source-loader");
const { readMeasuredBudgetHistory } =
  await import("@/lib/meta/budget-proposal-server-readers");
const { parseBudgetProposalEnvelope } = await import("@/lib/meta/budget-proposal-runtime");

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  });

const controlPayload = (over: Record<string, unknown> = {}) => ({
  businessControl: {
    businessId: BIZ,
    killSwitchEngaged: false, killSwitchReason: null,
    autoExecutionEnabled: false,
    readinessTier: "manual_review",
    guardrails: {
      ...DEFAULT_META_AUTOMATION_GUARDRAILS,
      maxBudgetIncreasePct: 25,
      perActionSpendCeilingMinor: 500_000,
      perActionSpendCeilingCurrency: "TRY",
      dryRunOnly: false,
      budgetMinHoursBetweenChanges: 12,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 60,
    },
    updatedAt: "2026-08-31T08:00:00.000Z",
    updatedBy: "22222222-2222-4222-8222-222222222222",
    source: "persisted",
    ...(over.businessControl as Record<string, unknown> ?? {}),
  },
  globalKillSwitch: { engaged: false, reason: null },
  execution: { writeEndpointsBlocked: false },
  decisionTypeModes: [{ decisionType: "budget", mode: "manual" }],
  activityLedger: [],
});

const projectionGets = () =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "GET",
  );
const posts = () =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

describe("D088 C3 — the real producer projects real rows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    inserted.length = 0;
    profileActions = ["scale", "cut"];
    roleRowsPresent = true;
    concentrationKnown = true;
    query.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      json({
        id: String(url).includes(CBO.entityId) ? CBO.entityId : ABO.entityId,
        account_id: "123", name: "Entity",
        daily_budget: String(String(url).includes(CBO.entityId)
          ? CBO.current : ABO.current),
        currency: "TRY", status: "ACTIVE", effective_status: "ACTIVE",
      })));
    vi.stubEnv(CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    vi.mocked(controlPlane.getMetaAutomationControlPlane)
      .mockResolvedValue(controlPayload() as never);
  });

  afterEach(() => {
    // The resolver-approval stub is test-local and must not leak into another
    // file, where it would silently flip an environment-gated suite.
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("admits persisted typed budget intents only from act decisions", () => {
    expect(TYPED_BUDGET_CANDIDATE_SQL).toMatch(
      /AND\s+d\.decision_state\s*=\s*'act'/,
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).toMatch(
      /provider_account_id\s*=\s*ANY\(\$\d::text\[\]\)/,
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).toContain(
      "d.rec_type = 'scenario_c1_controlled_scale' AND d.scope_type = 'campaign' AND d.target_value ->> 'direction' = 'increase'",
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).not.toContain(
      "d.rec_type = 'scenario_c1_controlled_scale' AND d.scope_type = 'adset'",
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).toContain(
      "held.proposed_action = 'budget'",
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).toContain(
      "held.status IN ('pending', 'claimed', 'reconcile')",
    );
    expect(TYPED_BUDGET_CANDIDATE_SQL).toMatch(
      /held\.status\s*=\s*'pending'[\s\S]*held\.origin\s*=\s*'engine_decision'[\s\S]*held\.rec_type\s*=\s*d\.rec_type[\s\S]*held\.snapshot_date\s*=\s*d\.snapshot_date/,
    );
  });

  it("cannot project a stale candidate from an account this run did not finish", async () => {
    const [allowed] = await listTypedBudgetCandidates(
      BIZ,
      "2026-08-31",
      [ACCOUNT],
    );
    expect(allowed).toBeDefined();
    const loadCompositionSources = vi.fn(async () => null);
    const result = await projectMetaBudgetProposals({
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      readBudgetMode: async () => "semi_auto",
      listCandidates: async () => [
        allowed!,
        { ...allowed!, providerAccountId: "act_failed_this_run" },
      ],
      loadCompositionSources,
      insertProposal: async () => "should-not-happen",
    });

    expect(result.candidates).toBe(1);
    expect(result.refusals).toEqual({ composition_sources_unavailable: 1 });
    expect(loadCompositionSources).toHaveBeenCalledTimes(1);
    expect(loadCompositionSources).toHaveBeenCalledWith(allowed);
  });

  it("refuses injected candidates from another business or snapshot day", async () => {
    const [allowed] = await listTypedBudgetCandidates(
      BIZ,
      "2026-08-31",
      [ACCOUNT],
    );
    const loadCompositionSources = vi.fn(async () => null);
    const result = await projectMetaBudgetProposals({
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      readBudgetMode: async () => "semi_auto",
      listCandidates: async () => [
        allowed!,
        { ...allowed!, businessId: "other-business" },
        { ...allowed!, snapshotDate: "2026-08-30" },
      ],
      loadCompositionSources,
      insertProposal: async () => "should-not-happen",
    });

    expect(result.candidates).toBe(1);
    expect(result.refusals).toEqual({
      candidate_scope_mismatch: 2,
      composition_sources_unavailable: 1,
    });
    expect(loadCompositionSources).toHaveBeenCalledTimes(1);
    expect(loadCompositionSources).toHaveBeenCalledWith(allowed);
  });

  it.each([
    ["campaign type at ad-set grain", {
      scopeType: "adset",
      parentCampaignId: ABO.parentCampaignId,
    }],
    ["scale type with a decrease direction", {
      recommendedAction: "decrease_budget",
    }],
    ["an unsupported direction verb", {
      recommendedAction: "hold_budget",
    }],
  ])("refuses an injected crossed semantic tuple: %s", async (_label, crossed) => {
    const [allowed] = await listTypedBudgetCandidates(
      BIZ,
      "2026-08-31",
      [ACCOUNT],
    );
    expect(allowed).toBeDefined();
    const loadCompositionSources = vi.fn(async () => null);
    const result = await projectMetaBudgetProposals({
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      readBudgetMode: async () => "semi_auto",
      listCandidates: async () => [{ ...allowed!, ...crossed } as never],
      loadCompositionSources,
      insertProposal: async () => "should-not-happen",
    });

    expect(result.candidates).toBe(0);
    expect(result.projected).toBe(0);
    expect(result.refusals).toEqual({ budget_action_semantic_mismatch: 1 });
    expect(loadCompositionSources).not.toHaveBeenCalled();
  });

  it("does not read candidates when no account finished this run", async () => {
    const listCandidates = vi.fn(async () => []);
    const result = await projectMetaBudgetProposals({
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [],
      readBudgetMode: async () => "semi_auto",
      listCandidates,
      loadCompositionSources: async () => null,
      insertProposal: async () => "should-not-happen",
    });

    expect(result.candidates).toBe(0);
    expect(result.refusals).toEqual({ account_generation_not_fulfilled: 1 });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it.each([
    ["default", null],
    ["manual", "manual"],
    ["semi-auto", "semi_auto"],
    ["auto", "auto"],
  ] as const)("projects account-scoped pending rows in %s mode", async (_label, mode) => {
    const readBudgetMode = mode === null
      ? undefined
      : vi.fn(async () => mode);
    const result = await projectMetaBudgetProposals({
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      ...(readBudgetMode ? { readBudgetMode } : {}),
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async (input) => insertBudgetProposalRow({
        businessId: BIZ,
        proposalId: input.proposalId,
        candidate: input.candidate,
        envelopeJson: input.envelopeJson,
        actionLabel: input.actionLabel,
      }),
    });

    expect(result.refusals, JSON.stringify(result.refusals)).toEqual({});
    expect(result.candidates).toBe(2);
    expect(result.projected).toBe(2);
    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(String(row.sql)).toContain("'pending'");
      expect((row.params as unknown[])[1]).toBe(ACCOUNT);
    }
    if (readBudgetMode) expect(readBudgetMode).not.toHaveBeenCalled();

    // ONE GET-only baseline per candidate, and never a POST at projection.
    expect(projectionGets()).toHaveLength(2);
    expect(posts()).toHaveLength(0);
  });

  it("keeps projecting the family when another writer wins an open slot", async () => {
    const openSlotConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_meta_automation_proposals_open_slot",
    });
    const result = await projectMetaBudgetProposals({
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => { throw openSlotConflict; },
    });

    expect(result.candidates).toBe(2);
    expect(result.projected).toBe(0);
    expect(result.refusals).toEqual({ insert_conflicted: 2 });
  });

  it("does not hide a different database uniqueness failure", async () => {
    const unrelatedConflict = Object.assign(new Error("duplicate id"), {
      code: "23505",
      constraint: "meta_automation_proposals_pkey",
    });
    const candidates = await listTypedBudgetCandidates(
      BIZ,
      "2026-08-31",
      [ACCOUNT],
    );
    await expect(projectMetaBudgetProposals({
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ,
      snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      listCandidates: async () => [candidates[0]!],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => { throw unrelatedConflict; },
    })).rejects.toMatchObject({
      code: "23505",
      constraint: "meta_automation_proposals_pkey",
    });
  });

  it("the stored envelope carries the DECISION's own hash, clock and lineage", async () => {
    await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async (input) => insertBudgetProposalRow({
        businessId: BIZ, proposalId: input.proposalId, candidate: input.candidate,
        envelopeJson: input.envelopeJson, actionLabel: input.actionLabel,
      }),
    });

    const candidates = await listTypedBudgetCandidates(
      BIZ,
      "2026-08-31",
      [ACCOUNT],
    );
    for (const row of inserted) {
      const params = row.params as unknown[];
      const envelope = parseBudgetProposalEnvelope(
        JSON.parse(String(params[17])) as unknown,
      );
      expect(envelope).not.toBeNull();
      const candidate = candidates.find((c) => c.scopeId === envelope!.entityId)!;
      expect(candidate).toBeDefined();
      // The decision's identity, not the envelope's own fingerprint.
      expect(envelope!.decisionHash).toBe(candidate.decisionHash);
      expect(envelope!.decisionHash).not.toBe(envelope!.fingerprint);
      expect(envelope!.decisionAt).toBe("2026-08-31T06:30:00.000Z");
      expect(envelope!.recId).toBe(candidate.recId);
      expect(envelope!.snapshotDate).toBe("2026-08-31");
      // The ad set carries its parent campaign; the campaign carries none.
      if (envelope!.ownerGrain === "adset") {
        expect(envelope!.parentCampaignId).toBe(ABO.parentCampaignId);
      } else {
        expect(envelope!.parentCampaignId).toBeNull();
      }
    }
  });

  it("with the DEFAULT posture it contacts no provider and projects nothing", async () => {
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPayload({ businessControl: { source: "default" } }) as never,
    );
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    expect(result.refusals.provider_baseline_unavailable).toBe(2);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("refuses an UNCONFIGURED budget policy without contacting the provider", async () => {
    /*
      The three budget policy keys have no permissive default. Until an
      operator persists real numbers there is no policy, so there is nothing to
      preview and no reason to read the account.
    */
    vi.mocked(controlPlane.getMetaAutomationControlPlane).mockResolvedValue(
      controlPayload({
        businessControl: {
          guardrails: {
            ...DEFAULT_META_AUTOMATION_GUARDRAILS,
            maxBudgetIncreasePct: 25, dryRunOnly: false,
            budgetMinHoursBetweenChanges: 12, budgetMaxChangesPer7d: 3,
            budgetMaxAccountConcentrationPct: null,
          },
        },
      }) as never,
    );
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    expect(result.refusals.provider_baseline_unavailable).toBe(2);
    expect(inserted).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it("refuses when the profile row is for the OTHER action", async () => {
    profileActions = ["cut"];
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    expect(result.refusals.profile_not_retained).toBe(2);
  });


  it("refuses when NO automatic role evidence exists", async () => {
    roleRowsPresent = false;
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    expect(result.refusals.role_authority_absent).toBe(2);
    expect(inserted).toHaveLength(0);
  });

  it("refuses when the account concentration cannot be measured", async () => {
    concentrationKnown = false;
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    // Unknown, not zero: an unpriced owner row makes the share unprovable.
    expect(result.refusals.change_history_unknown).toBe(2);
    expect(inserted).toHaveLength(0);
  });

  it("measures the largest prospective owner after a decrease", async () => {
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("FROM owners")) {
        return [{
          owner_rows: 2, unpriced_rows: 0,
          total_minor: "100", subject_minor: "50", max_other_minor: "50",
          unknown_origin_rows: 0,
          // Two budget owners plus two present not-applicable identities.
          present_identities: presentIdentities,
        }];
      }
      return original(sql, params);
    });

    const history = await readMeasuredBudgetHistory({
      businessId: BIZ,
      providerAccountId: ACCOUNT,
      entityGrain: "campaign",
      entityId: CBO.entityId,
      intendedAmountMinor: 20,
      nowMs: NOW,
    });

    expect(history).not.toBeNull();
    expect(history!.accountConcentrationPercent).toBeCloseTo(71.428571, 5);
    query.mockImplementation(original);
  });

  it("refuses an ad set whose role evidence is for a DIFFERENT campaign", async () => {
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("FROM engine_v3_campaign_role_authority")) {
        // Evidence for a campaign this ad set does not belong to.
        return [roleRow("23850000000000000")];
      }
      if (String(sql).includes("FROM meta_decision_snapshots_daily")) {
        return [candidateRow(ABO)];
      }
      return original(sql, params);
    });
    const result = await projectMetaBudgetProposals({
      // This suite is about composition refusals, so the family's standing
      // mode is stated: a manual business projects nothing at all, which is
      // its own test elsewhere.
      readBudgetMode: async () => "semi_auto",
      businessId: BIZ, snapshotDate: "2026-08-31",
      providerAccountIds: [ACCOUNT],
      loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
      insertProposal: async () => "should-not-happen",
    });
    expect(result.projected).toBe(0);
    expect(result.refusals.role_authority_absent).toBe(1);
    expect(inserted).toHaveLength(0);
    query.mockImplementation(original);
  });
});
