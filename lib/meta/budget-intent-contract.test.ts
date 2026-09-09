import { describe, expect, it } from "vitest";

import {
  APPROVED_MAGNITUDE_ORIGIN,
  APPROVED_MAGNITUDE_PERCENTS,
  BUDGET_INTENT_REJECTIONS,
  BUDGET_OWNER_GRAINS,
  BUDGET_OWNER_GRAINS_ARE_DECISION_GRAINS,
  META_BUDGET_INTENT_CONTRACT_VERSION,
  META_BUDGET_INTENT_SEMANTIC_TUPLES,
  budgetIntentSemanticTupleSqlPredicate,
  isBudgetIntentSemanticTuple,
  budgetIntentIsExecutable,
  budgetIntentKey,
  CANONICAL_PAYLOAD_REQUIRED_FIELDS,
  toCanonicalDecisionAction,
  validateBudgetIntent,
  type BudgetIntentInput,
} from "@/lib/meta/budget-intent-contract";
import {
  assertCanonicalDecisionAction,
  type MetaOsDecisionAction,
} from "@/lib/meta/decisions-os-contract";
import { MUTATION_ENDPOINTS } from "@/lib/zero-base/meta/dispatch-contract";

const BINDINGS = [
  { businessId: "biz-1", providerAccountId: "act_1000000000001" },
  { businessId: "biz-2", providerAccountId: "act_2000000000002" },
];
const HASH = "a".repeat(64);

describe("budget recommendation semantic authority", () => {
  it("admits exactly the real type, owner-grain and direction tuples", () => {
    for (const tuple of META_BUDGET_INTENT_SEMANTIC_TUPLES) {
      expect(isBudgetIntentSemanticTuple(tuple), JSON.stringify(tuple)).toBe(true);
    }

    expect(isBudgetIntentSemanticTuple({
      recommendationType: "scenario_c1_controlled_scale",
      grain: "adset",
      direction: "increase",
    })).toBe(false);
    expect(isBudgetIntentSemanticTuple({
      recommendationType: "adset_scale_budget",
      grain: "campaign",
      direction: "increase",
    })).toBe(false);
    expect(isBudgetIntentSemanticTuple({
      recommendationType: "adset_scale_budget",
      grain: "adset",
      direction: "decrease",
    })).toBe(false);
    expect(isBudgetIntentSemanticTuple({
      recommendationType: "scale_for_volume",
      grain: "campaign",
      direction: "increase",
    })).toBe(false);
  });

  it("renders the same paired tuples for persistence and claim SQL", () => {
    const predicate = budgetIntentSemanticTupleSqlPredicate({
      recommendationTypeExpression: "d.rec_type",
      grainExpression: "d.scope_type",
      directionExpression: "d.target_value ->> 'direction'",
    });
    expect(predicate).toContain(
      "d.rec_type = 'scenario_c1_controlled_scale' AND d.scope_type = 'campaign' AND d.target_value ->> 'direction' = 'increase'",
    );
    expect(predicate).toContain(
      "d.rec_type = 'adset_scale_budget' AND d.scope_type = 'adset' AND d.target_value ->> 'direction' = 'increase'",
    );
    expect(predicate).toContain(
      "d.rec_type = 'scale_for_volume_budget_increase' AND d.scope_type = 'campaign' AND d.target_value ->> 'direction' = 'increase'",
    );
    expect(predicate).not.toContain(
      "d.rec_type = 'scale_for_volume' AND d.scope_type = 'campaign'",
    );
    expect(predicate).not.toContain(
      "d.rec_type = 'scenario_c1_controlled_scale' AND d.scope_type = 'adset'",
    );
  });
});

