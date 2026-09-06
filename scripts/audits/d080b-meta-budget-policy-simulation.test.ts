import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { D080_PINNED_BINDINGS, type PinnedBinding } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  ABSENCE_BLOCKERS,
  COVERAGE_BLOCKERS,
  CONDITIONAL_WAIVED_CODES,
  D080B_CONTRACT_ID,
  D080B_GATE_CODES,
  D080B_JSON_OUT,
  D080B_QUERIES,
  D080B_REQUIRED_SECTIONS,
  EVIDENCE_FLOORS,
  EVIDENCE_LANES,
  GATE_STAGES,
  HORIZON_DAYS,
  POLICY_DIRECTIONS,
  POLICY_LADDER_PERCENT,
  SIMULATION_WINDOW_DAYS,
  analyse,
  assertRequestIsInScope,
  buildFunnel,
  buildLeakageChecks,
  buildRequest,
  buildSyntheticStress,
  classifyObservedTransitions,
  discoverRowSets,
  evaluateExecutionAuthority,
  evaluateGates,
  isCalendarDate,
  planOrigins,
  proposeForCandidate,
  rawBudgetValue,
  sealArtifact,
  D080B_SECTION_HANDLERS,
  latestAtOrBefore,
  verifyArtifact,
  type PolicyInput,
} from "@/scripts/audits/d080b-meta-budget-policy-simulation";

const ARTIFACT = JSON.parse(readFileSync(resolve(D080B_JSON_OUT), "utf8")) as Record<string, any>;
const clone = () => JSON.parse(JSON.stringify(ARTIFACT)) as Record<string, any>;
const BINDING = D080_PINNED_BINDINGS[0]!;

/** A fully satisfiable input, so each test can remove exactly one thing. */
function healthy(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    origin: "2026-08-01",
    binding: BINDING,
    entityGrain: "campaign",
    entityId: "c-1",
    campaignId: "c-1",
    configAsOfOrigin: {
      effectiveFrom: "2026-07-25", dailyBudget: 100_000, lifetimeBudget: null,
      anyMixed: false, distinctFingerprints: 1,
      optimizationGoal: "OFFSITE_CONVERSIONS", bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      objective: "OUTCOME_SALES",
    },
    ownerAsOfOrigin: {
      observedOn: "2026-07-31", budgetOrigin: "campaign", budgetCurrency: "USD",
      configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE", presence: "present",
    },
    parentAsOfOrigin: null,
    trailing: { days: 7, spend: 700_000, conversions: 40, revenue: 2_100_000, spendDays: 7 },
    role: { inferredKind: "main", confidenceClass: "high", accountScoped: true },
    anchor: { targetRoas: 2, breakEvenRoas: 1.4, effectiveAt: "2026-07-20", ageDays: 12 },
    currencyExponentSources: 1,
    recentChanges: [],
    budgetVerbRows: 1,
    caps: { businessProposals: 0, fleetProposals: 0, accountExposureShare: 0 },
    lane: "strict_pit_authority",
    ...over,
  };
}
const blockersFor = (over: Partial<PolicyInput>, pct = 10, dir: "increase" | "decrease" = "increase") =>
  evaluateGates(healthy(over), pct, dir).blockers;

describe("D080B — the control input, so every later test removes exactly one thing", () => {
  it("passes every gate when nothing is missing", () => {
    expect(blockersFor({})).toEqual([]);
    expect(blockersFor({}, 10, "decrease")).toEqual([]);
  });

  it("declares every gate code it can emit", () => {
    const emitted = new Set<string>();
    for (const c of buildSyntheticStress()) {
      for (const b of [...(c.increase_blockers as string[]), ...(c.decrease_blockers as string[])]) emitted.add(b);
    }
    for (const code of emitted) expect(D080B_GATE_CODES as readonly string[]).toContain(code);
  });

  it("keeps the gate stages a partition of the gate codes", () => {
    const staged = GATE_STAGES.flatMap((s) => s.codes);
    expect(new Set(staged).size, "no gate is staged twice").toBe(staged.length);
    expect([...staged].sort()).toEqual([...D080B_GATE_CODES].sort());
  });
});

