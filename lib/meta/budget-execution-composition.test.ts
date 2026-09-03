/**
 * D088 — the runtime composition root, and the gates that keep it inert.
 *
 * This is the one place a concrete budget candidate is assembled from retained
 * evidence. It has no authority of its own: it reads the canonical chain, hands
 * the facts to D085 for the preview and to D087 for the durable request, and
 * reports what refused. Every case below either produces a named blocker or
 * proves a POST did not happen.
 */
import { describe, expect, it } from "vitest";

import { CANONICAL_PROFILE_CONTRACT } from "@/lib/meta/budget-proposal-dry-run";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import {
  D088_COMPOSITION_CONTRACT,
  D088_COMPOSITION_BLOCKERS,
  composeBudgetExecutionCandidate,
  durableIdempotencyKeyFor,
  type BudgetCompositionSources,
} from "@/lib/meta/budget-execution-composition";

const BIZ = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "act_770001";
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const CLAIM = "77777777-7777-4777-8777-777777777777";
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const flag = (why: string) => ({
  state: "clear" as const, source: "d088-test", asOf: "2026-08-30", why,
});

/** A freshly captured campaign observation row, as the state read returns it. */
const observationRow = (over: Record<string, unknown> = {}) => ({
  grain: "campaign",
  business_id: BIZ,
  provider_account_id: ACCOUNT,
  entity_id: "c_100",
  campaign_id: "c_100",
  presence: "present",
  run_completeness: "complete",
  configured_status: "ACTIVE",
  effective_status: "ACTIVE",
  budget_origin: "campaign",
  budget_currency: "TRY",
  budget_currency_exponent: 2,
  budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
  budget_shape_support: "supported",
  campaign_daily_budget_raw: "250000",
  campaign_lifetime_budget_raw: null,
  adset_daily_budget_raw: null,
  adset_lifetime_budget_raw: null,
  campaign_start_time: null,
  campaign_end_time: null,
  adset_start_time: null,
  adset_end_time: null,
  provider_api_version: "v22.0",
  state_hash: "a".repeat(64),
  observation_id: "obs-1",
  field_coverage_json: { configuredStatus: true, effectiveStatus: true },
  provider_updated_at: "2026-08-30T02:00:00.000Z",
  observed_on: "2026-08-30",
  observed_at: "2026-08-30T03:00:00.000Z",
  captured_at: "2026-08-30T03:00:00.000Z",
  created_at: "2026-08-30T03:00:05.000Z",
  id: "state-1",
  run_id: "44444444-4444-4444-8444-444444444444",
  source_snapshot_id: "55555555-5555-4555-8555-555555555555",
  payload_hash: "b".repeat(64),
  run_hash: "c".repeat(64),
  distinct_truths: 1,
  population_total: 1,
  ...over,
});

const sources = (over: Partial<BudgetCompositionSources> = {}): BudgetCompositionSources => ({
  businessId: BIZ,
  providerAccountId: ACCOUNT,
  ownerGrain: "campaign",
  entityId: "c_100",
  parentCampaignId: null,
  proposalId: PROPOSAL,
  claimToken: CLAIM,
  actorUserId: "22222222-2222-4222-8222-222222222222",
  observations: [observationRow()],
  accountTimeZone: "Europe/Istanbul",
  /** The exact intent verb and amount. Never a generic label. */
  intent: { verb: "increase_budget", intendedAmountMinor: 300000, percent: 20 },
  role: {
    kind: "main", source: "automatic", resolverVersion: "campaign-context-resolver.v2",
    confidence: "high", asOf: "2026-08-30", accountScoped: true,
    satisfiesRoleAuthority: true, producer: "automatic_inference",
    authorityBlockers: [],
  },
  profileRetained: true,
  changeHistory: { lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10 },
  providerBaseline: {
    entityId: "c_100", providerAccountId: ACCOUNT, budgetField: "daily_budget",
    amountMinor: 250000, currency: "TRY", readAtMs: NOW - 60_000,
  },
  nowMs: NOW,
  // Real D085 postures. `clear` is the shape D085's own fixtures use.
  safety: {
    killSwitch: flag("disengaged"), admission: flag("allowed"),
    cap: flag("under cap"), cooldown: flag("no cooldown"), conflict: flag("no lock"),
  },
  writeSafety: Object.fromEntries(
    WRITE_SAFETY_STEPS.map((step) => [step, "satisfied" as const]),
  ),
  commercial: {
    profileContractVersion: CANONICAL_PROFILE_CONTRACT,
    businessId: BIZ, providerAccountId: ACCOUNT, sourceStatus: "retained",
    selectedAction: "scale", eligible: true, code: null, reason: null,
    blockerCodes: [], evidenceFloorsClear: true, changeSafetyClear: true,
  },
  decision: {
    id: PROPOSAL, hash: "d".repeat(64), version: "v3",
    decidedAt: "2026-08-30T09:06:00.000Z", maxAgeSeconds: 86_400,
  },
  casBaseline: null,
  preflight: null,
  preflightEvidence: null,
  rawIntent: null,
  ...over,
});

