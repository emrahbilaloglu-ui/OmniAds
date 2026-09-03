/**
 * D087 — the Meta budget write capability, prepared and disabled.
 *
 * These cases are written before the implementation and each one names a way a
 * budget write could go wrong. The slice's whole claim is that a budget change
 * becomes *technically executable later*; nothing here may make one executable
 * now, so the disabled-by-default cases are as load-bearing as the schema ones.
 */
import { describe, expect, it } from "vitest";

import { MUTATION_ENDPOINTS } from "@/lib/zero-base/meta/dispatch-contract";
import { PROVIDER_CAPABILITY_TODAY } from "@/lib/meta/budget-proposal-dry-run";
import {
  BUDGET_MUTATION_PATHS,
  D087_BUDGET_TRANSPORT_CAPABILITY,
  D087_ACTIVATION_BLOCKERS,
  budgetTransportPathFor,
  budgetWriteIsActivated,
} from "@/lib/meta/budget-write-capability";
import {
  BUDGET_WRITE_REQUEST_CONTRACT,
  BUDGET_WRITE_REFUSALS,
  parseBudgetWriteRequest,
} from "@/lib/meta/budget-write-request";
import {
  BUDGET_WRITE_PREFLIGHT_BLOCKERS,
  evaluateBudgetWritePreflight,
} from "@/lib/meta/budget-write-preflight";

// ---------------------------------------------------------------------------
// Capability: the transport exists; the ceremony table is untouched.
// ---------------------------------------------------------------------------