const campaignIntent = (over: Partial<BudgetIntentInput> = {}): BudgetIntentInput => ({
  contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
  scope: {
    businessId: "biz-1", providerAccountId: "act_1000000000001",
    entityGrain: "campaign", entityId: "c-1", parentCampaignId: null,
  },
  ownerMode: "campaign_budget_optimization",
  budgetField: "daily_budget",
  observedDailyMinorUnits: 100_000,
  observedLifetimeMinorUnits: null,
  lifetimeSchedule: null,
  direction: "increase",
  percent: 10,
  accountCurrency: "USD",
  originDate: "2026-08-01",
  effectiveAsOf: "2026-08-01",
  knowledgeAsOf: "2026-08-01",
  authorityEvidenceAsOf: "2026-07-28",
  maxAuthorityEvidenceAgeDays: 14,
  sourceFingerprints: { configStateHash: HASH, ownerStateHash: HASH, roleAuthorityHash: HASH },
  evidenceWindow: { from: "2026-07-25", to: "2026-07-31" },
  targetSource: { source: "business_target_pack_history", version: "2026-07-20" },
  authorityStatus: "authorised",
  blockerCodes: [],
  ...over,
});
const adsetIntent = (over: Partial<BudgetIntentInput> = {}): BudgetIntentInput =>
  campaignIntent({
    scope: {
      businessId: "biz-1", providerAccountId: "act_1000000000001",
      entityGrain: "adset", entityId: "a-1", parentCampaignId: "c-1",
    },
    ownerMode: "adset_budget",
    ...over,
  });
const check = (input: BudgetIntentInput) => validateBudgetIntent(input, BINDINGS);
const rejectionsOf = (input: BudgetIntentInput) => {
  const r = check(input);
  return r.status === "rejected" ? r.rejections : [];
};

describe("D081-A — the typed budget intent validates campaign- and ad-set-owned budgets", () => {
  it("accepts a campaign-owned daily budget", () => {
    const r = check(campaignIntent());
    expect(r.status).toBe("valid");
    if (r.status !== "valid") return;
    expect(r.intent.currentMinorUnits).toBe(100_000);
    expect(r.intent.proposedMinorUnits).toBe(110_000);
    expect(r.intent.deltaMinorUnits).toBe(10_000);
    expect(r.intent.currencyExponent).toBe(2);
    expect(r.intent.executionState).toBe("validated_only");
  });

  it("accepts an ad-set-owned daily budget with its parent campaign", () => {
    const r = check(adsetIntent());
    expect(r.status).toBe("valid");
    if (r.status !== "valid") return;
    expect(r.intent.scope.parentCampaignId).toBe("c-1");
    expect(r.intent.ownerMode).toBe("adset_budget");
  });

  it("accepts a lifetime budget only with a valid schedule", () => {
    const base = campaignIntent({
      budgetField: "lifetime_budget", observedDailyMinorUnits: null,
      observedLifetimeMinorUnits: 500_000,
    });
    expect(rejectionsOf(base)).toContain("lifetime_schedule_invalid");
    const scheduled = campaignIntent({
      budgetField: "lifetime_budget", observedDailyMinorUnits: null,
      observedLifetimeMinorUnits: 500_000,
      lifetimeSchedule: { startDate: "2026-07-01", endDate: "2026-09-30" },
    });
    expect(check(scheduled).status).toBe("valid");
    // A flight that already ended cannot receive a budget change.
    const expired = campaignIntent({
      budgetField: "lifetime_budget", observedDailyMinorUnits: null,
      observedLifetimeMinorUnits: 500_000,
      lifetimeSchedule: { startDate: "2026-05-01", endDate: "2026-06-01" },
    });
    expect(rejectionsOf(expired)).toContain("lifetime_schedule_invalid");
    // A backwards flight is refused.
    expect(rejectionsOf(campaignIntent({
      budgetField: "lifetime_budget", observedDailyMinorUnits: null, observedLifetimeMinorUnits: 500_000,
      lifetimeSchedule: { startDate: "2026-09-30", endDate: "2026-07-01" },
    }))).toContain("lifetime_schedule_invalid");
  });

  it("refuses a dual-field budget state outright", () => {
    expect(rejectionsOf(campaignIntent({ observedLifetimeMinorUnits: 500_000 })))
      .toContain("budget_field_ambiguous");
  });

  it("refuses CBO/ABO owner ambiguity and owner/grain mismatch", () => {
    expect(rejectionsOf(campaignIntent({ ownerMode: "unknown" }))).toContain("owner_mode_ambiguous");
    expect(rejectionsOf(campaignIntent({ ownerMode: "not_applicable" }))).toContain("owner_mode_ambiguous");
    // CBO money is owned at campaign grain; an ad-set intent may not claim it.
    expect(rejectionsOf(adsetIntent({ ownerMode: "campaign_budget_optimization" }))).toContain("owner_grain_mismatch");
    expect(rejectionsOf(campaignIntent({ ownerMode: "adset_budget" }))).toContain("owner_grain_mismatch");
  });

  it("refuses a missing current value and a non-integer amount", () => {
    expect(rejectionsOf(campaignIntent({ observedDailyMinorUnits: null }))).toContain("current_value_missing");
    expect(rejectionsOf(campaignIntent({ observedDailyMinorUnits: 100.5 })))
      .toContain("current_value_not_integer_minor_units");
  });

  it("refuses an unsupported grain", () => {
    const r = rejectionsOf(campaignIntent({
      scope: { businessId: "biz-1", providerAccountId: "act_1000000000001", entityGrain: "ad" as never, entityId: "ad-1", parentCampaignId: null },
    }));
    expect(r).toContain("grain_unsupported");
    expect([...BUDGET_OWNER_GRAINS]).toEqual(["campaign", "adset"]);
    expect(BUDGET_OWNER_GRAINS_ARE_DECISION_GRAINS).toBe(true);
  });
});