describe("D088 — a concrete candidate is composed from retained facts only", () => {
  it("walks observation → canonical fact → D085 preview → durable D087 request", () => {
    const result = composeBudgetExecutionCandidate(sources());
    expect(result.blockers, result.blockers.join(",")).toEqual([]);
    expect(result.contract).toBe(D088_COMPOSITION_CONTRACT);
    // The canonical fact, not a restatement of the row.
    expect(result.canonicalFact?.ownerGrain).toBe("campaign");
    // D083 names the field `daily`; the write contracts name it
    // `daily_budget`. The translation is explicit, and each layer keeps its
    // own vocabulary rather than one silently standing for the other.
    expect(result.canonicalFact?.budgetField).toBe("daily");
    // D085 first...
    expect(result.dryRun?.status).toBeDefined();
    // ...then the durable request derived from the SAME validated facts.
    expect(result.request?.budgetField).toBe("daily_budget");
    expect(result.request?.intendedAmountMinor).toBe(300000);
    expect(result.request?.baseline.amountMinor).toBe(250000);
    expect(result.request?.currency).toBe("TRY");
    expect(result.request?.currencyExponent).toBe(2);
    expect(result.request?.baseline.sourceRunId)
      .toBe("44444444-4444-4444-8444-444444444444");
    expect(result.request?.baseline.sourceSnapshotId)
      .toBe("55555555-5555-4555-8555-555555555555");
  });

  it("binds the durable key to the proposal and claim, never to a D085 preview key", () => {
    const result = composeBudgetExecutionCandidate(sources());
    expect(result.request?.idempotencyKey).toBe(
      durableIdempotencyKeyFor({
        proposalId: PROPOSAL, claimToken: CLAIM,
        fingerprint: result.requestFingerprint!,
      }),
    );
    expect(result.request?.idempotencyKey).toContain(PROPOSAL);
    expect(result.request?.idempotencyKey).toContain(CLAIM);
    // D085's preview namespace must not appear anywhere in a durable identity.
    expect(result.request?.idempotencyKey).not.toContain("d085-preview");
  });

  it("changes the durable key when the request changes", () => {
    const a = composeBudgetExecutionCandidate(sources());
    const b = composeBudgetExecutionCandidate(sources({
      intent: { verb: "increase_budget", intendedAmountMinor: 280000, percent: 12 },
    }));
    expect(a.request?.idempotencyKey).not.toBe(b.request?.idempotencyKey);
  });

  it.each([
    ["no retained observation", { observations: [] }, "no_retained_observation"],
    ["an observation for another account",
      { observations: [observationRow({ provider_account_id: "act_999" })] },
      "observation_scope_mismatch"],
    ["an observation for another entity",
      { observations: [observationRow({ entity_id: "c_999", campaign_id: "c_999" })] },
      "observation_entity_mismatch"],
    ["an uncaptured exponent",
      { observations: [observationRow({ budget_currency_exponent: null })] },
      "canonical_fact_not_action_bearing"],
    ["an unobserved budget shape",
      { observations: [observationRow({ budget_shape_support: null })] },
      "canonical_fact_not_action_bearing"],
    ["an owner that is not proven",
      { observations: [observationRow({ budget_origin: null })] },
      "owner_mode_not_proven"],
    ["a generic label instead of an exact verb",
      { intent: { verb: "scale", intendedAmountMinor: 300000, percent: 20 } },
      "intent_verb_not_canonical"],
    ["no amount", { intent: { verb: "increase_budget", intendedAmountMinor: null, percent: 20 } },
      "intent_amount_absent"],
    ["a manual role", { role: { kind: "main", source: "manual", resolverVersion: "v2" } },
      "role_authority_not_automatic"],
    ["no retained profile", { profileRetained: false }, "profile_not_retained"],
    ["unread change history", { changeHistory: null }, "change_history_unknown"],
    ["no fresh provider baseline", { providerBaseline: null }, "provider_baseline_unavailable"],
    ["an unknown account time zone", { accountTimeZone: null }, "account_timezone_unknown"],
  ])("refuses %s with a named blocker and no request", (_label, over, blocker) => {
    const result = composeBudgetExecutionCandidate(sources(over as never));
    expect(result.blockers, JSON.stringify(over)).toContain(blocker);
    expect(result.request).toBeNull();
    expect(result.executable).toBe(false);
  });

  it("every blocker it can emit is declared", () => {
    const result = composeBudgetExecutionCandidate(sources({ observations: [] }));
    for (const blocker of result.blockers) {
      expect(D088_COMPOSITION_BLOCKERS).toContain(blocker);
    }
  });

  it("never reads a campaign name or a manual label", () => {
    const result = composeBudgetExecutionCandidate(sources({
      observations: [observationRow({
        entity_name: "TEST - scale me", campaign_label_status: "test",
      })],
    }));
    expect(JSON.stringify(result)).not.toContain("TEST - scale me");
    expect(JSON.stringify(result)).not.toContain("campaign_label_status");
  });

  it("is composed, not executed: it makes no provider call and returns no token", () => {
    const result = composeBudgetExecutionCandidate(sources());
    expect(JSON.stringify(result)).not.toMatch(/accessToken|Bearer|graph\.facebook/);
    // The composition root never claims a write happened.
    expect(result).not.toHaveProperty("providerOutcome");
  });
});