describe("D087 capability — prepared transport, unchanged ceremony", () => {
  it("declares a real budget path for both owner grains and both fields", () => {
    expect(budgetTransportPathFor("campaign", "daily_budget")).toBeTruthy();
    expect(budgetTransportPathFor("campaign", "lifetime_budget")).toBeTruthy();
    expect(budgetTransportPathFor("adset", "daily_budget")).toBeTruthy();
    expect(budgetTransportPathFor("adset", "lifetime_budget")).toBeTruthy();
    expect(D087_BUDGET_TRANSPORT_CAPABILITY.supportedFields)
      .toEqual(["daily_budget", "lifetime_budget"]);
  });

  it("does NOT contradict D085: the operator ceremony table still has no budget action", () => {
    /*
      D085's `PROVIDER_CAPABILITY_TODAY.why` cites MUTATION_ENDPOINTS. D087 adds
      an execution transport, not an operator ceremony action — the UI in this
      slice offers no control and never chooses a magnitude — so that sentence
      has to stay literally true or the two contracts would disagree about the
      same table.
    */
    for (const grain of Object.keys(MUTATION_ENDPOINTS)) {
      const actions = Object.keys(
        MUTATION_ENDPOINTS[grain as keyof typeof MUTATION_ENDPOINTS] ?? {},
      );
      expect(actions, grain).not.toContain("budget");
    }
    expect(PROVIDER_CAPABILITY_TODAY.budgetEndpointExists).toBe(false);
    expect(PROVIDER_CAPABILITY_TODAY.source)
      .toContain("dispatch-contract.MUTATION_ENDPOINTS");
    // ...and D087 names its OWN source, so neither claim can be read as the other.
    expect(D087_BUDGET_TRANSPORT_CAPABILITY.source)
      .toContain("budget-write-capability.BUDGET_MUTATION_PATHS");
  });

  it("is NOT activated, and says exactly what is still off", () => {
    expect(budgetWriteIsActivated()).toBe(false);
    expect(D087_ACTIVATION_BLOCKERS.length).toBeGreaterThan(0);
    for (const blocker of D087_ACTIVATION_BLOCKERS) {
      expect(blocker.code).toMatch(/^[a-z0-9_]+$/);
      expect(blocker.why.length).toBeGreaterThan(20);
    }
  });

  it("names no path outside the Meta graph node-field shape", () => {
    for (const [, fields] of Object.entries(BUDGET_MUTATION_PATHS)) {
      for (const [, path] of Object.entries(fields)) {
        expect(path).toMatch(/^\{[a-zA-Z]+\}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Request schema: hostile-input totality.
// ---------------------------------------------------------------------------

const validRequest = () => ({
  contractVersion: BUDGET_WRITE_REQUEST_CONTRACT,
  proposalId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "d087:11111111-1111-4111-8111-111111111111:daily_budget:300000",
  actor: { userId: "22222222-2222-4222-8222-222222222222" },
  scope: {
    businessId: "33333333-3333-4333-8333-333333333333",
    providerAccountId: "act_770001",
    ownerGrain: "campaign" as const,
    entityId: "c_100",
    parentCampaignId: null,
  },
  ownerMode: "campaign_budget_optimization" as const,
  budgetField: "daily_budget" as const,
  intendedAmountMinor: 300000,
  currency: "TRY",
  currencyExponent: 2,
  currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
  baseline: {
    amountMinor: 250000,
    budgetField: "daily_budget" as const,
    capturedAt: "2026-08-30T09:06:00.000Z",
    sourceRunId: "44444444-4444-4444-8444-444444444444",
    sourceSnapshotId: "55555555-5555-4555-8555-555555555555",
    providerApiVersion: "v23.0",
  },
  evidenceAsOf: "2026-08-30T09:06:00.000Z",
});

describe("D087 request — total over hostile input", () => {
  it("accepts the canonical request", () => {
    const parsed = parseBudgetWriteRequest(validRequest());
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it.each([
    ["null", null, "request_not_an_object"],
    ["a string", "budget", "request_not_an_object"],
    ["an array", [], "request_not_an_object"],
    ["a number", 42, "request_not_an_object"],
  ])("refuses %s", (_label, value, code) => {
    const parsed = parseBudgetWriteRequest(value);
    expect(parsed.ok).toBe(false);
    expect((parsed as { code: string }).code).toBe(code);
  });

  it.each([
    ["a wrong contract version", { contractVersion: "meta.budget-write.v0" }, "contract_version_unrecognised"],
    ["an unknown extra field", { surpriseField: true }, "unknown_field_present"],
    ["a non-uuid proposal identity", { proposalId: "proposal-1" }, "invalid_proposal_identity"],
    ["an empty idempotency key", { idempotencyKey: "  " }, "invalid_idempotency_key"],
    ["a missing actor", { actor: null }, "actor_absent"],
    ["a blank business", { scope: { ...validRequest().scope, businessId: " " } }, "invalid_scope"],
    ["a blank account", { scope: { ...validRequest().scope, providerAccountId: "" } }, "invalid_scope"],
    ["an unknown owner grain", { scope: { ...validRequest().scope, ownerGrain: "ad" } }, "invalid_owner_grain"],
    ["an unknown owner mode", { ownerMode: "unknown" }, "owner_mode_not_proven"],
    ["a mixed owner mode", { ownerMode: "mixed" }, "owner_mode_not_proven"],
    ["an unsupported field", { budgetField: "bid_amount" }, "unsupported_budget_field"],
    ["a zero amount", { intendedAmountMinor: 0 }, "invalid_amount"],
    ["a negative amount", { intendedAmountMinor: -1 }, "invalid_amount"],
    ["a fractional amount", { intendedAmountMinor: 2500.5 }, "invalid_amount"],
    ["a string amount", { intendedAmountMinor: "300000" }, "invalid_amount"],
    ["an unsafe amount", { intendedAmountMinor: Number.MAX_SAFE_INTEGER + 2 }, "invalid_amount"],
    ["a missing currency", { currency: null }, "currency_not_retained"],
    ["a lowercase currency", { currency: "try" }, "currency_not_retained"],
    ["a missing exponent", { currencyExponent: null }, "exponent_not_retained"],
    ["a fractional exponent", { currencyExponent: 2.5 }, "exponent_not_retained"],
    ["an unversioned registry", { currencyRegistryVersion: "" }, "currency_registry_not_retained"],
    ["a missing baseline", { baseline: null }, "baseline_not_retained"],
    ["a baseline for another field",
      { baseline: { ...validRequest().baseline, budgetField: "lifetime_budget" } },
      "baseline_field_mismatch"],
    ["a baseline with no run identity",
      { baseline: { ...validRequest().baseline, sourceRunId: "" } }, "baseline_not_retained"],
    ["an unparseable evidence clock", { evidenceAsOf: "2026-02-30T00:00:00Z" }, "invalid_evidence_clock"],
  ])("refuses %s", (_label, patch, code) => {
    const parsed = parseBudgetWriteRequest({ ...validRequest(), ...(patch as object) });
    expect(parsed.ok, JSON.stringify(patch)).toBe(false);
    expect((parsed as { code: string }).code, JSON.stringify(patch)).toBe(code);
  });

  it("every refusal code is declared in the contract vocabulary", () => {
    const parsed = parseBudgetWriteRequest({ ...validRequest(), intendedAmountMinor: 0 });
    expect(BUDGET_WRITE_REFUSALS).toContain((parsed as { code: string }).code);
  });
});

// ---------------------------------------------------------------------------
// Owner and field mapping: CBO targets the campaign, ABO targets the ad set.
// ---------------------------------------------------------------------------

describe("D087 ownership — the Meta owner is the only legal target", () => {
  it("refuses a CBO budget aimed at an ad set", () => {
    const parsed = parseBudgetWriteRequest({
      ...validRequest(),
      ownerMode: "campaign_budget_optimization",
      scope: {
        ...validRequest().scope,
        ownerGrain: "adset", entityId: "a_10", parentCampaignId: "c_100",
      },
    });
    expect(parsed.ok).toBe(false);
    expect((parsed as { code: string }).code).toBe("owner_grain_mismatch");
  });

  it("refuses an ABO budget aimed at the campaign", () => {
    const parsed = parseBudgetWriteRequest({
      ...validRequest(), ownerMode: "adset_budget",
    });
    expect(parsed.ok).toBe(false);
    expect((parsed as { code: string }).code).toBe("owner_grain_mismatch");
  });

  it("accepts an ABO budget on its own ad set, with the parent named", () => {
    const parsed = parseBudgetWriteRequest({
      ...validRequest(), ownerMode: "adset_budget",
      scope: {
        ...validRequest().scope,
        ownerGrain: "adset", entityId: "a_20", parentCampaignId: "c_200",
      },
    });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it("refuses an ad-set target with no parent campaign", () => {
    const parsed = parseBudgetWriteRequest({
      ...validRequest(), ownerMode: "adset_budget",
      scope: {
        ...validRequest().scope,
        ownerGrain: "adset", entityId: "a_20", parentCampaignId: null,
      },
    });
    expect(parsed.ok).toBe(false);
    expect((parsed as { code: string }).code).toBe("parent_campaign_absent");
  });

  it("refuses an ad set that claims itself as its own parent", () => {
    const parsed = parseBudgetWriteRequest({
      ...validRequest(), ownerMode: "adset_budget",
      scope: {
        ...validRequest().scope,
        ownerGrain: "adset", entityId: "a_20", parentCampaignId: "a_20",
      },
    });
    expect(parsed.ok).toBe(false);
    expect((parsed as { code: string }).code).toBe("invalid_scope");
  });
});

// ---------------------------------------------------------------------------
// Preflight: unknown is refusal, and disabled is the default.
// ---------------------------------------------------------------------------

const okRequest = () => {
  const parsed = parseBudgetWriteRequest(validRequest());
  if (!parsed.ok) throw new Error(`fixture is not valid: ${JSON.stringify(parsed)}`);
  return parsed.request;
};

const preflightInput = (over: Record<string, unknown> = {}) => ({
  request: okRequest(),
  actor: {
    userId: "22222222-2222-4222-8222-222222222222",
    businessId: "33333333-3333-4333-8333-333333333333",
    authenticated: true,
    writeScopeBound: true,
    selectedProviderAccountId: "act_770001",
  },
  governance: {
    verified: true, writeBlocked: false, killSwitchEngaged: false, blockReason: null,
  },
  automationEnabled: false,
  capability: D087_BUDGET_TRANSPORT_CAPABILITY,
  providerBaseline: {
    entityId: "c_100",
    providerAccountId: "act_770001",
    budgetField: "daily_budget" as const,
    amountMinor: 250000,
    currency: "TRY",
    readAtMs: Date.parse("2026-08-30T09:50:00.000Z"),
  },
  policy: {
    maxChangePercent: 25,
    minHoursBetweenChanges: 12,
    maxChangesPer7d: 3,
    maxAccountConcentrationPercent: 40,
    maxBaselineAgeMinutes: 60,
    maxAmountMinor: 500000,
    currency: "TRY",
  },
  history: { lastChangeAtMs: null, changesInLast7d: 0, accountConcentrationPercent: 10 },
  nowMs: Date.parse("2026-08-30T10:00:00.000Z"),
  ...over,
});

describe("D087 preflight — refusal is the default answer", () => {
  it("REFUSES with automation disabled even when everything else is perfect", () => {
    const verdict = evaluateBudgetWritePreflight(preflightInput());
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toContain("automation_disabled");
    expect(verdict.mayCallProvider).toBe(false);
  });

  it("passes only when automation is explicitly enabled and nothing else objects", () => {
    const verdict = evaluateBudgetWritePreflight(preflightInput({ automationEnabled: true }));
    expect(verdict.blockers, verdict.blockers.join(",")).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.mayCallProvider).toBe(true);
  });

  it.each([
    ["an unauthenticated actor",
      { actor: { ...preflightInput().actor, authenticated: false } }, "actor_unauthenticated"],
    ["another business",
      { actor: { ...preflightInput().actor, businessId: "other" } }, "business_scope_mismatch"],
    ["another selected account",
      { actor: { ...preflightInput().actor, selectedProviderAccountId: "act_999" } },
      "account_scope_mismatch"],
    ["an unbound write scope",
      { actor: { ...preflightInput().actor, writeScopeBound: false } }, "write_scope_not_bound"],
    ["an engaged kill switch",
      { governance: { verified: true, writeBlocked: true, killSwitchEngaged: true, blockReason: "business_kill_switch" } },
      "kill_switch_engaged"],
    ["unverified governance",
      { governance: { verified: false, writeBlocked: false, killSwitchEngaged: false, blockReason: null } },
      "governance_unverified"],
    ["an absent capability",
      { capability: { ...D087_BUDGET_TRANSPORT_CAPABILITY, budgetEndpointExists: false } },
      "provider_capability_absent"],
    ["a capability that omits the field",
      { capability: { ...D087_BUDGET_TRANSPORT_CAPABILITY, supportedFields: ["lifetime_budget"] } },
      "provider_capability_absent"],
    ["a stale provider baseline",
      { providerBaseline: { ...preflightInput().providerBaseline, readAtMs: Date.parse("2026-08-30T06:00:00.000Z") } },
      "provider_baseline_stale"],
    ["a baseline read for another entity",
      { providerBaseline: { ...preflightInput().providerBaseline, entityId: "c_999" } },
      "provider_baseline_entity_mismatch"],
    ["a baseline read on another account",
      { providerBaseline: { ...preflightInput().providerBaseline, providerAccountId: "act_999" } },
      "provider_baseline_account_mismatch"],
    ["a baseline for another field",
      { providerBaseline: { ...preflightInput().providerBaseline, budgetField: "lifetime_budget" } },
      "provider_baseline_field_mismatch"],
    ["a baseline in another currency",
      { providerBaseline: { ...preflightInput().providerBaseline, currency: "USD" } },
      "provider_baseline_currency_mismatch"],
    ["a provider value that has moved since the proposal",
      { providerBaseline: { ...preflightInput().providerBaseline, amountMinor: 260000 } },
      "compare_and_set_mismatch"],
    ["an unreadable provider baseline", { providerBaseline: null }, "provider_baseline_unknown"],
    ["a magnitude above the policy limit",
      { policy: { ...preflightInput().policy, maxChangePercent: 5 } },
      "policy_magnitude_exceeded"],
    ["an intended amount above the monetary ceiling",
      { policy: { ...preflightInput().policy, maxAmountMinor: 299999 } },
      "policy_spend_ceiling_exceeded"],
    ["a monetary ceiling in another currency",
      { policy: { ...preflightInput().policy, currency: "USD" } },
      "policy_spend_ceiling_currency_mismatch"],
    ["a change inside the cooldown",
      { history: { ...preflightInput().history, lastChangeAtMs: Date.parse("2026-08-30T04:00:00.000Z") } },
      "policy_cooldown_active"],
    ["too many changes this week",
      { history: { ...preflightInput().history, changesInLast7d: 3 } },
      "policy_change_frequency_exceeded"],
    ["too much of the account in one entity",
      { history: { ...preflightInput().history, accountConcentrationPercent: 55 } },
      "policy_account_concentration_exceeded"],
    ["unknown history", { history: null }, "policy_history_unknown"],
    ["no policy at all", { policy: null }, "policy_unknown"],
  ])("refuses %s", (_label, over, blocker) => {
    const verdict = evaluateBudgetWritePreflight(
      preflightInput({ automationEnabled: true, ...over }),
    );
    expect(verdict.ok, JSON.stringify(over)).toBe(false);
    expect(verdict.blockers, JSON.stringify(over)).toContain(blocker);
    expect(verdict.mayCallProvider).toBe(false);
  });

  it("every blocker it can emit is declared in the vocabulary", () => {
    const verdict = evaluateBudgetWritePreflight(preflightInput());
    for (const blocker of verdict.blockers) {
      expect(BUDGET_WRITE_PREFLIGHT_BLOCKERS).toContain(blocker);
    }
  });

  it("treats an explicitly cleared spend ceiling as no ceiling", () => {
    const policy = {
      ...preflightInput().policy,
      maxAmountMinor: null,
      currency: null,
    };
    const verdict = evaluateBudgetWritePreflight(
      preflightInput({ automationEnabled: true, policy }),
    );
    expect(verdict.ok, JSON.stringify(verdict.blockers)).toBe(true);
    expect(verdict.blockers).not.toContain("policy_unknown");
  });

  it("fails closed on a half-persisted spend ceiling pair", () => {
    const verdict = evaluateBudgetWritePreflight(preflightInput({
      automationEnabled: true,
      policy: {
        ...preflightInput().policy,
        maxAmountMinor: null,
        currency: "TRY",
      },
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers).toContain("policy_unknown");
  });

  it("is TOTAL: a hostile input object still refuses rather than throwing", () => {
    const verdict = evaluateBudgetWritePreflight({
      request: okRequest(),
      actor: null, governance: null, automationEnabled: "yes",
      capability: null, providerBaseline: undefined, policy: undefined,
      history: undefined, nowMs: Number.NaN,
    } as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers.length).toBeGreaterThan(3);
  });
});