describe("D081-A — identity is composite and cross-pairing fails closed", () => {
  it("refuses a cross-paired business and account whose halves are each valid", () => {
    const r = rejectionsOf(campaignIntent({
      scope: { businessId: "biz-1", providerAccountId: "act_2000000000002", entityGrain: "campaign", entityId: "c-1", parentCampaignId: null },
    }));
    expect(r).toContain("scope_identity_cross_paired");
  });

  it("refuses an unknown pair and an incomplete scope", () => {
    expect(rejectionsOf(campaignIntent({
      scope: { businessId: "biz-x", providerAccountId: "act_x", entityGrain: "campaign", entityId: "c-1", parentCampaignId: null },
    }))).toContain("scope_identity_cross_paired");
    expect(rejectionsOf(campaignIntent({
      scope: { businessId: "", providerAccountId: "", entityGrain: "campaign", entityId: "", parentCampaignId: null },
    }))).toContain("scope_identity_unknown");
  });

  it("requires an ad set to name its parent and a campaign not to", () => {
    expect(rejectionsOf(adsetIntent({
      scope: { businessId: "biz-1", providerAccountId: "act_1000000000001", entityGrain: "adset", entityId: "a-1", parentCampaignId: null },
    }))).toContain("scope_identity_unknown");
    expect(rejectionsOf(campaignIntent({
      scope: { businessId: "biz-1", providerAccountId: "act_1000000000001", entityGrain: "campaign", entityId: "c-1", parentCampaignId: "c-9" },
    }))).toContain("scope_identity_unknown");
  });

  it("produces a stable, deterministic idempotency identity", () => {
    const a = check(campaignIntent());
    const b = check(campaignIntent());
    expect(a.status).toBe("valid");
    if (a.status !== "valid" || b.status !== "valid") return;
    // Deterministic re-derivation of the identical intent is stable.
    expect(a.intent.intentKey).toBe(b.intent.intentKey);
    expect(a.intent.idempotencyKey).toBe(a.intent.intentKey);
    expect(a.intent.intentKey).toMatch(/^meta\.budget-intent\.v1:[0-9a-f]{64}$/);
  });

  it("binds the exact operation, so materially different changes cannot collide", () => {
    const baseline = check(campaignIntent());
    if (baseline.status !== "valid") throw new Error("expected a valid baseline");
    const keyOf = (over: Partial<BudgetIntentInput>) => {
      const r = check(campaignIntent(over));
      if (r.status !== "valid") throw new Error(`expected valid for ${JSON.stringify(over)}`);
      return r.intent.intentKey;
    };
    // Same scope, field, direction, percent and origin — but a different amount
    // of money. Raising 100,000 by 10% and raising 900,000 by 10% are two
    // different movements and must never share an executable identity.
    expect(keyOf({ observedDailyMinorUnits: 900_000 })).not.toBe(baseline.intent.intentKey);
    // Different evidence behind the same numbers is a different operation too.
    expect(keyOf({
      sourceFingerprints: { configStateHash: "b".repeat(64), ownerStateHash: HASH, roleAuthorityHash: HASH },
    })).not.toBe(baseline.intent.intentKey);
    expect(keyOf({
      sourceFingerprints: { configStateHash: HASH, ownerStateHash: HASH, roleAuthorityHash: "c".repeat(64) },
    })).not.toBe(baseline.intent.intentKey);
    // And a different currency, even at the same nominal minor-unit amount.
    expect(keyOf({ accountCurrency: "TRY" })).not.toBe(baseline.intent.intentKey);
  });

  it("still separates every part of the composite scope and the policy rung", () => {
    const baseline = check(campaignIntent());
    if (baseline.status !== "valid") throw new Error("expected a valid baseline");
    const variants: Array<Partial<BudgetIntentInput>> = [
      { scope: { ...campaignIntent().scope, entityId: "c-2" } },
      { direction: "decrease" },
      { percent: 25 },
      // EVERY clock moves with the origin — the evidence window and the
      // authority stamp included. The earlier variant moved only the three
      // top-level clocks and left the window ending 2026-07-31 behind, which
      // is after a 2026-07-30 knowledge cutoff. It passed only because the
      // validator was not yet checking evidence against the intent's own
      // knowledge, so it read as an identity test while proving nothing.
      {
        originDate: "2026-07-30", effectiveAsOf: "2026-07-30", knowledgeAsOf: "2026-07-30",
        authorityEvidenceAsOf: "2026-07-27",
        evidenceWindow: { from: "2026-07-24", to: "2026-07-30" },
      },
    ];
    for (const over of variants) {
      const r = check(campaignIntent(over));
      if (r.status !== "valid") throw new Error(`expected valid for ${JSON.stringify(over)}`);
      expect(r.intent.intentKey, JSON.stringify(over)).not.toBe(baseline.intent.intentKey);
    }
  });
});