describe("D080B — point-in-time correctness", () => {
  it("never lets a later fact reach the engine", () => {
    // The engine is pure in its input, so PIT correctness lives in the as-of
    // selector. These prove the selector, not the engine.
    const rows = [
      { d: "2026-07-01", v: "early" }, { d: "2026-07-20", v: "wanted" },
      { d: "2026-08-15", v: "later" }, { d: "2026-12-31", v: "much_later" },
    ];
    const pick = (on: string) => {
      let best: (typeof rows)[number] | null = null;
      for (const r of rows) if (r.d <= on && (best === null || r.d > best.d)) best = r;
      return best;
    };
    expect(pick("2026-08-01")?.v).toBe("wanted");
    expect(pick("2026-06-01")).toBeNull();
  });

  it("publishes an explicit leakage check for every later-fact family", () => {
    // The v1 form of this test asserted only that the pure engine changes when
    // handed a later fact, which said nothing about the selector. It now
    // asserts the selector boundary; the detailed proofs live in the C5 block.
    const checks = buildLeakageChecks();
    expect(checks.length).toBeGreaterThanOrEqual(5);
    for (const c of checks) {
      expect(c.later_fact_visible_at_origin, String(c.check)).toBe(false);
      expect(c.decision_unchanged_at_origin, String(c.check)).toBe(true);
    }
    expect(checks.map((c) => c.check)).toContain("later_commercial_target");
    expect(checks.map((c) => c.check)).toContain("later_owner_observation");
  });

  it("bounds the origin axis to the window that was actually read", () => {
    const origins = planOrigins("2026-05-01", "2026-08-21");
    expect(origins.length).toBeGreaterThan(0);
    for (const o of origins) {
      expect(o.origin >= "2026-05-01").toBe(true);
      expect(o.origin <= "2026-08-21").toBe(true);
    }
    // A horizon is supported only when its outcome window fits.
    const last = origins[origins.length - 1]!;
    expect(last.supportedHorizons.length).toBeLessThan(HORIZON_DAYS.length);
    expect(last.unsupportedHorizons.length).toBeGreaterThan(0);
    for (const u of last.unsupportedHorizons) expect(String(u.why)).toContain("retained day");
  });

  it("walks folds forward without overlapping", () => {
    const origins = planOrigins("2026-05-01", "2026-08-21");
    const folds = [...new Set(origins.map((o) => o.fold))].sort();
    for (const f of folds) {
      const inFold = origins.filter((o) => o.fold === f).map((o) => o.origin).sort();
      const others = origins.filter((o) => o.fold !== f).map((o) => o.origin);
      for (const o of inFold) expect(others).not.toContain(o);
    }
  });
});

describe("D080B — the request boundary", () => {
  const good = () => buildRequest({
    planKey: "configStates", statement: D080B_QUERIES.bindings, params: [BINDING.businessId],
    source: "meta_campaign_config_history", lane: "strict_pit_authority",
    businessId: BINDING.businessId, providerAccountId: BINDING.providerAccountId,
    grain: "campaign", effectiveFrom: "2026-05-01", effectiveTo: "2026-08-21",
  });

  it("accepts a pinned, well-formed request", () => {
    expect(() => assertRequestIsInScope(good())).not.toThrow();
  });

  it.each([
    ["an unpinned business", { businessId: "forged-business" }],
    ["a cross-paired account", { providerAccountId: D080_PINNED_BINDINGS[1]!.providerAccountId }],
    ["a backwards window", { effectiveFrom: "2026-09-01" }],
    ["an impossible date", { effectiveTo: "2026-02-31" }],
    ["a forged statement hash", { statementSha256: "0".repeat(64) }],
    ["a forged params hash", { paramsSha256: "0".repeat(64) }],
    ["the synthetic lane", { lane: "synthetic_stress_only" as const }],
  ])("refuses %s", (_label, over) => {
    expect(() => assertRequestIsInScope({ ...good(), ...over } as never)).toThrow(/D080B refuses to execute/);
  });

  it("gives two reads of different sources distinct identities", () => {
    const a = buildRequest({ planKey: "sourceClock", statement: "SELECT 1", params: [], source: "meta_campaign_daily", lane: "strict_pit_authority", businessId: BINDING.businessId, providerAccountId: BINDING.providerAccountId, grain: "campaign" });
    const b = buildRequest({ planKey: "sourceClock", statement: "SELECT 1", params: [], source: "meta_campaign_config_history", lane: "strict_pit_authority", businessId: BINDING.businessId, providerAccountId: BINDING.providerAccountId, grain: "campaign" });
    expect(a.invocationKey).not.toBe(b.invocationKey);
  });

  it("refuses to read when execution authority is present", () => {
    expect(evaluateExecutionAuthority({}, {}).ok).toBe(true);
    expect(evaluateExecutionAuthority({ ENABLE_META_WRITES: "1" }, {}).ok).toBe(false);
    expect(evaluateExecutionAuthority({}, { ENABLE_AUTOMATION: "true" }).ok).toBe(false);
    expect(evaluateExecutionAuthority({}, { ENABLE_AUTOMATION: "0" }).ok).toBe(true);
  });
});

describe("D080B — each gate blocks for its own reason, and nothing else", () => {
  it.each([
    ["owner evidence absent", { ownerAsOfOrigin: null }, "owner_evidence_absent"],
    ["owner mode not applicable", { ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, budgetOrigin: "not_applicable" } }, "owner_mode_ambiguous"],
    ["money owned at the other grain", { ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, budgetOrigin: "adset" } }, "owner_mode_ambiguous"],
    ["both budget fields set", { configAsOfOrigin: { ...healthy().configAsOfOrigin!, lifetimeBudget: 500_000 } }, "budget_field_ambiguous"],
    ["budget-mixed capture", { configAsOfOrigin: { ...healthy().configAsOfOrigin!, anyMixed: true } }, "budget_field_ambiguous"],
    ["disagreeing captures", { configAsOfOrigin: { ...healthy().configAsOfOrigin!, distinctFingerprints: 2 } }, "conflicting_transition"],
    ["lifetime with no schedule", { configAsOfOrigin: { ...healthy().configAsOfOrigin!, dailyBudget: null, lifetimeBudget: 400_000 } }, "lifetime_schedule_unretained"],
    ["no retained config", { configAsOfOrigin: null }, "budget_value_absent"],
    ["no exponent source", { currencyExponentSources: 0 }, "unit_exponent_unknown"],
    ["status not active", { ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, effectiveStatus: "WITH_ISSUES" } }, "status_not_active"],
    ["objective identity unknown", { configAsOfOrigin: { ...healthy().configAsOfOrigin!, bidStrategy: null } }, "objective_identity_unknown"],
    ["role without account scope", { role: { inferredKind: "main", confidenceClass: "high", accountScoped: false } }, "role_authority_absent"],
    ["no commercial anchor", { anchor: null }, "commercial_target_absent"],
    ["stale commercial anchor", { anchor: { targetRoas: 2, breakEvenRoas: 1.4, effectiveAt: "2026-01-01", ageDays: 212 } }, "commercial_target_stale"],
    ["no typed budget verb", { budgetVerbRows: 0 }, "decision_vocabulary_absent"],
    ["too few spend days", { trailing: { days: 7, spend: 10, conversions: 1, revenue: 1, spendDays: 1 } }, "spend_evidence_floor"],
    ["stale observation", { ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, observedOn: "2026-07-01" } }, "observation_stale"],
    ["recent change", { recentChanges: [{ effectiveFrom: "2026-07-30", direction: "increase" as const }] }, "recent_change_cooldown"],
    ["business cap reached", { caps: { businessProposals: 99, fleetProposals: 0, accountExposureShare: 0 } }, "business_cap"],
    ["fleet cap reached", { caps: { businessProposals: 0, fleetProposals: 99, accountExposureShare: 0 } }, "fleet_cap"],
    ["concentration cap", { caps: { businessProposals: 0, fleetProposals: 0, accountExposureShare: 0.9 } }, "concentration_cap"],
    ["CAS drift", { stress: { casDrift: true } }, "cas_drift"],
    ["ambiguous provider outcome", { stress: { ambiguousOutcome: true } }, "ambiguous_provider_outcome"],
    ["idempotency collision", { stress: { idempotencyCollision: true } }, "idempotency_collision"],
    ["unbounded rollback", { stress: { rollbackUnbounded: true } }, "rollback_exposure_unbounded"],
    ["kill switch", { stress: { killSwitch: true } }, "kill_switch_block"],
  ])("blocks %s with %s", (_label, over, code) => {
    const blockers = blockersFor(over as Partial<PolicyInput>);
    expect(blockers, `expected ${code}, got ${JSON.stringify(blockers)}`).toContain(code);
  });

  it("blocks a deselected account, which is reference-only and never action scope", () => {
    const deselected = { ...BINDING, isSelected: false } as PinnedBinding;
    expect(blockersFor({ binding: deselected })).toContain("account_not_selected");
  });

  it("blocks an ad set under a non-active parent, and one with no parent evidence", () => {
    const adset = { entityGrain: "adset" as const, ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, budgetOrigin: "adset" } };
    expect(blockersFor({ ...adset, parentAsOfOrigin: { configuredStatus: "PAUSED", effectiveStatus: "PAUSED" } })).toContain("parent_not_active");
    expect(blockersFor({ ...adset, parentAsOfOrigin: null })).toContain("parent_not_active");
    expect(blockersFor({ ...adset, parentAsOfOrigin: { configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE" } })).toEqual([]);
  });

  it("blocks oscillation only when retained changes actually reverse", () => {
    const oneWay = [{ effectiveFrom: "2026-07-01", direction: "increase" as const }, { effectiveFrom: "2026-07-10", direction: "increase" as const }];
    const reversing = [{ effectiveFrom: "2026-07-01", direction: "increase" as const }, { effectiveFrom: "2026-07-10", direction: "decrease" as const }];
    expect(blockersFor({ recentChanges: oneWay })).not.toContain("oscillation_risk");
    expect(blockersFor({ recentChanges: reversing })).toContain("oscillation_risk");
    // Unresolved directions must never be read as a reversal.
    const unresolved = [{ effectiveFrom: "2026-07-01", direction: "unresolved" as const }, { effectiveFrom: "2026-07-10", direction: "increase" as const }];
    expect(blockersFor({ recentChanges: unresolved })).not.toContain("oscillation_risk");
  });

  it("applies the increase-only gates to increases only", () => {
    const noConversions = { trailing: { days: 7, spend: 700_000, conversions: 0, revenue: 0, spendDays: 7 } };
    expect(blockersFor(noConversions, 10, "increase")).toContain("conversion_evidence_floor");
    expect(blockersFor(noConversions, 10, "decrease")).not.toContain("conversion_evidence_floor");
    const noTarget = { anchor: { targetRoas: null, breakEvenRoas: 1.4, effectiveAt: "2026-07-20", ageDays: 12 } };
    expect(blockersFor(noTarget, 10, "increase")).toContain("commercial_target_absent");
    expect(blockersFor(noTarget, 10, "decrease")).not.toContain("commercial_target_absent");
  });

  it("refuses to test budget-binding when the unit is unconvertible", () => {
    // Spend is in account currency and the budget is a raw provider amount. With
    // no exponent, comparing them would be an assumption dressed as a test.
    const b = blockersFor({ currencyExponentSources: 0 });
    expect(b).toContain("unit_exponent_unknown");
    expect(b).toContain("budget_not_binding");
    const reasons = evaluateGates(healthy({ currencyExponentSources: 0 }), 10, "increase").reasons;
    expect(reasons.join(" ")).toContain("unconvertible raw unit");
  });

  it("treats the state-history zero sentinel as absent, not as a real budget", () => {
    expect(rawBudgetValue("0")).toBeNull();
    expect(rawBudgetValue(null)).toBeNull();
    expect(rawBudgetValue("300000")).toBe(300_000);
  });

  it("separates a missing fact from a fact that fails a rule", () => {
    const absent = proposeForCandidate(healthy({ ownerAsOfOrigin: null, configAsOfOrigin: null, anchor: null, role: null, currencyExponentSources: 0, budgetVerbRows: 0 }), 10, "decrease", "h");
    expect(absent.eligibility).toBe("not_determinable");
    const failing = proposeForCandidate(healthy({ ownerAsOfOrigin: { ...healthy().ownerAsOfOrigin!, effectiveStatus: "PAUSED" } }), 10, "increase", "h");
    expect(failing.eligibility).toBe("blocked");
    expect(proposeForCandidate(healthy(), 10, "increase", "h").eligibility).toBe("eligible");
  });

  it("emits no proposed amount unless the candidate is eligible", () => {
    const blocked = proposeForCandidate(healthy({ role: null }), 10, "increase", "h");
    expect(blocked.proposedRawAmount).toBeNull();
    expect(blocked.rawDelta).toBeNull();
    expect(blocked.action).toBe("no_proposal");
    const ok = proposeForCandidate(healthy(), 10, "increase", "h");
    expect(ok.proposedRawAmount).toBe(110_000);
    expect(ok.rawDelta).toBe(10_000);
  });

  it("carries no executable field on any proposal", () => {
    const p = proposeForCandidate(healthy(), 10, "increase", "h") as unknown as Record<string, unknown>;
    for (const forbidden of ["idempotencyKey", "approvalHash", "dispatch", "executable", "authorizedAction"]) {
      expect(Object.keys(p)).not.toContain(forbidden);
    }
    expect(p.action).toBe("propose_budget_change");
  });
});

describe("D080B — lanes never blend", () => {
  it("keeps the synthetic lane out of the database and out of real denominators", () => {
    const stress = buildSyntheticStress();
    expect(stress.length).toBeGreaterThanOrEqual(20);
    for (const row of stress) {
      expect(row.lane).toBe("synthetic_stress_only");
      // A fixture without a stated purpose reads as a verdict about real data.
      expect(String(row.proves).length, String(row.case)).toBeGreaterThan(20);
      expect(row.proves).not.toBe("unlabelled fixture");
    }
    expect(ARTIFACT.evidenceLanes.syntheticRowCount).toBe(stress.length);
    expect(ARTIFACT.evidenceLanes.realDataDenominator).not.toBe(stress.length);
    for (const entry of ARTIFACT.provenance.readLedger) {
      expect(entry.lane).not.toBe("synthetic_stress_only");
    }
  });

  it("keeps the conditional lane separate and names every waiver", () => {
    const cond = ARTIFACT.measurements.conditionalLane;
    expect(cond.lane).toBe("retrospective_finalized_conditional");
    expect(cond.waivers.map((w: any) => w.code).sort()).toEqual([...CONDITIONAL_WAIVED_CODES].sort());
    for (const w of cond.waivers) expect(String(w.assumption).length).toBeGreaterThan(20);
    // A waived code can never appear in the conditional census: waiving it is
    // exactly what the lane does.
    for (const code of CONDITIONAL_WAIVED_CODES) expect(Object.keys(cond.blockerCensus)).not.toContain(code);
    // And it must still appear in the authority lane, where nothing is waived.
    for (const code of CONDITIONAL_WAIVED_CODES) expect(Object.keys(ARTIFACT.measurements.blockerCensus)).toContain(code);
  });

  it("never lets the conditional lane claim action authority", () => {
    expect(String(ARTIFACT.measurements.conditionalLane.note)).toContain("never be served as action authority");
    expect(ARTIFACT.evidenceLanes.lanes).toEqual([...EVIDENCE_LANES]);
  });
});

describe("C1 — the fifteen independently authored lies that v1 accepted", () => {
  const attack = (mutate: (a: Record<string, any>) => void) => {
    const a = clone();
    mutate(a);
    return verifyArtifact(sealArtifact(a));
  };
  const reasonsOf = (r: ReturnType<typeof verifyArtifact>) =>
    r.failures.map((f) => (f.match(/: ([a-z_]+) \(/) ?? [])[1] ?? f).join(" ");

  it("full-package positive control: the shipped real snapshot verifies", () => {
    const r = verifyArtifact(clone());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counters.frozenReads).toBe(95);
    expect(r.counters.proposalsReplayed).toBe(247_050);
  });

  it.each([
    ["1 — forged entityUniverse entity id", (a: any) => { a.entityUniverse[0].entity_id = "forged-entity"; }, "derived_output_mismatch"],
    ["2 — denominator 247050 to 1", (a: any) => { a.measurements.denominators.proposalsEvaluated = 1; }, "denominator_not_recomputable"],
    ["3 — removed origin", (a: any) => { a.origins.pop(); }, "derived_output_mismatch"],
    ["4 — forged funnel survivor", (a: any) => { a.measurements.conditionalLane.funnel[2].survivors = 999_999; }, "derived_output_mismatch"],
    ["5 — erased performance reads", (a: any) => { a.snapshot.reads = a.snapshot.reads.filter((r: any) => r.planKey !== "performanceDaily"); }, "snapshot_hash_mismatch"],
    ["6 — cross-paired account on a read", (a: any) => { a.snapshot.reads.find((r: any) => r.planKey === "roleContext").providerAccountId = "act_921275999286619"; }, "identity_not_pinned"],
    ["7 — removed ledger invocation", (a: any) => { a.provenance.readLedger.splice(3, 1); }, "invocation_set_mismatch"],
    ["8 — ledger row count 999999", (a: any) => { a.provenance.readLedger[10].rows = 999_999; }, "slice_count_mismatch"],
    ["9 — replaced ledger source-row hash", (a: any) => { a.provenance.readLedger[10].sourceRowHash = "b".repeat(64); }, "slice_hash_mismatch"],
    ["10 — replaced queryContractSha256", (a: any) => { a.provenance.queryContractSha256 = "c".repeat(64); }, "query_contract_mismatch"],
    ["11 — replaced the pinned D080A hash", (a: any) => { a.provenance.pinnedInputHashes.d080aArtifact = "d".repeat(64); }, "predecessor_hash_mismatch"],
    ["12 — cutoff moved to 2099", (a: any) => { a.window.perBinding[0].cutoff = "2099-01-01"; }, "derived_output_mismatch"],
    ["13 — flipped transition plus decremented total", (a: any) => {
      const i = a.observedTransitions.findIndex((t: any) => t.semantics === "resolved");
      a.observedTransitions[i].semantics = "unresolved";
      a.measurements.observedTransitionSummary.resolved -= 1;
    }, "derived_output_mismatch"],
    ["14 — erased conditional waivers", (a: any) => { a.measurements.conditionalLane.waivers = []; }, "waivers_mismatch"],
    ["15 — erased leakage checks", (a: any) => { a.leakageChecks = []; }, "derived_output_mismatch"],
  ])("rejects lie %s", (_label, mutate, reason) => {
    const r = attack(mutate as (a: Record<string, any>) => void);
    expect(r.ok).toBe(false);
    expect(reasonsOf(r)).toContain(reason);
    // Never a stale hash alone: a semantic section must have objected.
    const semantic = r.failures.filter((f) => !f.includes("section_hash_mismatch") && !f.includes("artifact_hash_mismatch"));
    expect(semantic.length, JSON.stringify(r.failures.slice(0, 2))).toBeGreaterThan(0);
  /*
    90 s per case, matching this block's REAL cost rather than the 15 s default.

    Each of the fifteen attacks re-verifies a distinct mutation of the sealed
    package, and verification replays 247,050 proposals — the positive control
    above asserts that number. The work is irreducible per case: every attack
    mutates a different field, so nothing can be hoisted and shared without
    verifying something other than what the case is about.

    Measured under a loaded full-suite sweep, individual cases cost 11.1 s,
    12.0 s, 11.2 s, 13.6 s, 12.6 s, 11.6 s, 14.5 s and 12.4 s, with one case
    reaching 16.9 s. Against a 15 s default that is a load-sensitive flake, not
    a bug: standalone the file is 116/116 in about 170 s and green. A release
    must not be intermittently red, so the bound is raised to the real cost.

    This is the bound the sibling evidence suite already uses for the same class
    of work (`d084-commercial-target-evidence.test.ts` runs its cases at
    90_000). Nothing about coverage or the assertions above changes: same
    fifteen attacks, same expectations, no case merged, skipped or weakened.
  */
  }, 90_000);

  it.each([
    ["a smuggled stable field on a read", (a: any) => { a.snapshot.reads[0].smuggled = 1; }, "read_unexpected_field"],
    ["a missing required field on a read", (a: any) => { delete a.snapshot.reads[0].lane; }, "read_field_missing"],
    ["an unregistered new section", (a: any) => { a.brandNewSection = [{ a: 1 }]; }, "unhandled_row_bearing_section"],
    ["a duplicated ledger invocation", (a: any) => { a.provenance.readLedger.push({ ...a.provenance.readLedger[0] }); }, "duplicate_invocation"],
    ["an unexpected extra invocation", (a: any) => { a.provenance.readLedger.push({ ...a.provenance.readLedger[0], invocationKey: "invented#x" }); }, "invocation_set_mismatch"],
    ["a forged ledger grain", (a: any) => { a.provenance.readLedger.find((l: any) => l.grain === "campaign").grain = "adset"; }, "envelope_mismatch"],
    ["a forged ledger identity", (a: any) => { a.provenance.readLedger.find((l: any) => l.providerAccountId).providerAccountId = "act_921275999286619"; }, "envelope_mismatch"],
    ["a non-digest statement hash", (a: any) => { a.provenance.readLedger[5].statementSha256 = "not-a-hash"; }, "envelope_mismatch"],
    ["a forged read time bound", (a: any) => { a.snapshot.reads.find((r: any) => r.planKey === "configStates").knowledgeTo = "2099-01-01"; }, "envelope_mismatch"],
    ["an impossible read date", (a: any) => { a.snapshot.reads.find((r: any) => r.planKey === "configStates").effectiveFrom = "2026-02-31"; }, "read_time_invalid"],
    ["an invented readFailures row", (a: any) => { a.provenance.readFailures = [{ invocationKey: "x" }]; }, "read_failure_multiset_mismatch"],
    ["a forged proposal sample", (a: any) => { a.proposalSample[0].eligibility = "eligible"; }, "derived_output_mismatch"],
    ["an asserted causal lift", (a: any) => { a.measurements.causalClaims.roasLift = 1.4; }, "causal_claim_present"],
    ["a forged analysis hash", (a: any) => { a.provenance.analysisHash = "0".repeat(64); }, "analysis_hash_mismatch"],
    ["a dropped pinned binding", (a: any) => { a.scope.pinnedBindings.pop(); }, "scope_mismatch"],
    ["a flipped selection flag", (a: any) => { a.scope.pinnedBindings[4].is_selected = true; }, "scope_mismatch"],
    ["merged accounts inside a business", (a: any) => { a.scope.pinnedBindings[4].provider_account_id = a.scope.pinnedBindings[3].provider_account_id; }, "scope_mismatch"],
    ["a mutated snapshot row", (a: any) => { a.snapshot.reads.find((r: any) => r.planKey === "configStates").rows[0].daily_budget = 1; }, "snapshot_hash_mismatch"],
    ["a coordinated snapshot plus derived lie", (a: any) => {
      const read = a.snapshot.reads.find((r: any) => r.planKey === "configStates");
      read.rows[0].daily_budget = 1;
      a.snapshot.snapshotHash = "e".repeat(64);
      a.provenance.snapshotHash = "e".repeat(64);
    }, "snapshot_hash_mismatch"],
    ["an altered leakage check", (a: any) => { a.leakageChecks[0].decision_unchanged_at_origin = false; }, "derived_output_mismatch"],
    ["an altered stress fixture", (a: any) => { a.syntheticStress[0].increase_eligible = false; }, "derived_output_mismatch"],
    ["a forged breakdown", (a: any) => { a.measurements.byBusiness.Grandmix.eligible = 5; }, "derived_output_mismatch"],
    ["a forged exposure figure", (a: any) => { a.measurements.exposure.grossRawExposure = 1_000; }, "derived_output_mismatch"],
  ])("rejects %s", (_label, mutate, reason) => {
    const r = attack(mutate as (a: Record<string, any>) => void);
    expect(r.ok).toBe(false);
    expect(reasonsOf(r), JSON.stringify(r.failures.slice(0, 2))).toContain(reason);
  });

  it("publishes what each section handler actually checked", () => {
    const r = verifyArtifact(clone());
    expect(r.sectionAudits.length).toBe(r.discoveredRowSets.length);
    for (const audit of r.sectionAudits) {
      expect(audit.checks.length, audit.section).toBeGreaterThan(0);
      expect(audit.handler.length).toBeGreaterThan(3);
    }
    // Discovery alone is not coverage: every discovered path is registered.
    for (const path of r.discoveredRowSets) expect(Object.keys(D080B_SECTION_HANDLERS)).toContain(path);
  });
});

describe("C5 — future leakage is proven at the selector boundary", () => {
  const checks = buildLeakageChecks();

  it("never selects a later fact at the earlier origin, and the decision is unchanged", () => {
    expect(checks.length).toBeGreaterThanOrEqual(5);
    for (const c of checks) {
      expect(c.later_fact_visible_at_origin, String(c.check)).toBe(false);
      expect(c.decision_unchanged_at_origin, String(c.check)).toBe(true);
    }
  });

  it("negative control: the same fact becomes visible once the origin advances", () => {
    for (const c of checks) {
      expect(c.later_fact_visible_after_advance, String(c.check)).toBe(true);
      expect(c.decision_changed_after_advance, String(c.check)).toBe(true);
    }
  });

  it("drives the real selector, which never returns a future row", () => {
    const rows = [{ d: "2026-07-01" }, { d: "2026-07-20" }, { d: "2026-08-15" }];
    expect(latestAtOrBefore(rows, "2026-08-01", (r) => r.d)?.d).toBe("2026-07-20");
    expect(latestAtOrBefore(rows, "2026-06-01", (r) => r.d)).toBeNull();
    expect(latestAtOrBefore(rows, "2026-08-20", (r) => r.d)?.d).toBe("2026-08-15");
  });

  it("covers owner, role, target, unit and config facts", () => {
    expect(checks.map((c) => c.check).sort()).toEqual([
      "later_commercial_target", "later_config_state", "later_owner_observation",
      "later_role_inference", "later_unit_exponent_source",
    ]);
  });
});

describe("D080B — the shipped result is what the report may claim", () => {
  it("carries a real read ledger with no failed or skipped reads", () => {
    const ledger = ARTIFACT.provenance.readLedger as any[];
    expect(ledger.length).toBeGreaterThan(50);
    expect(ledger.every((l) => l.disposition === "execute")).toBe(true);
    expect(ARTIFACT.provenance.readFailures).toHaveLength(0);
    expect(ARTIFACT.provenance.transactionReadOnly).toBe("on");
    expect(ARTIFACT.provenance.transactionIsolation).toBe("repeatable read");
  });

  it("pins the accepted D080A and D078 inputs", () => {
    expect(ARTIFACT.provenance.pinnedInputHashes.d080aArtifact)
      .toBe("d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69");
    expect(ARTIFACT.provenance.pinnedInputHashes.d080aInternal)
      .toBe("21e7ac328704eff5bc8db17bbaeabf3c275c0c8ccb23072a950257d039dbdd9f");
    expect(ARTIFACT.provenance.pinnedInputHashes.d078Bundle)
      .toBe("9c0d83aa4541849b43096056b95f686c9673169c461d8ebb97ebb3dd86db7b47");
  });

  it("covers exactly the six charter businesses and seven pinned bindings", () => {
    expect(ARTIFACT.scope.charterBusinesses).toHaveLength(6);
    expect(ARTIFACT.scope.pinnedBindings).toHaveLength(7);
    const deselected = ARTIFACT.scope.pinnedBindings.filter((b: any) => b.is_selected === false);
    expect(deselected).toHaveLength(1);
    expect(deselected[0].business).toBe("TheSwaf");
  });

  it("reports no eligible proposal in the authority lane, with a stated denominator", () => {
    const d = ARTIFACT.measurements.denominators;
    expect(d.proposalsEvaluated).toBeGreaterThan(100_000);
    expect(d.entityOriginPairsSkippedNotYetExisting).toBeGreaterThan(0);
    const total = Object.values(ARTIFACT.measurements.byBusiness as Record<string, any>)
      .reduce((s, v: any) => s + v.eligible, 0);
    expect(total).toBe(0);
  });

  it("names three blockers that alone make every candidate ineligible", () => {
    const census = ARTIFACT.measurements.blockerCensus as Record<string, number>;
    const n = ARTIFACT.measurements.denominators.proposalsEvaluated as number;
    for (const code of ["decision_vocabulary_absent", "role_authority_absent", "unit_exponent_unknown"]) {
      expect(census[code], code).toBe(n);
    }
  });

  it("refuses to publish an account-currency exposure it cannot prove", () => {
    expect(ARTIFACT.measurements.exposure.accountCurrencyExposure).toBeNull();
    expect(String(ARTIFACT.measurements.exposure.accountCurrencyExposureWhyNull)).toContain("exponent");
    expect(ARTIFACT.schemaContract.unitContract.status).toBe("unknown_unit_scale");
    expect(ARTIFACT.schemaContract.currencyExponentSources).toHaveLength(0);
  });

  it("claims no causal lift of any kind", () => {
    const c = ARTIFACT.measurements.causalClaims;
    for (const k of ["roasLift", "revenueLift", "purchaseLift", "profitLift"]) expect(c[k]).toBeNull();
    expect(String(c.why)).toContain("No counterfactual");
  });

  it("publishes the resolved-transition sample size with its double counting removed", () => {
    const t = ARTIFACT.measurements.observedTransitionSummary;
    expect(t.total).toBeGreaterThan(t.resolved);
    expect(t.distinctResolvedEvents).toBeLessThan(t.resolved);
    expect(t.insideLadderRows + t.outsideLadderRows).toBe(t.resolved);
  });

  it("shows the ladder cannot be discriminated on this history", () => {
    const d = ARTIFACT.measurements.conditionalLane.directionAsymmetry;
    expect(d.rungDiscrimination.rungsAreDistinguishable).toBe(false);
    expect(String(d.rungDiscrimination.why)).toContain("before the proposed magnitude");
  });

  it("reconstructs the funnel from the published proposals", () => {
    const funnel = ARTIFACT.measurements.conditionalLane.funnel as any[];
    expect(funnel[0].stage).toBe("0_all_candidates");
    for (let i = 1; i < funnel.length; i += 1) {
      expect(funnel[i].survivors).toBeLessThanOrEqual(funnel[i - 1].survivors);
      expect(funnel[i].eliminated).toBe(funnel[i - 1].survivors - funnel[i].survivors);
    }
    expect(funnel[funnel.length - 1].survivors).toBe(0);
  });

  it("keeps buildFunnel monotone on any input", () => {
    const rows = [
      proposeForCandidate(healthy(), 10, "increase", "h"),
      proposeForCandidate(healthy({ role: null }), 10, "increase", "h"),
      proposeForCandidate(healthy({ ownerAsOfOrigin: null }), 10, "increase", "h"),
    ];
    const f = buildFunnel(rows);
    for (let i = 1; i < f.length; i += 1) {
      expect(Number(f[i]!.survivors)).toBeLessThanOrEqual(Number(f[i - 1]!.survivors));
    }
  });

  it("declares every threshold as data, not as a scattered constant", () => {
    expect(Object.keys(EVIDENCE_FLOORS).length).toBeGreaterThanOrEqual(8);
    expect(POLICY_LADDER_PERCENT).toEqual([5, 10, 15, 20, 25]);
    expect(POLICY_DIRECTIONS).toEqual(["increase", "decrease"]);
    expect(SIMULATION_WINDOW_DAYS).toBe(112);
    expect(ARTIFACT.policyContract.evidenceFloors).toEqual(EVIDENCE_FLOORS);
    expect(ARTIFACT.contract).toBe(D080B_CONTRACT_ID);
  });

  it("never restores or consults a manual role label", () => {
    expect(String(ARTIFACT.roleEvidence.note)).toContain("Automatic inference only");
    const source = readFileSync(resolve("scripts/audits/d080b-meta-budget-policy-simulation.ts"), "utf8");
    // The only permitted mentions are the ones that say the labels are refused.
    expect(source).not.toMatch(/campaign_kind_manual|manual_label|brief_variation/);
  });

  it("replays the frozen snapshot to an identical analysis twice", () => {
    const snapshot = ARTIFACT.snapshot as Record<string, unknown>;
    const a = analyse(snapshot);
    const b = analyse(snapshot);
    expect(JSON.stringify(a.measurements)).toBe(JSON.stringify(b.measurements));
    expect(JSON.stringify(a.origins)).toBe(JSON.stringify(b.origins));
    expect(a.proposals.length).toBe(b.proposals.length);
  });

  it("classifies observed transitions without inventing resolution", () => {
    const rows = classifyObservedTransitions([
      { provider_account_id: "act_1", grain: "campaign", entity_id: "c1", business_id: "b", effective_from: "2026-07-01", daily_budget: 100, lifetime_budget: null, any_mixed: false, distinct_fingerprints: 1 },
      { provider_account_id: "act_1", grain: "campaign", entity_id: "c1", business_id: "b", effective_from: "2026-07-05", daily_budget: 125, lifetime_budget: null, any_mixed: false, distinct_fingerprints: 1 },
      { provider_account_id: "act_1", grain: "adset", entity_id: "a1", business_id: "b", effective_from: "2026-07-01", daily_budget: 100, lifetime_budget: 500, any_mixed: false, distinct_fingerprints: 1 },
      { provider_account_id: "act_1", grain: "adset", entity_id: "a1", business_id: "b", effective_from: "2026-07-05", daily_budget: 125, lifetime_budget: 500, any_mixed: false, distinct_fingerprints: 1 },
    ]);
    expect(rows).toHaveLength(2);
    const resolved = rows.filter((r) => r.semantics === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.direction).toBe("increase");
    expect(resolved[0]!.percent).toBe(25);
    expect(rows.find((r) => r.semantics === "unresolved")!.why_unresolved).toContain("two budget fields");
  });

  it("keeps both coverage lists subsets of the gate codes, and one a superset of the other", () => {
    for (const code of ABSENCE_BLOCKERS) expect(D080B_GATE_CODES as readonly string[]).toContain(code);
    for (const code of COVERAGE_BLOCKERS) expect(D080B_GATE_CODES as readonly string[]).toContain(code);
    for (const code of ABSENCE_BLOCKERS) expect(COVERAGE_BLOCKERS).toContain(code);
    // A successful read that found no spend is a fact, not an absent fact.
    expect(ABSENCE_BLOCKERS).not.toContain("spend_evidence_floor");
    expect(COVERAGE_BLOCKERS).toContain("spend_evidence_floor");
  });

  it("validates dates the way the boundary does", () => {
    expect(isCalendarDate("2026-08-21")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-8-21")).toBe(false);
  });
});