describe("D081-A — currency, units and rounding", () => {
  it("binds the resolved exponent and registry version into the intent", () => {
    const r = check(campaignIntent({ accountCurrency: "TRY" }));
    expect(r.status).toBe("valid");
    if (r.status !== "valid") return;
    expect(r.intent.currency).toBe("TRY");
    expect(r.intent.currencyExponent).toBe(2);
    expect(r.intent.currencyRegistry.version).toContain("iso4217");
  });

  it("handles zero- and three-decimal currencies without changing the integer math", () => {
    for (const [code, exponent] of [["JPY", 0], ["KWD", 3]] as const) {
      const r = check(campaignIntent({ accountCurrency: code }));
      expect(r.status, code).toBe("valid");
      if (r.status !== "valid") continue;
      expect(r.intent.currencyExponent).toBe(exponent);
      // Minor units are minor units whatever the exponent; only display differs.
      expect(r.intent.proposedMinorUnits).toBe(110_000);
    }
  });

  it("refuses an unknown or retired currency", () => {
    expect(rejectionsOf(campaignIntent({ accountCurrency: "XYZ" }))).toContain("currency_exponent_unknown");
    expect(rejectionsOf(campaignIntent({ accountCurrency: "" }))).toContain("currency_exponent_unknown");
    expect(rejectionsOf(campaignIntent({ accountCurrency: "TRL" }))).toContain("currency_retired");
  });

  it("records deterministic rounding evidence", () => {
    const r = check(campaignIntent({ observedDailyMinorUnits: 105, percent: 5 }));
    expect(r.status).toBe("valid");
    if (r.status !== "valid") return;
    expect(r.intent.proposedMinorUnits).toBe(110);
    expect(r.intent.rounding.applied).toBe(true);
    expect(r.intent.rounding.rule).toBe("half_up_away_from_zero");
    expect(r.intent.rounding.exactUnrounded).toBe("11025/100");
  });

  it("refuses an overflowing amount", () => {
    expect(rejectionsOf(campaignIntent({ observedDailyMinorUnits: Number.MAX_SAFE_INTEGER })))
      .toContain("proposal_overflows_minor_units");
  });

  it("refuses a magnitude outside the approved ladder", () => {
    for (const bad of [1, 7, 30, 100, 0, -10]) {
      expect(rejectionsOf(campaignIntent({ percent: bad })), String(bad)).toContain("percent_unapproved_magnitude");
    }
    for (const good of APPROVED_MAGNITUDE_PERCENTS) {
      expect(check(campaignIntent({ percent: good })).status, String(good)).toBe("valid");
    }
  });

  it("declares the ladder as unapproved proposed governance", () => {
    expect(APPROVED_MAGNITUDE_ORIGIN.origin).toBe("proposed_governance");
    expect(APPROVED_MAGNITUDE_ORIGIN.approvalState).toBe("unapproved");
    expect(APPROVED_MAGNITUDE_ORIGIN.approver).toBeNull();
  });
});

describe("D081-A — point-in-time clocks and provenance", () => {
  it("refuses evidence dated after the origin", () => {
    expect(rejectionsOf(campaignIntent({ authorityEvidenceAsOf: "2026-08-15" }))).toContain("authority_evidence_future");
    expect(rejectionsOf(campaignIntent({ knowledgeAsOf: "2026-08-15" }))).toContain("authority_evidence_future");
    expect(rejectionsOf(campaignIntent({ effectiveAsOf: "2026-08-15" }))).toContain("authority_evidence_future");
  });

  it("refuses stale authority evidence", () => {
    expect(rejectionsOf(campaignIntent({ authorityEvidenceAsOf: "2026-06-01" }))).toContain("authority_evidence_stale");
  });

  it("refuses an unreal date and a missing source fingerprint", () => {
    expect(rejectionsOf(campaignIntent({ originDate: "2026-02-31" }))).toContain("authority_evidence_stale");
    expect(rejectionsOf(campaignIntent({
      sourceFingerprints: { configStateHash: "nope", ownerStateHash: HASH, roleAuthorityHash: HASH },
    }))).toContain("identity_unstable");
  });

  it("carries rollback and read-back expectations on every valid intent", () => {
    const r = check(campaignIntent());
    expect(r.status).toBe("valid");
    if (r.status !== "valid") return;
    expect(r.intent.rollback).toEqual({ priorMinorUnits: 100_000, field: "daily_budget", operation: "restore_prior_amount" });
    expect(r.intent.readback).toEqual({ field: "daily_budget", expectedMinorUnits: 110_000, independentRead: true });
  });

  it("refuses an unsupported contract version", () => {
    expect(rejectionsOf(campaignIntent({ contractVersion: "meta.budget-intent.v0" })))
      .toContain("contract_version_unsupported");
  });

  it("reports every rejection it finds, not just the first", () => {
    const r = check(campaignIntent({
      ownerMode: "unknown", accountCurrency: "XYZ", percent: 3, observedDailyMinorUnits: null,
    }));
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") return;
    expect(r.rejections.length).toBeGreaterThanOrEqual(4);
    for (const code of r.rejections) expect(BUDGET_INTENT_REJECTIONS as readonly string[]).toContain(code);
  });
});

describe("D081-A — a validated intent is not executable", () => {
  it("never claims executability", () => {
    expect(budgetIntentIsExecutable()).toBe(false);
    const r = check(campaignIntent());
    if (r.status !== "valid") throw new Error("expected a valid intent");
    expect(r.intent.executionState).toBe("validated_only");
  });

  it("adds no budget verb to the dispatch contract", () => {
    // D080A: a proposal that can be raised and approved but never executed is
    // worse than none. No endpoint exists, and none is added here.
    const serialised = JSON.stringify(MUTATION_ENDPOINTS);
    expect(serialised).not.toContain("budget");
    for (const grain of Object.keys(MUTATION_ENDPOINTS)) {
      const actions = Object.keys((MUTATION_ENDPOINTS as Record<string, object>)[grain] ?? {});
      expect(actions).not.toContain("set_budget");
      expect(actions).not.toContain("budget");
    }
  });

  it("does not widen the automation proposal queue", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync("grep -n 'MetaAutomationProposalScope\\|proposalActionForDecision' lib/meta/automation-proposals.ts | head -5", { encoding: "utf8" });
    expect(out).toContain("MetaAutomationProposalScope");
    // The intent module must not import or write the proposal queue at all.
    const source = require("node:fs").readFileSync("lib/meta/budget-intent-contract.ts", "utf8");
    expect(source).not.toContain("automation-proposals");
    expect(source).not.toMatch(/INSERT|UPDATE|DELETE|getDb/);
  });

  it("performs no provider or database access", () => {
    const source = require("node:fs").readFileSync("lib/meta/budget-intent-contract.ts", "utf8");
    expect(source).not.toMatch(/fetch\(|graph\.facebook|axios|https?:\/\//);
    expect(source).not.toMatch(/\bsql`|runDbTransaction/);
  });
});

describe("D081 C1 — the budget intent is a member of the canonical decision vocabulary", () => {
  const validIntent = () => {
    const r = check(campaignIntent());
    if (r.status !== "valid") throw new Error("expected a valid intent");
    return r.intent;
  };

  it("produces a real canonical MetaOsDecisionAction", () => {
    const action: MetaOsDecisionAction = toCanonicalDecisionAction(validIntent());
    // Every field the existing contract requires is present and correctly typed.
    expect(typeof action.code).toBe("string");
    expect(typeof action.label).toBe("string");
    expect(action.targetLevel).toBe("campaign");
    expect(typeof action.scopeNote).toBe("string");
    // The discriminator makes it a member, not a parallel shape.
    expect(action.budgetIntent?.kind).toBe("budget_intent");
    expect(action.budgetIntent?.contractVersion).toBe(META_BUDGET_INTENT_CONTRACT_VERSION);
  });

  it("is served for review and can never be dispatched", () => {
    const action = toCanonicalDecisionAction(validIntent());
    expect(action.intent).toBe("review");
    expect(action.intent).not.toBe("execute");
    // No provider mutation verb, so no dispatcher can pick it up.
    expect(action.providerMutation).toBeNull();
    expect(action.budgetIntent?.executionState).toBe("validated_only");
    expect(action.scopeNote).toContain("not executable");
  });

  it("is lossless: every validated-intent binding travels into the payload", () => {
    const intent = validIntent();
    const payload = toCanonicalDecisionAction(intent).budgetIntent;
    // Independently reproduced: fifteen bindings were dropped, including the
    // scope, the clocks, the fingerprints and the rollback/read-back contract.
    const omitted = Object.keys(intent).filter((k) => !(k in payload));
    expect(omitted).toEqual([]);
    for (const field of CANONICAL_PAYLOAD_REQUIRED_FIELDS) {
      expect(payload, field).toHaveProperty(field);
    }
    // And each carried value equals the intent's, not a re-derivation.
    for (const key of Object.keys(intent) as Array<keyof typeof intent>) {
      expect(JSON.stringify((payload as unknown as Record<string, unknown>)[key]), key)
        .toBe(JSON.stringify(intent[key]));
    }
  });

  it("lets a consumer inspect authority and read-back without the producer", () => {
    const payload = toCanonicalDecisionAction(validIntent()).budgetIntent;
    expect(payload.scope.parentCampaignId).toBeDefined();
    expect(payload.scope.businessId).toBeTruthy();
    expect(payload.scope.providerAccountId).toBeTruthy();
    expect(payload.rollback.priorMinorUnits).toBe(payload.currentMinorUnits);
    expect(payload.readback.expectedMinorUnits).toBe(payload.proposedMinorUnits);
    expect(payload.readback.independentRead).toBe(true);
    expect(payload.rounding.exactUnrounded).toContain("/100");
    expect(payload.sourceFingerprints.configStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.currencyRegistry.version).toContain("iso4217");
    expect(payload.authorityEvidenceAsOf <= payload.originDate).toBe(true);
  });

  it("refuses an invalid budget branch at runtime, not just by convention", () => {
    const good = toCanonicalDecisionAction(validIntent());
    expect(() => assertCanonicalDecisionAction(good)).not.toThrow();
    // A payload paired with execute, a provider mutation, an ad target or a
    // disagreeing grain is refused — the combinations a JSON consumer could
    // otherwise construct.
    for (const [label, mutate] of [
      ["execute", (a: any) => { a.intent = "execute"; }],
      ["a provider mutation", (a: any) => { a.providerMutation = "pause"; }],
      ["an ad target level", (a: any) => { a.targetLevel = "ad"; }],
      ["a disagreeing grain", (a: any) => { a.targetLevel = "adset"; }],
      ["a forged discriminator", (a: any) => { a.budgetIntent.kind = "creative"; }],
      ["an escalated execution state", (a: any) => { a.budgetIntent.executionState = "applied"; }],
    ] as Array<[string, (a: any) => void]>) {
      const broken = JSON.parse(JSON.stringify(good));
      mutate(broken);
      expect(() => assertCanonicalDecisionAction(broken), label).toThrow(/D081 refuses/);
    }
  });

  it("refuses an ad-set budget action with no parent campaign", () => {
    const r = check(adsetIntent());
    if (r.status !== "valid") throw new Error("expected valid");
    const action = JSON.parse(JSON.stringify(toCanonicalDecisionAction(r.intent)));
    expect(() => assertCanonicalDecisionAction(action)).not.toThrow();
    action.budgetIntent.scope.parentCampaignId = null;
    expect(() => assertCanonicalDecisionAction(action)).toThrow(/parent campaign/);
  });

  it("carries the whole operation, not just a label", () => {
    const intent = validIntent();
    const payload = toCanonicalDecisionAction(intent).budgetIntent!;
    expect(payload.currentMinorUnits).toBe(intent.currentMinorUnits);
    expect(payload.proposedMinorUnits).toBe(intent.proposedMinorUnits);
    expect(payload.currency).toBe(intent.currency);
    expect(payload.currencyExponent).toBe(intent.currencyExponent);
    expect(payload.idempotencyKey).toBe(intent.idempotencyKey);
    expect(payload.scope.entityGrain).toBe(intent.scope.entityGrain);
  });

  it("keeps every existing creative and ad action byte-identical", () => {
    // The new field is optional, so an action built the way the surface already
    // builds one serializes exactly as it did before the field existed.
    const existing: MetaOsDecisionAction = {
      code: "pause_ad", label: "Pause this ad", intent: "execute",
      targetLevel: "ad", providerMutation: "pause", scopeNote: "ad 123",
    };
    expect(JSON.stringify(existing)).toBe(
      '{"code":"pause_ad","label":"Pause this ad","intent":"execute","targetLevel":"ad","providerMutation":"pause","scopeNote":"ad 123"}',
    );
    expect(Object.keys(existing)).not.toContain("budgetIntent");
    expect("budgetIntent" in existing).toBe(false);
  });

  it("lives alongside existing actions in one canonical list", () => {
    // A decision path returning a mixed list is exactly the integration the
    // detached type could not provide.
    const actions: MetaOsDecisionAction[] = [
      { code: "pause_ad", label: "Pause", intent: "execute", targetLevel: "ad", providerMutation: "pause", scopeNote: "ad 1" },
      { code: "review_creative", label: "Review", intent: "review", targetLevel: "ad", providerMutation: null, scopeNote: "ad 2" },
      toCanonicalDecisionAction(validIntent()),
    ];
    expect(actions).toHaveLength(3);
    const budgetActions = actions.filter((a) => a.budgetIntent?.kind === "budget_intent");
    expect(budgetActions).toHaveLength(1);
    // Only the budget member carries the payload; the others are untouched.
    for (const a of actions.filter((x) => x.budgetIntent === undefined)) {
      expect(a.providerMutation === null || typeof a.providerMutation === "string").toBe(true);
    }
    // And no budget action ever claims a provider mutation.
    for (const a of budgetActions) expect(a.providerMutation).toBeNull();
  });

  it("adds no dispatchable verb anywhere in the canonical surface", () => {
    // Comments are stripped: the contract's own prose explains that a budget
    // action carries no provider mutation, and a guard that tripped on the
    // explanation would be measuring the wrong thing.
    const contract = require("node:fs").readFileSync("lib/meta/decisions-os-contract.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // The declared union is unchanged: no budget verb was added.
    expect(contract).toContain('providerMutation: "pause" | "resume" | "apply_bid" | null;');
    const declarations = contract.match(/providerMutation:[^;]*;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    for (const d of declarations) expect(d).not.toContain("budget");
  });
});

describe("D081 C6 — evidence is bounded by the intent's OWN knowledge cutoff", () => {
  /*
    r6 checked every clock against the ORIGIN alone. An intent could therefore
    declare `knowledgeAsOf: 2026-08-01` while resting on effective and
    authority evidence stamped 2026-08-31 — a month of hindsight the intent
    claimed not to have — and validate. Each case below moves exactly ONE
    stamp past the cutoff and leaves every other binding coherent, so the
    named rejection is the only thing under test.
  */
  const knowledgeBound = (over: Partial<BudgetIntentInput> = {}): BudgetIntentInput =>
    campaignIntent({
      originDate: "2026-08-31", effectiveAsOf: "2026-08-01", knowledgeAsOf: "2026-08-01",
      authorityEvidenceAsOf: "2026-07-28", maxAuthorityEvidenceAgeDays: 40,
      evidenceWindow: { from: "2026-07-25", to: "2026-07-31" },
      ...over,
    });
  const reasonsOf = (input: BudgetIntentInput) => {
    const r = check(input);
    if (r.status === "valid") throw new Error("expected a rejection");
    return { codes: r.rejections, reasons: r.reasons };
  };

  it("accepts the baseline, where every stamp is at or before BOTH clocks", () => {
    expect(check(knowledgeBound()).status).toBe("valid");
  });

  it("rejects an effective date after the knowledge cutoff, though it is before the origin", () => {
    const r = reasonsOf(knowledgeBound({ effectiveAsOf: "2026-08-15" }));
    expect(r.codes).toContain("authority_evidence_future");
    expect(r.reasons.some((w) => w.includes("effectiveAsOf 2026-08-15") && w.includes("knowledge cutoff 2026-08-01"))).toBe(true);
  });

  it("rejects authority evidence after the knowledge cutoff, though it is before the origin", () => {
    const r = reasonsOf(knowledgeBound({ authorityEvidenceAsOf: "2026-08-20" }));
    expect(r.codes).toContain("authority_evidence_future");
    expect(r.reasons.some((w) => w.includes("authorityEvidenceAsOf 2026-08-20") && w.includes("knowledge cutoff 2026-08-01"))).toBe(true);
  });

  it("rejects an evidence window ending after the knowledge cutoff, though it ends before the origin", () => {
    const r = reasonsOf(knowledgeBound({ evidenceWindow: { from: "2026-07-25", to: "2026-08-10" } }));
    expect(r.codes).toContain("authority_evidence_future");
    expect(r.reasons.some((w) => w.includes("evidence window ends (2026-08-10)") && w.includes("knowledge cutoff 2026-08-01"))).toBe(true);
  });

  it("keeps the ORIGIN bound too, so neither clock replaces the other", () => {
    const r = reasonsOf(knowledgeBound({ knowledgeAsOf: "2026-09-30" }));
    expect(r.codes).toContain("authority_evidence_future");
    expect(r.reasons.some((w) => w.includes("knowledgeAsOf 2026-09-30") && w.includes("after the origin"))).toBe(true);
  });

  it("reproduces the exact r6 escape: a month of hindsight behind a stale cutoff", () => {
    // The literal reproduction from the Correction 6 report.
    const forged = campaignIntent({
      originDate: "2026-08-31", knowledgeAsOf: "2026-08-01",
      effectiveAsOf: "2026-08-31", authorityEvidenceAsOf: "2026-08-31",
      maxAuthorityEvidenceAgeDays: 40,
    });
    expect(check(forged).status).toBe("rejected");
    expect(reasonsOf(forged).codes).toContain("authority_evidence_future");
  });
});
