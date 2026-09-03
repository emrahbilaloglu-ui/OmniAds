/**
 * D085 — the dry-run proposal contract.
 *
 * The controlling property is FAIL-CLOSED: a would-write request exists only
 * when every gate passes, and today one gate can never pass, because
 * `MUTATION_ENDPOINTS` has no budget action at any grain. So the honest result
 * for every real proposal is `blocked`, and these tests prove that is a
 * derived outcome with a full blocker list — not a hardcoded refusal.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DRY_RUN_BLOCKERS,
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  PREVIEW_KEY_NAMESPACE,
  PROVIDER_CAPABILITY_TODAY,
  WOULD_WRITE_FIELD_ALLOWLIST,
  assembleWouldWritePreview,
  buildBudgetProposalDryRun,
  capabilityPermitsWrite,
  clearSafetyFlag,
  dryRunIsExecutable,
  dryRunPolicyFingerprint,
  PREVIEW_CONTRACT_VERSION,
  admissionToSafetyFlag,
  capabilityFingerprint,
  engagedSafetyFlag,
  validateCapability,
  validateRoleAuthority,
  sanitizeCapabilitySnapshot,
  verifyReceiptPreviewIntegrity,
  validateWriteSafetyCeremony,
  governanceToKillSwitchFlag,
  previewIdempotencyKey,
  recomputePreviewHash,
  unknownSafetyFlag,
  type DryRunBlocker,
  type DryRunInput,
  type ProviderCapabilityContract,
  type ReceiptPreview,
} from "@/lib/meta/budget-proposal-dry-run";
import { MUTATION_ENDPOINTS } from "@/lib/zero-base/meta/dispatch-contract";
import { WRITE_SAFETY_STEPS } from "@/lib/meta/write-safety-contract";
import { readbackFingerprint, type PreflightProjection } from "@/lib/meta/provider-readback-contract";
import { validateBudgetIntent } from "@/lib/meta/budget-intent-contract";
import { ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { campaignContextAuthorityResolverVersion } from "@/lib/creative-decision-engine/campaign-context/source";

/*
  TEST-LOCAL adversarial resealing — private to this file by construction.

  Adversarial fixtures must sometimes seal a deliberately illegal pair in order
  to attack the verifier. r13 met that need by weakening the production
  recompute function; r14 moved it behind a name but still EXPORTED it from the
  production runtime; r15 moved it to `lib/meta/__testing__/`, which any
  production module could still import. Correction 15 deletes the module: the
  algorithm is reimplemented here, in the test that needs it, where nothing can
  import it. There is no forge module to reach.
*/
function canonicaliseForTests(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseForTests);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((k) => [k, canonicaliseForTests((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The raw canonical preview hash, with NO eligibility gate. */
function rawCanonicalPreviewHashForTests(
  payload: { request: unknown; receipt: unknown },
  previewContractVersion: string,
): string {
  const { receiptHash: _excluded, ...bareReceipt } = payload.receipt as Record<string, unknown>;
  const canonical = JSON.stringify(canonicaliseForTests({
    v: previewContractVersion, request: payload.request, receipt: bareReceipt,
  }));
  return `${previewContractVersion}:${createHash("sha256").update(canonical).digest("hex")}`;
}

const BASELINE: PreflightProjection = {
  providerAccountId: "act_1087566732415606",
  entityGrain: "adset",
  entityId: "23851234567890123",
  parentCampaignId: "23859876543210987",
  budgetField: "daily_budget",
  budgetMinorUnits: 10_000,
  ownerMode: "adset_budget",
  effectiveStatus: "ACTIVE",
  scheduleStart: null,
  scheduleEnd: null,
  optimizationGoal: "OFFSITE_CONVERSIONS",
};

/** The most favourable input the real evidence could ever produce. */
function bestCase(over: Partial<DryRunInput> = {}): DryRunInput {
  const satisfied = Object.fromEntries(
    WRITE_SAFETY_STEPS.map((s) => [s, "satisfied" as const]),
  ) as DryRunInput["writeSafety"];
  return {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: { id: "dec_1", hash: "d".repeat(64), version: "v1", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 86_400 },
    scope: {
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
      business: "IwaStore",
      providerAccountId: "act_1087566732415606",
      entityGrain: "adset",
      entityId: "23851234567890123",
      parentCampaignId: "23859876543210987",
      accountIsWriteScope: true,
      accountSelectionWhy: "selected serving account",
    },
    direction: "increase",
    percent: 10,
    accountCurrency: "USD",
    currencyExponent: 2,
    currencyRegistryVersion: ISO_4217_REGISTRY_VERSION,
    unitConfidence: "exact",
    role: {
      // CANONICAL automatic role authority, per the D081 rule. `scale` is a
      // COMMERCIAL ACTION, not a campaign role, and "automatic"/"v1" are not
      // the canonical producer/source/resolver — r5's fixture was itself
      // non-canonical.
      // The CANONICAL resolver identity. It still does not validate here: the
      // gate requires the environment to have APPROVED that identity, and this
      // environment approves none, so even a perfectly-shaped role authority
      // blocks. That is the honest outcome, and it is why no builder-level
      // preview is reachable below.
      role: "main", source: "system_inferred", resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      confidence: "high", asOf: "2026-09-01", accountScoped: true,
      satisfiesRoleAuthority: true, authorityBlockers: [], producer: "automatic_inference",
      campaignId: "23859876543210987",
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606",
      resolved: true, why: "resolved",
    },
    budgetFact: {
      contractVersion: "meta.budget-fact.v4", available: true, currentMinorUnits: 10_000,
      budgetField: "daily_budget", ownerMode: "adset_budget", scheduleStart: null, scheduleEnd: null,
      observedAt: "2026-09-01", capturedAt: "2026-09-01T00:00:00.000Z", lineage: "canonical", availabilityWhy: "available",
    },
    commercial: {
      profileContractVersion: "adsecute.account-decision-profile.v1",
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", sourceStatus: "resolved",
      selectedAction: "scale", eligible: true, code: null, reason: null, blockerCodes: [],
      evidenceFloorsClear: true, changeSafetyClear: true,
    },
    safety: {
      killSwitch: clearSafetyFlag("test", "2026-09-01", "disengaged"),
      admission: clearSafetyFlag("test", "2026-09-01", "allowed"),
      cap: clearSafetyFlag("test", "2026-09-01", "under cap"),
      cooldown: clearSafetyFlag("test", "2026-09-01", "no cooldown"),
      conflict: clearSafetyFlag("test", "2026-09-01", "no lock"),
    },
    capability: PROVIDER_CAPABILITY_TODAY,
    // The RAW input the canonical validator re-derives from.
    rawIntent: {
      contractVersion: "meta.budget-intent.v1",
      scope: { businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606", entityGrain: "adset", entityId: "23851234567890123", parentCampaignId: "23859876543210987" },
      ownerMode: "adset_budget", budgetField: "daily_budget",
      observedDailyMinorUnits: 10_000, observedLifetimeMinorUnits: null,
      lifetimeSchedule: null, direction: "increase", percent: 10, accountCurrency: "USD",
      originDate: "2026-09-01", effectiveAsOf: "2026-09-01", knowledgeAsOf: "2026-09-01",
      authorityEvidenceAsOf: "2026-09-01", maxAuthorityEvidenceAgeDays: 60,
      sourceFingerprints: { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64) },
      evidenceWindow: { from: "2026-08-01", to: "2026-09-01" },
      targetSource: null, authorityStatus: "authorised", blockerCodes: [],
    },
    knownBindings: [{ businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", providerAccountId: "act_1087566732415606" }],
    // No hand-written ValidatedBudgetIntent: the builder derives the canonical
    // one from `rawIntent`. Supplying a cast object is what C4 forbids.
    intent: null,
    intentRejections: [],
    casBaseline: BASELINE,
    preflightEvidence: { rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: BASELINE }, evaluatedAt: "2026-09-01T00:00:00.000Z", baselineFingerprint: readbackFingerprint(BASELINE) },
    preflight: {
      contractVersion: "meta.provider-readback.v4", outcome: "succeeded",
      claimedStatus: "succeeded", rejections: [], ageSeconds: 0, fresh: true,
      projectionComplete: true,
      driftedFields: [], driftDetail: [], matchesBaseline: true, why: "a fresh (0s old), complete provider read reproduces the baseline on every projected field",
    },
    writeSafety: satisfied,
    originDate: "2026-09-01",
    knowledgeAsOf: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const blockersOf = (input: DryRunInput): DryRunBlocker[] => buildBudgetProposalDryRun(input).blockers;

/*
  THE FLOOR.

  Two blockers stand under every input in this environment, and neither can be
  removed by shaping the fixture:

    - `role_authority_not_canonical`, because the canonical D081 resolver gate
      requires an environment-APPROVED resolver identity and this environment
      approves none. r6 accepted any non-empty string here, which is how six
      mutated role contexts previewed.
    - `no_provider_write_path_exists`, the structural gate.

  Tests that need to inspect the SHAPE of a would-write request or a receipt
  therefore call the pure assembler directly. Weakening the gate to keep a
  favourable builder fixture reachable would be exactly the fiction this
  correction removes.
*/
/*
  The floor is DERIVED from the environment, not assumed.

  Correction 6 hard-coded `role_authority_not_canonical` into it, which
  silently baked in "no environment ever approves the resolver". That made the
  whole file wrong under a process-local approval — and, worse, meant the
  negative rows below had never once been run against a baseline that would
  otherwise have previewed. The floor is now computed, so this file is correct
  in both environments and cannot hide that assumption again.
*/
const RESOLVER_APPROVED = campaignContextAuthorityResolverVersion() !== null;
const AUTHORITY_FLOOR: DryRunBlocker[] = RESOLVER_APPROVED
  ? ["no_provider_write_path_exists"]
  : ["role_authority_not_canonical", "no_provider_write_path_exists"];
const floorPlus = (...extra: DryRunBlocker[]): DryRunBlocker[] =>
  RESOLVER_APPROVED
    ? [...extra, "no_provider_write_path_exists"]
    : ["role_authority_not_canonical", ...extra, "no_provider_write_path_exists"];

/** An explicitly SYNTHETIC capability. Production always passes the real one. */
const SYNTHETIC_CAP: ProviderCapabilityContract = {
  budgetEndpointExists: true, dispatchVerbExists: true,
  supportedFields: ["daily_budget"],
  source: "SYNTHETIC TEST CAPABILITY — no such endpoint exists in this codebase",
  why: "synthetic capability used only to exercise preview assembly",
};

/**
 * The preview SHAPE, assembled directly.
 *
 * Production authority is deliberately unreachable here, so these cover the
 * assembler as a pure function rather than pretending the builder can reach
 * it. The input fingerprint is the builder's real one for the same input, so
 * the receipt's own binding is still the genuine value.
 */
function assembledPreview(over: Partial<DryRunInput> = {}) {
  const input = bestCase({ capability: SYNTHETIC_CAP, ...over });
  const inputFingerprint = buildBudgetProposalDryRun(input).inputFingerprint;
  const out = assembleWouldWritePreview({
    scope: input.scope,
    // The boundary re-derives from these; the derived view is a cross-check.
    rawIntent: input.rawIntent!,
    knownBindings: input.knownBindings,
    intent: canonicalIntent(over),
    budgetField: "daily_budget",
    casBaseline: input.casBaseline!,
    decisionId: input.decision!.id,
    writeSafety: input.writeSafety,
    capability: SYNTHETIC_CAP,
    inputFingerprint,
  });
  if ("refused" in out) throw new Error(`unexpectedly refused: ${out.why}`);
  return { ...out, inputFingerprint };
}

/** The CANONICAL intent, derived exactly as the builder derives it. */
function canonicalIntent(over: Partial<DryRunInput> = {}) {
  const input = bestCase(over);
  const v = validateBudgetIntent(input.rawIntent!, input.knownBindings);
  if (v.status !== "valid") throw new Error(`fixture intent is invalid: ${v.rejections.join(", ")}`);
  return v.intent;
}

describe("D085 — no provider write path exists, and the contract says so", () => {
  it("blocks even the most favourable proposal, on the structural gate", () => {
    const result = buildBudgetProposalDryRun(bestCase());
    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(AUTHORITY_FLOOR);
    expect(result.wouldWriteRequest).toBeNull();
    expect(result.receiptPreview).toBeNull();
  });

  it("agrees with the real dispatch contract: no budget action at any grain", () => {
    // The blocker is not an opinion — it reproduces the shipped table.
    for (const grain of Object.keys(MUTATION_ENDPOINTS)) {
      const actions = Object.keys(MUTATION_ENDPOINTS[grain as keyof typeof MUTATION_ENDPOINTS] ?? {});
      expect(actions, grain).not.toContain("budget");
      expect(actions, grain).not.toContain("daily_budget");
    }
  });

  it("is never executable and never enables a CTA", () => {
    const result = buildBudgetProposalDryRun(bestCase());
    expect(dryRunIsExecutable()).toBe(false);
    expect(result.executable).toBe(false);
    expect(result.ctaEnabled).toBe(false);
    expect(result.executionState).toBe("validated_only");
    expect(result.providerWriteAttempted).toBe(false);
    expect(result.providerOutcome).toBe("not_attempted");
    expect(result.readbackClassification).toBe("not_attempted");
  });
});

describe("D085 — every gate is derived, not hardcoded", () => {
  it.each([
    ["no_concrete_entity_selected", { scope: { ...bestCase().scope, entityId: null, entityGrain: null } }],
    ["no_direction_selected", { direction: null }],
    ["account_not_write_scope", { scope: { ...bestCase().scope, accountIsWriteScope: false, accountSelectionWhy: "deselected, read-only" } }],
    ["budget_fact_unavailable", { budgetFact: { ...bestCase().budgetFact, available: false, availabilityWhy: "not retained" } }],
    ["current_value_unknown", { budgetFact: { ...bestCase().budgetFact, currentMinorUnits: null } }],
    ["currency_exponent_unknown", { currencyExponent: null }],
    ["owner_mode_unknown", { budgetFact: { ...bestCase().budgetFact, ownerMode: "unknown" as const } }],
    ["role_context_unresolved", { role: { ...bestCase().role, resolved: false, why: "no qualifying rows" } }],
    ["commercial_profile_unavailable", { commercial: { ...bestCase().commercial, sourceStatus: "output_not_retained" } }],
    ["commercial_action_ineligible", { commercial: { ...bestCase().commercial, eligible: false } }],
    ["evidence_floor_unmet", { commercial: { ...bestCase().commercial, evidenceFloorsClear: false } }],
    ["change_safety_not_clear", { commercial: { ...bestCase().commercial, changeSafetyClear: false } }],
    ["decision_absent", { decision: { id: null, hash: null, version: null, decidedAt: null, maxAgeSeconds: 3600 } }],
    ["kill_switch_engaged", { safety: { ...bestCase().safety, killSwitch: engagedSafetyFlag("gov", "2026-09-01T00:00:00.000Z", "stopped") } }],
    ["admission_blocked", { safety: { ...bestCase().safety, admission: engagedSafetyFlag("health", "2026-09-01T00:00:00.000Z", "over budget") } }],
    ["cooldown_active", { safety: { ...bestCase().safety, cooldown: engagedSafetyFlag("hist", "2026-09-01T00:00:00.000Z", "7d window") } }],
    ["conflict_lock_held", { safety: { ...bestCase().safety, conflict: engagedSafetyFlag("lock", "2026-09-01T00:00:00.000Z", "held") } }],
    ["kill_switch_unverified", { safety: { ...bestCase().safety, killSwitch: unknownSafetyFlag("not read") } }],
    ["cap_unverified", { safety: { ...bestCase().safety, cap: unknownSafetyFlag("no history read") } }],
    ["cooldown_unverified", { safety: { ...bestCase().safety, cooldown: unknownSafetyFlag("no history read") } }],
    ["conflict_unverified", { safety: { ...bestCase().safety, conflict: unknownSafetyFlag("no lock read") } }],
    ["decision_identity_incomplete", { decision: { id: null, hash: "d".repeat(64), version: "v", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 3600 } }],
    ["decision_clock_invalid", { decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt: "not-a-date", maxAgeSeconds: 3600 } }],
    ["decision_clock_in_future", { decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt: "2099-01-01T00:00:00.000Z", maxAgeSeconds: 3600 } }],
    ["decision_max_age_invalid", { decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 0 } }],
    ["provider_preflight_not_readable", { preflight: null }],
    ["intent_not_validated", { rawIntent: null, intent: null, intentRejections: ["current_value_missing"] }],
  ] as Array<[DryRunBlocker, Partial<DryRunInput>]>)("raises %s", (code, over) => {
    expect(blockersOf(bestCase(over))).toContain(code);
  });

  it("raises cas_baseline_drifted and provider_state_drifted together on drift", () => {
    const blockers = blockersOf(bestCase({
      preflight: {
        contractVersion: "meta.provider-readback.v4", outcome: "succeeded",
        claimedStatus: "succeeded", rejections: [], ageSeconds: 0, fresh: true,
        projectionComplete: true,
        driftedFields: ["budgetMinorUnits"],
        driftDetail: [{ field: "budgetMinorUnits", baseline: 10_000, observed: 12_000 }],
        matchesBaseline: false, why: "drifted",
      },
    }));
    expect(blockers).toContain("provider_state_drifted");
    expect(blockers).toContain("cas_baseline_drifted");
  });

  it("raises write_safety_step_missing naming the exact steps", () => {
    const result = buildBudgetProposalDryRun(bestCase({
      writeSafety: { ...bestCase().writeSafety, durable_idempotency_claim: "missing", independent_provider_readback: "missing" },
    }));
    const detail = result.blockerDetail.find((d) => d.code === "write_safety_step_missing");
    expect(detail?.why).toContain("durable_idempotency_claim");
    expect(detail?.why).toContain("independent_provider_readback");
  });

  it("keeps `not proven clear` distinct from `a cap was exceeded`", () => {
    // Labelling an unproven control as a breach would report a violation the
    // evidence does not establish.
    const unproven = buildBudgetProposalDryRun(bestCase({
      commercial: { ...bestCase().commercial, changeSafetyClear: null },
    }));
    expect(unproven.blockers).toContain("change_safety_not_clear");
    expect(unproven.blockers).not.toContain("cap_exceeded");
    expect(unproven.blockerDetail.find((d) => d.code === "change_safety_not_clear")?.why)
      .toContain("not_determinable");
    // ...and a real cap breach still reports as one.
    expect(blockersOf(bestCase({ safety: { ...bestCase().safety, cap: engagedSafetyFlag("hist", "2026-09-01T00:00:00.000Z", "3 today") } })))
      .toContain("cap_exceeded");
  });

  it("keeps an ABSENT decision distinct from a stale one", () => {
    expect(blockersOf(bestCase({ decision: { id: null, hash: null, version: null, decidedAt: null, maxAgeSeconds: 3600 } })))
      .toContain("decision_absent");
    expect(blockersOf(bestCase({ decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt: "2026-08-01T00:00:00.000Z", maxAgeSeconds: 3600 } })))
      .toContain("decision_stale");
  });

  it("treats a stale decision as a blocker using real clock arithmetic", () => {
    expect(blockersOf(bestCase({
      decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt: "2026-08-01T00:00:00.000Z", maxAgeSeconds: 3600 },
    }))).toContain("decision_stale");
    // ...and a fresh decision does not raise it.
    expect(blockersOf(bestCase())).not.toContain("decision_stale");
  });

  it("returns the COMPLETE ordered blocker set, not the first failure", () => {
    const result = buildBudgetProposalDryRun(bestCase({
      direction: null,
      budgetFact: { ...bestCase().budgetFact, available: false, currentMinorUnits: null, availabilityWhy: "absent" },
      commercial: { ...bestCase().commercial, sourceStatus: "read_failed", eligible: null, evidenceFloorsClear: null, changeSafetyClear: null },
      safety: { ...bestCase().safety, killSwitch: engagedSafetyFlag("gov", "2026-09-01T00:00:00.000Z", "stopped") },
    }));
    expect(result.blockers.length).toBeGreaterThan(5);
    // Ordered exactly as declared: identity → facts → authority → safety → provider.
    const positions = result.blockers.map((b) => DRY_RUN_BLOCKERS.indexOf(b));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(result.blockerDetail.every((d) => d.why.length > 0)).toBe(true);
  });
});

describe("D085 — identity, units and allowlist discipline", () => {
  it("keeps the would-write field allowlist to exactly the two budget fields", () => {
    expect([...WOULD_WRITE_FIELD_ALLOWLIST].sort()).toEqual(["daily_budget", "lifetime_budget"]);
  });

  it("blocks a lifetime budget with no retained flight", () => {
    expect(blockersOf(bestCase({
      budgetFact: { ...bestCase().budgetFact, budgetField: "lifetime_budget", scheduleStart: null, scheduleEnd: null },
    }))).toContain("schedule_unknown");
  });

  it("gives two different accounts different input fingerprints", () => {
    // Cross-account collision guard: same entity id under a different account
    // must never share a fingerprint.
    const a = buildBudgetProposalDryRun(bestCase());
    const b = buildBudgetProposalDryRun(bestCase({
      scope: { ...bestCase().scope, providerAccountId: "act_840779107261785" },
    }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it("gives two different amounts different fingerprints", () => {
    const a = buildBudgetProposalDryRun(bestCase());
    const b = buildBudgetProposalDryRun(bestCase({
      budgetFact: { ...bestCase().budgetFact, currentMinorUnits: 90_000 },
    }));
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it("is deterministic: the same input yields the same fingerprints", () => {
    const a = buildBudgetProposalDryRun(bestCase());
    const b = buildBudgetProposalDryRun(bestCase());
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    expect(a.policyFingerprint).toBe(b.policyFingerprint);
    expect(a.policyFingerprint).toBe(dryRunPolicyFingerprint());
  });

  it("changes the policy fingerprint if the policy itself changes", () => {
    // The fingerprint is a pure function of the declared policy, so a future
    // edit to the allowlist or the step list cannot pass unnoticed.
    // Derived: this literal went stale on every correction that bumped the version.
    expect(dryRunPolicyFingerprint()).toMatch(
      new RegExp(`^${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT.replace(/\./g, "\\.")}:[0-9a-f]{64}$`),
    );
  });
});

describe("D085 — the module cannot reach a write", () => {
  const source = readFileSync(resolve("lib/meta/budget-proposal-dry-run.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

  it("imports no provider write adapter and no database", () => {
    for (const forbidden of ["ads-write", "launch-write", "@/lib/db", "getDb", "neon(", "drizzle"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("issues no HTTP request and no mutating method", () => {
    for (const forbidden of [/\bfetch\s*\(/, /axios/, /"POST"/, /'POST'/, /"PUT"/, /"PATCH"/, /"DELETE"/]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("contains no SQL DML", () => {
    for (const forbidden of [/INSERT\s+INTO/i, /UPDATE\s+\w+\s+SET/i, /DELETE\s+FROM/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("names an endpoint CLASS, never a callable route or token", () => {
    expect(code).toContain("meta.graph.node_field_update");
    expect(code).not.toContain("graph.facebook.com");
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/access_token|Bearer |Authorization/i);
  });
});

// ---------------------------------------------------------------------------
// Correction 1 — tri-state safety, PIT discipline, and a REAL preview
// ---------------------------------------------------------------------------

describe("D085 C1 — unknown safety is never clear", () => {
  it.each(["killSwitch", "admission", "cap", "cooldown", "conflict"] as const)(
    "blocks when %s is unknown", (flag) => {
      const blockers = blockersOf(bestCase({
        safety: { ...bestCase().safety, [flag]: unknownSafetyFlag("nobody read it") },
      }));
      const expected = {
        killSwitch: "kill_switch_unverified", admission: "admission_unverified",
        cap: "cap_unverified", cooldown: "cooldown_unverified", conflict: "conflict_unverified",
      }[flag] as DryRunBlocker;
      expect(blockers).toContain(expected);
    });

  it("distinguishes proved-engaged from unverified", () => {
    const engaged = blockersOf(bestCase({ safety: { ...bestCase().safety, killSwitch: engagedSafetyFlag("gov", "2026-09-01T00:00:00.000Z", "stopped") } }));
    expect(engaged).toContain("kill_switch_engaged");
    expect(engaged).not.toContain("kill_switch_unverified");
    const unknown = blockersOf(bestCase({ safety: { ...bestCase().safety, killSwitch: unknownSafetyFlag("not read") } }));
    expect(unknown).toContain("kill_switch_unverified");
    // Unknown must NOT be reported as a proved breach.
    expect(unknown).not.toContain("kill_switch_engaged");
  });

  it("lets a sourced clear flag pass, but refuses a sourceless one", () => {
    expect(blockersOf(bestCase())).not.toContain("kill_switch_unverified");
    const sourceless = blockersOf(bestCase({
      safety: { ...bestCase().safety, killSwitch: { state: "clear", source: null, asOf: null, why: "claimed clear" } },
    }));
    expect(sourceless).toContain("kill_switch_unverified");
  });

  it("cannot clear caps, cooldown or conflict from unread history", () => {
    const blockers = blockersOf(bestCase({
      safety: {
        ...bestCase().safety,
        cap: unknownSafetyFlag("no history read"),
        cooldown: unknownSafetyFlag("no history read"),
        conflict: unknownSafetyFlag("no lock read"),
      },
    }));
    for (const c of ["cap_unverified", "cooldown_unverified", "conflict_unverified"] as DryRunBlocker[]) {
      expect(blockers).toContain(c);
    }
  });
});

describe("D085 C1 — PIT and recorded-time leakage fail closed", () => {
  it("blocks evidence dated after the origin", () => {
    expect(blockersOf(bestCase({ role: { ...bestCase().role, asOf: "2026-09-05" } })))
      .toContain("evidence_after_origin");
    expect(blockersOf(bestCase({ budgetFact: { ...bestCase().budgetFact, observedAt: "2026-09-09" } })))
      .toContain("evidence_after_origin");
    expect(blockersOf(bestCase())).not.toContain("evidence_after_origin");
  });

  it("blocks a capture recorded after the knowledge cutoff", () => {
    expect(blockersOf(bestCase({
      budgetFact: { ...bestCase().budgetFact, capturedAt: "2026-10-01T00:00:00.000Z" },
    }))).toContain("capture_after_knowledge_cutoff");
    expect(blockersOf(bestCase())).not.toContain("capture_after_knowledge_cutoff");
  });

  it("blocks unparseable ordering clocks", () => {
    expect(blockersOf(bestCase({ originDate: "not-a-day" }))).toContain("clock_ordering_invalid");
    expect(blockersOf(bestCase({ knowledgeAsOf: "nonsense" }))).toContain("clock_ordering_invalid");
  });

  it("keeps absent, invalid, future and stale as four distinct labels", () => {
    const at = (decidedAt: string | null) =>
      blockersOf(bestCase({ decision: { id: "d", hash: "d".repeat(64), version: "v", decidedAt, maxAgeSeconds: 3600 } }));
    expect(at(null)).toContain("decision_absent");
    expect(at("not-a-date")).toContain("decision_clock_invalid");
    expect(at("2099-01-01T00:00:00.000Z")).toContain("decision_clock_in_future");
    expect(at("2026-08-01T00:00:00.000Z")).toContain("decision_stale");
    // ...and each excludes the others.
    expect(at("not-a-date")).not.toContain("decision_stale");
    expect(at("2099-01-01T00:00:00.000Z")).not.toContain("decision_stale");
    expect(at(null)).not.toContain("decision_clock_invalid");
  });
});

describe("D085 C1 — the preview is real, and still cannot open a write path", () => {
  /** An explicitly SYNTHETIC capability. Production passes the real one. */
  const SYNTHETIC: ProviderCapabilityContract = {
    budgetEndpointExists: true, dispatchVerbExists: true,
    supportedFields: ["daily_budget"],
    source: "SYNTHETIC TEST CAPABILITY — no such endpoint exists in this codebase",
    why: "synthetic capability used only to exercise preview assembly",
  };
  /*
    Correction 10 made the assembly boundary RE-DERIVE the canonical intent
    from the raw intent and bindings. A supplied `intent` is now only a
    cross-check, accepted on exact canonical equality, so these fixtures pass
    the raw input the derivation actually needs.
  */
  const previewInput = (over: Record<string, unknown> = {}) => ({
    scope: bestCase().scope,
    rawIntent: bestCase().rawIntent!,
    knownBindings: bestCase().knownBindings,
    intent: canonicalIntent(),
    budgetField: "daily_budget" as const,
    casBaseline: BASELINE,
    decisionId: "dec_1",
    writeSafety: bestCase().writeSafety,
    capability: SYNTHETIC,
    inputFingerprint: `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${"a".repeat(64)}`,
    ...over,
  });
  const assembled = () => {
    const out = assembleWouldWritePreview(previewInput());
    if ("refused" in out) throw new Error(`unexpectedly refused: ${out.why}`);
    return out;
  };

  it("PRODUCTION capability still forbids a write, so the real result is unchanged", () => {
    expect(capabilityPermitsWrite(PROVIDER_CAPABILITY_TODAY)).toBe(false);
    expect(PROVIDER_CAPABILITY_TODAY.budgetEndpointExists).toBe(false);
    const real = buildBudgetProposalDryRun(bestCase());
    expect(real.status).toBe("blocked");
    expect(real.wouldWriteRequest).toBeNull();
    expect(real.blockers).toEqual(AUTHORITY_FLOOR);
  });

  it("assembles the exact sanitized request", () => {
    const { request } = assembled();
    expect(request.dryRun).toBe(true);
    expect(request.endpointClass).toBe("meta.graph.node_field_update");
    expect(request.nodeClass).toBe("adset");
    expect(request.field).toBe("daily_budget");
    expect(request.currentMinorUnits).toBe(10_000);
    expect(request.proposedMinorUnits).toBe(11_000);
    expect(request.valueSemantics).toBe("absolute_desired_state");
    expect([...request.fieldAllowlist].sort()).toEqual(["daily_budget", "lifetime_budget"]);
    expect(request.casPrecondition.expectedMinorUnits).toBe(10_000);
    // Never executable, never sent, never a success.
    expect(request.executable).toBe(false);
    expect(request.providerWriteAttempted).toBe(false);
    expect(request.providerOutcome).toBe("not_attempted");
  });

  it("carries no token, header, URL or PII", () => {
    const raw = JSON.stringify(assembled().request);
    for (const forbidden of [
      /https?:\/\//, /graph\.facebook\.com/i, /access_token/i, /Bearer /i,
      /authorization/i, /cookie/i, /"headers"/i,
    ]) {
      expect(raw, String(forbidden)).not.toMatch(forbidden);
    }
    expect(Object.keys(assembled().request).sort()).toEqual([
      "casPrecondition", "currency", "currencyExponent", "currentMinorUnits", "dryRun",
      "endpointClass", "entityId", "executable", "field", "fieldAllowlist",
      "idempotencyKeyPreview", "nodeClass", "notExecutableWhy", "proposedMinorUnits",
      "providerOutcome", "providerWriteAttempted", "valueSemantics",
    ]);
  });

  it("assembles an immutable receipt preview that is never durable or successful", () => {
    const { receipt } = assembled();
    expect(receipt.dryRun).toBe(true);
    expect(receipt.isDurableReceipt).toBe(false);
    expect(receipt.previewKeyNamespace).toBe(PREVIEW_KEY_NAMESPACE);
    expect(receipt.previewKey.startsWith(`${PREVIEW_KEY_NAMESPACE}:`)).toBe(true);
    expect(receipt.before).toEqual({ field: "daily_budget", minorUnits: 10_000 });
    expect(receipt.proposed).toEqual({ field: "daily_budget", minorUnits: 11_000 });
    expect(receipt.actor.classification).toBe("system_dry_run");
    expect(receipt.actor.humanApproval).toBeNull();
    expect(receipt.rollbackPreview).toEqual({
      field: "daily_budget", restoreMinorUnits: 10_000,
      operation: "restore_prior_amount", reversibilityClass: "R1",
    });
    expect(receipt.redaction).toEqual({
      tokensIncluded: false, headersIncluded: false, fullUrlIncluded: false, piiIncluded: false,
    });
    expect(receipt.providerOutcome).toBe("not_attempted");
    expect(receipt.readbackClassification).toBe("not_attempted");
    expect(receipt.executionState).toBe("validated_only");
    expect(receipt.ctaEnabled).toBe(false);
  });

  it("produces stable hashes and separates accounts, entities and amounts", () => {
    const a = assembled().receipt.previewKey;
    expect(assembled().receipt.previewKey).toBe(a);
    /*
      Correction 9 made the assembly boundary AUTHORITATIVE: the validated
      intent must have been produced for the scope being assembled. Varying the
      scope alone is now a refusal — correctly, because that pairing never
      existed — so the intent moves with it.
    */
    const otherAccount = assembleWouldWritePreview(previewInput({
      scope: { ...bestCase().scope, providerAccountId: "act_840779107261785" },
      rawIntent: { ...bestCase().rawIntent!, scope: { ...bestCase().rawIntent!.scope, providerAccountId: "act_840779107261785" } },
      knownBindings: [{ businessId: bestCase().scope.businessId, providerAccountId: "act_840779107261785" }],
      intent: canonicalIntent({
        scope: { ...bestCase().scope, providerAccountId: "act_840779107261785" },
        knownBindings: [{ businessId: bestCase().scope.businessId, providerAccountId: "act_840779107261785" }],
        rawIntent: { ...bestCase().rawIntent!, scope: { ...bestCase().rawIntent!.scope, providerAccountId: "act_840779107261785" } },
      }),
      casBaseline: { ...BASELINE, providerAccountId: "act_840779107261785" },
    }));
    const otherEntity = assembleWouldWritePreview(previewInput({
      scope: { ...bestCase().scope, entityId: "23859999999999999" },
      rawIntent: { ...bestCase().rawIntent!, scope: { ...bestCase().rawIntent!.scope, entityId: "23859999999999999" } },
      intent: canonicalIntent({
        scope: { ...bestCase().scope, entityId: "23859999999999999" },
        rawIntent: { ...bestCase().rawIntent!, scope: { ...bestCase().rawIntent!.scope, entityId: "23859999999999999" } },
      }),
      casBaseline: { ...BASELINE, entityId: "23859999999999999" },
    }));
    /*
      Correction 11 requires the CURRENT contract namespace on the input
      fingerprint, so assembly can never mint a receipt its own verifier
      rejects. This row varies the DIGEST — which is what it actually means to
      test — rather than the namespace.
    */
    const otherFingerprint = assembleWouldWritePreview(previewInput({
      inputFingerprint: `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${"b".repeat(64)}`,
    }));
    for (const other of [otherAccount, otherEntity, otherFingerprint]) {
      if ("refused" in other) throw new Error("unexpected refusal");
      expect(other.receipt.previewKey).not.toBe(a);
    }
    // The CAS fingerprint and the expected read-back fingerprint differ: one is
    // the before-state, the other the after-state.
    const { receipt } = assembled();
    expect(receipt.casBaselineFingerprint).not.toBe(receipt.readbackFingerprint);
  });

  it("refuses to assemble outside the allowlist, capability or unit rules", () => {
    const refusals = [
      previewInput({ capability: PROVIDER_CAPABILITY_TODAY }),
      previewInput({ capability: { ...SYNTHETIC, supportedFields: ["lifetime_budget"] as const } }),
      previewInput({ scope: { ...bestCase().scope, entityId: null } }),
      previewInput({ intent: { ...canonicalIntent(), proposedMinorUnits: 11_000.5 } }),
      previewInput({ intent: { ...canonicalIntent(), proposedMinorUnits: -1 } }),
    ];
    for (const input of refusals) {
      const out = assembleWouldWritePreview(input as Parameters<typeof assembleWouldWritePreview>[0]);
      expect("refused" in out, JSON.stringify(input.capability?.source ?? "")).toBe(true);
    }
  });

  it("never reserves or collides with a durable claim namespace", () => {
    const { receipt } = assembled();
    expect(receipt.previewKey).toContain("d085-preview:");
    expect(receipt.previewKey).not.toMatch(/^claim[:_]/);
    expect(receipt.previewKey).not.toBe(canonicalIntent().idempotencyKey);
  });
});


// ---------------------------------------------------------------------------
// Correction 2 — cross-binding, fingerprint integrity, immutable receipt
// ---------------------------------------------------------------------------

describe("D085 C2 — the dry run binds its evidence together", () => {
  it.each([
    ["scope_intent_identity_mismatch", { scope: { ...bestCase().scope, providerAccountId: "act_WRONG" } }],
    ["scope_intent_identity_mismatch", { scope: { ...bestCase().scope, entityId: "adset_WRONG" } }],
    ["scope_baseline_identity_mismatch", { casBaseline: { ...BASELINE, entityId: "other_entity" } }],
    ["amount_binding_mismatch", { budgetFact: { ...bestCase().budgetFact, currentMinorUnits: 90_000 } }],
    ["amount_binding_mismatch", { casBaseline: { ...BASELINE, budgetMinorUnits: 55 } }],
    ["direction_intent_mismatch", { direction: "decrease" as const }],
    ["direction_intent_mismatch", { percent: 25 }],
    ["direction_action_mismatch", { commercial: { ...bestCase().commercial, selectedAction: "cut" } }],
    ["budget_field_binding_mismatch", { budgetFact: { ...bestCase().budgetFact, budgetField: "lifetime_budget" as const } }],
    ["owner_mode_binding_mismatch", { budgetFact: { ...bestCase().budgetFact, ownerMode: "campaign_budget_optimization" as const } }],
    ["currency_binding_mismatch", { accountCurrency: "EUR" }],
    ["currency_binding_mismatch", { currencyExponent: 3 }],
    ["budget_fact_contract_unsupported", { budgetFact: { ...bestCase().budgetFact, contractVersion: "ARBITRARY" } }],
    ["role_identity_unbound", { role: { ...bestCase().role, providerAccountId: "act_OTHER" } }],
    ["commercial_identity_unbound", { commercial: { ...bestCase().commercial, providerAccountId: "act_OTHER" } }],
  ] as Array<[DryRunBlocker, Partial<DryRunInput>]>)("raises %s", (code, over) => {
    expect(blockersOf(bestCase(over))).toContain(code);
  });

  it("refuses a rejected or unsupported preflight contract", () => {
    const stale = blockersOf(bestCase({
      preflight: { ...bestCase().preflight!, contractVersion: "meta.provider-readback.v1" as never },
    }));
    expect(stale).toContain("preflight_contract_unsupported");
  });

  it.each([
    ["a match claimed alongside rejections", { rejections: ["read_stale"] as never }],
    ["a match claimed while not fresh", { fresh: false }],
    ["a match claimed while incomplete", { projectionComplete: false }],
    ["a match claimed alongside drift", { driftedFields: ["budgetMinorUnits"] as never }],
    ["an impossible negative age", { ageSeconds: -5 }],
  ])("fails closed on %s", (_label, patch) => {
    expect(blockersOf(bestCase({
      preflight: { ...bestCase().preflight!, ...patch } as DryRunInput["preflight"],
    }))).toContain("preflight_summary_contradictory");
  });

  it("rejects a preflight taken against another proposal's baseline", () => {
    expect(blockersOf(bestCase({
      preflightEvidence: { rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: BASELINE }, evaluatedAt: "2026-09-01T00:00:00.000Z", baselineFingerprint: "meta.provider-readback.v4:" + "0".repeat(64) },
    }))).toContain("preflight_baseline_fingerprint_mismatch");
  });

  it("rejects a preflight observation after the knowledge cutoff", () => {
    expect(blockersOf(bestCase({
      preflightEvidence: { rawAttempt: { status: "succeeded", observedAt: "2026-12-01T00:00:00.000Z", projection: BASELINE }, evaluatedAt: "2026-12-02T00:00:00.000Z", baselineFingerprint: readbackFingerprint(BASELINE) },
    }))).toContain("preflight_observation_after_cutoff");
  });

  it("rejects whitespace decision identity", () => {
    expect(blockersOf(bestCase({
      decision: { id: "   ", hash: "  ", version: " ", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 3600 },
    }))).toContain("decision_identity_incomplete");
  });

  it("reports EVERY contradiction at once, not just the structural blocker", () => {
    // The exact r2 defect: one input, many contradictions, one blocker.
    const blockers = blockersOf(bestCase({
      scope: { ...bestCase().scope, providerAccountId: "act_WRONG", entityId: "adset_WRONG" },
      budgetFact: { ...bestCase().budgetFact, currentMinorUnits: 90_000, contractVersion: "ARBITRARY" },
      commercial: { ...bestCase().commercial, selectedAction: "cut", providerAccountId: "act_OTHER" },
      decision: { id: "   ", hash: "  ", version: " ", decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 3600 },
    }));
    expect(blockers.length).toBeGreaterThan(6);
    for (const c of [
      "decision_identity_incomplete", "scope_intent_identity_mismatch",
      "amount_binding_mismatch", "direction_action_mismatch",
      "budget_fact_contract_unsupported", "commercial_identity_unbound",
    ] as DryRunBlocker[]) {
      expect(blockers, c).toContain(c);
    }
    // ...and they are NOT collapsed into intent_not_validated.
    expect(blockers.filter((b) => b === "intent_not_validated")).toHaveLength(0);
  });

  it("produces only the structural blocker when every fact agrees", () => {
    expect(buildBudgetProposalDryRun(bestCase()).blockers).toEqual(AUTHORITY_FLOOR);
  });
});

describe("D085 C2 — fingerprints cover the capability contract", () => {
  const SYNTHETIC: ProviderCapabilityContract = {
    budgetEndpointExists: true, dispatchVerbExists: true,
    supportedFields: ["daily_budget"],
    source: "SYNTHETIC TEST CAPABILITY", why: "synthetic",
  };

  it.skipIf(RESOLVER_APPROVED)("does not collide across a false and a true capability", () => {
    // r2 omitted `capability`, so blocked and preview shared one fingerprint.
    // Both runs block here — the authority floor stands under each — which is
    // exactly why the fingerprints must still separate: the capability is a
    // different fact even when the verdict is the same.
    const real = buildBudgetProposalDryRun(bestCase());
    const synthetic = buildBudgetProposalDryRun(bestCase({ capability: SYNTHETIC }));
    expect(real.status).toBe("blocked");
    expect(synthetic.status).toBe("blocked");
    expect(real.inputFingerprint).not.toBe(synthetic.inputFingerprint);
    // ...and the capability alone is what separated them.
    expect(capabilityFingerprint(PROVIDER_CAPABILITY_TODAY)).not.toBe(capabilityFingerprint(SYNTHETIC));
  });

  it("changes when any newly bound identity or amount changes", () => {
    const base = buildBudgetProposalDryRun(bestCase()).inputFingerprint;
    for (const over of [
      { role: { ...bestCase().role, providerAccountId: "act_OTHER" } },
      { commercial: { ...bestCase().commercial, providerAccountId: "act_OTHER" } },
      { preflightEvidence: { rawAttempt: { status: "succeeded", observedAt: "2026-08-30T00:00:00.000Z", projection: BASELINE }, evaluatedAt: "2026-09-01T00:00:00.000Z", baselineFingerprint: readbackFingerprint(BASELINE) } },
    ] as Partial<DryRunInput>[]) {
      expect(buildBudgetProposalDryRun(bestCase(over)).inputFingerprint).not.toBe(base);
    }
  });
});

describe("D085 C2 — the preview receipt is genuinely immutable and hashed", () => {
  const SYNTHETIC: ProviderCapabilityContract = {
    budgetEndpointExists: true, dispatchVerbExists: true,
    supportedFields: ["daily_budget"],
    source: "SYNTHETIC TEST CAPABILITY", why: "synthetic",
  };
  // Assembled directly: the canonical resolver gate is real and unapproved in
  // this environment, so the builder cannot reach a preview for ANY input.
  const built = () => {
    const { request, receipt, inputFingerprint } = assembledPreview();
    return { wouldWriteRequest: request, receiptPreview: receipt, inputFingerprint };
  };

  it("freezes the request, the receipt and every nested object", () => {
    const { wouldWriteRequest, receiptPreview } = built();
    expect(Object.isFrozen(wouldWriteRequest)).toBe(true);
    expect(Object.isFrozen(receiptPreview)).toBe(true);
    expect(Object.isFrozen(receiptPreview.redaction)).toBe(true);
    expect(Object.isFrozen(receiptPreview.rollbackPreview)).toBe(true);
    expect(Object.isFrozen(wouldWriteRequest.casPrecondition)).toBe(true);
  });

  it("rejects the exact mutation r2 permitted", () => {
    const { receiptPreview } = built();
    expect(receiptPreview.redaction.tokensIncluded).toBe(false);
    try { (receiptPreview.redaction as { tokensIncluded: boolean }).tokensIncluded = true; } catch { /* strict mode throws */ }
    expect(receiptPreview.redaction.tokensIncluded).toBe(false);
  });

  it("publishes a canonical hash that a verifier can recompute", () => {
    const run = built();
    expect(run.receiptPreview.previewContractVersion).toBe(PREVIEW_CONTRACT_VERSION);
    expect(run.receiptPreview.receiptHash).toMatch(/^meta\.budget-preview-receipt\.v12:[0-9a-f]{64}$/);
    // SELF-CONTAINED: only the returned request and receipt.
    expect(recomputePreviewHash({
      request: run.wouldWriteRequest, receipt: run.receiptPreview,
    })).toBe(run.receiptPreview.receiptHash);
    expect(run.receiptPreview.inputFingerprint).toBe(run.inputFingerprint);
    expect(run.receiptPreview.capabilityFingerprint).toBe(capabilityFingerprint(SYNTHETIC_CAP));
  });

  it("changes the recomputed hash when any nested field is tampered with", () => {
    const run = built();
    const tampered: ReceiptPreview = {
      ...run.receiptPreview,
      redaction: { ...run.receiptPreview.redaction, tokensIncluded: true as never },
    };
    expect(recomputePreviewHash({ request: run.wouldWriteRequest, receipt: tampered }))
      .not.toBe(run.receiptPreview.receiptHash);
    // ...and a swapped capability fingerprint breaks it too.
    expect(recomputePreviewHash({
      request: run.wouldWriteRequest,
      receipt: { ...run.receiptPreview, capabilityFingerprint: capabilityFingerprint(PROVIDER_CAPABILITY_TODAY) },
    })).not.toBe(run.receiptPreview.receiptHash);
    // ...and so does a swapped input binding.
    expect(recomputePreviewHash({
      request: run.wouldWriteRequest,
      receipt: { ...run.receiptPreview, inputFingerprint: "forged" },
    })).not.toBe(run.receiptPreview.receiptHash);
  });

  it("uses a preview-only idempotency namespace that cannot reserve a durable key", () => {
    const run = built();
    const durable = canonicalIntent().idempotencyKey;
    expect(run.wouldWriteRequest.idempotencyKeyPreview).not.toBe(durable);
    expect(run.wouldWriteRequest.idempotencyKeyPreview.startsWith(`${PREVIEW_KEY_NAMESPACE}-idem:`)).toBe(true);
    /*
      v9 derives the preview key from the DIGEST of the durable key, published
      as `receipt.keySeed.idempotencyKeyDigest`. Taking the digest keeps the
      durable claim unreconstructable from a preview while making the preview
      key genuinely recomputable.
    */
    const durableDigest = createHash("sha256").update(durable).digest("hex");
    expect(run.receiptPreview.keySeed!.idempotencyKeyDigest).toBe(durableDigest);
    expect(previewIdempotencyKey(durableDigest, run.inputFingerprint))
      .toBe(run.wouldWriteRequest.idempotencyKeyPreview);
    // Different proposals get different preview keys.
    expect(previewIdempotencyKey(durableDigest, "other-fingerprint"))
      .not.toBe(run.wouldWriteRequest.idempotencyKeyPreview);
  });

  it.skipIf(RESOLVER_APPROVED)("stays non-executable even as a full preview", () => {
    const run = built();
    // Execution posture lives on the assembled artefacts themselves, so an
    // assembled preview carries it without a builder verdict.
    expect(run.wouldWriteRequest.executable).toBe(false);
    expect(run.wouldWriteRequest.providerWriteAttempted).toBe(false);
    expect(run.wouldWriteRequest.providerOutcome).toBe("not_attempted");
    expect(run.receiptPreview.isDurableReceipt).toBe(false);
    expect(run.receiptPreview.executionState).toBe("validated_only");
    expect(run.receiptPreview.ctaEnabled).toBe(false);
    expect(run.receiptPreview.providerWriteAttempted).toBe(false);
    // ...and the BUILDER, for the same input, still refuses outright.
    const real = buildBudgetProposalDryRun(bestCase({ capability: SYNTHETIC }));
    expect(real.status).toBe("blocked");
    expect(real.executable).toBe(false);
    expect(real.ctaEnabled).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Correction 3 — canonical cross-binding, safety provenance, full-input proof
// ---------------------------------------------------------------------------

describe("D085 C3 — the remaining same-fact seams", () => {
  it.each([
    ["decision_hash_not_canonical", { decision: { ...bestCase().decision, hash: "h" } }],
    ["decision_hash_not_canonical", { decision: { ...bestCase().decision, hash: "D".repeat(64) } }],
    ["commercial_contract_unsupported", { commercial: { ...bestCase().commercial, profileContractVersion: "made.up.v9" } }],
    ["role_provenance_incoherent", { role: { ...bestCase().role, source: "  " } }],
    ["role_provenance_incoherent", { role: { ...bestCase().role, resolverVersion: "" } }],
    ["role_provenance_incoherent", { role: { ...bestCase().role, asOf: null } }],
    ["role_provenance_incoherent", { role: { ...bestCase().role, asOf: "2026-02-30" } }],
    ["role_provenance_incoherent", { role: { ...bestCase().role, accountScoped: false as never } }],
    ["intent_rejected_by_canonical_validator", { rawIntent: { ...bestCase().rawIntent!, effectiveAsOf: "2026-02-30" } }],
    ["intent_rejected_by_canonical_validator", { rawIntent: { ...bestCase().rawIntent!, sourceFingerprints: { configStateHash: "nope", ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64) } } }],
    ["intent_rejected_by_canonical_validator", { rawIntent: { ...bestCase().rawIntent!, sourceFingerprints: {} as never } }],
    ["intent_rejected_by_canonical_validator", { rawIntent: { ...bestCase().rawIntent!, evidenceWindow: { from: "2026-09-02", to: "2026-08-01" } } }],
    ["cas_baseline_semantically_invalid", { casBaseline: { ...BASELINE, effectiveStatus: "BANANA" } }],
    ["cas_baseline_semantically_invalid", { casBaseline: { ...BASELINE, providerAccountId: "not-an-account" } }],
  ] as Array<[DryRunBlocker, Partial<DryRunInput>]>)("raises %s", (code, over) => {
    expect(blockersOf(bestCase(over))).toContain(code);
  });

  it("still yields only the structural blocker when every canonical fact agrees", () => {
    expect(buildBudgetProposalDryRun(bestCase()).blockers).toEqual(AUTHORITY_FLOOR);
  });
});

describe("D085 C3 — the preflight summary is re-derived from raw evidence", () => {
  it("rejects a favourable summary wrapped around a WRONG observation", () => {
    // Summary says everything matched; the raw projection is another entity
    // with another amount. r3 accepted this.
    const wrong = { ...BASELINE, entityId: "23859999999999999", budgetMinorUnits: 999_999 };
    const blockers = blockersOf(bestCase({
      preflightEvidence: {
        rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:00.000Z", projection: wrong },
        evaluatedAt: "2026-09-01T00:00:00.000Z",
        baselineFingerprint: readbackFingerprint(BASELINE),
      },
    }));
    expect(blockers).toContain("preflight_summary_not_reproducible");
  });

  it("rejects a claimed read carrying no raw evidence at all", () => {
    expect(blockersOf(bestCase({ preflightEvidence: null })))
      .toContain("preflight_raw_evidence_missing");
  });

  it("rejects a stale raw observation the summary called fresh", () => {
    const blockers = blockersOf(bestCase({
      preflightEvidence: {
        rawAttempt: { status: "succeeded", observedAt: "2020-01-01T00:00:00.000Z", projection: BASELINE },
        evaluatedAt: "2026-09-01T00:00:00.000Z",
        baselineFingerprint: readbackFingerprint(BASELINE),
      },
    }));
    expect(blockers).toContain("preflight_summary_not_reproducible");
  });

  it("rejects an observation dated after its own evaluation", () => {
    expect(blockersOf(bestCase({
      preflightEvidence: {
        rawAttempt: { status: "succeeded", observedAt: "2026-09-01T00:00:05.000Z", projection: BASELINE },
        evaluatedAt: "2026-09-01T00:00:00.000Z",
        baselineFingerprint: readbackFingerprint(BASELINE),
      },
    }))).toContain("clock_ordering_invalid");
  });

  it("accepts a summary that the raw evidence actually reproduces", () => {
    expect(buildBudgetProposalDryRun(bestCase()).blockers).toEqual(AUTHORITY_FLOOR);
  });
});

describe("D085 C3 — safety provenance fails closed on both states", () => {
  it.each([
    ["a blank source", { state: "clear" as const, source: "", asOf: "2026-09-01", why: "w" }],
    ["a whitespace source", { state: "clear" as const, source: "   ", asOf: "2026-09-01", why: "w" }],
    ["a null as-of", { state: "clear" as const, source: "gov", asOf: null, why: "w" }],
    ["a rollover as-of", { state: "clear" as const, source: "gov", asOf: "2026-02-30", why: "w" }],
    ["a future as-of", { state: "clear" as const, source: "gov", asOf: "2099-01-01", why: "w" }],
    ["an engaged flag with blank provenance", { state: "engaged" as const, source: "", asOf: null, why: "w" }],
    ["an engaged flag with a rollover as-of", { state: "engaged" as const, source: "gov", asOf: "2026-02-30", why: "w" }],
  ])("degrades %s to unverified", (_label, flag) => {
    const blockers = blockersOf(bestCase({ safety: { ...bestCase().safety, killSwitch: flag } }));
    expect(blockers).toContain("kill_switch_unverified");
    expect(blockers).not.toContain("kill_switch_engaged");
  });

  it("keeps a properly-sourced engaged flag as a proved incident", () => {
    const blockers = blockersOf(bestCase({
      safety: { ...bestCase().safety, killSwitch: engagedSafetyFlag("readEffectiveMetaWriteGovernance", "2026-09-01T00:00:00.000Z", "Zero-base Meta stop") },
    }));
    expect(blockers).toContain("kill_switch_engaged");
    expect(blockers).not.toContain("kill_switch_unverified");
  });

  it("applies the same rule to admission", () => {
    expect(blockersOf(bestCase({ safety: { ...bestCase().safety, admission: { state: "engaged", source: "", asOf: null, why: "w" } } })))
      .toContain("admission_unverified");
    expect(blockersOf(bestCase({ safety: { ...bestCase().safety, admission: engagedSafetyFlag("health", "2026-09-01T00:00:00.000Z", "table_budget_exceeded") } })))
      .toContain("admission_blocked");
  });
});

describe("D085 C3 — the fingerprint covers the whole answer", () => {
  it("changes when the raw intent changes the derived durable key", () => {
    // r3 omitted it, yet it changes the assembled request.
    const a = buildBudgetProposalDryRun(bestCase()).inputFingerprint;
    const b = buildBudgetProposalDryRun(bestCase({
      rawIntent: { ...bestCase().rawIntent!, percent: 15 },
    })).inputFingerprint;
    expect(a).not.toBe(b);
  });

  it("changes the preview request AND hash when the raw intent changes", () => {
    const SYN: ProviderCapabilityContract = {
      budgetEndpointExists: true, dispatchVerbExists: true,
      supportedFields: ["daily_budget"], source: "SYNTHETIC", why: "synthetic",
    };
    void SYN;
    // Assembled directly: the raw intent is what must separate the artefacts,
    // and the builder cannot reach a preview for either input.
    const one = assembledPreview();
    const two = assembledPreview({ percent: 15, rawIntent: { ...bestCase().rawIntent!, percent: 15 } });
    expect(one.request.idempotencyKeyPreview).not.toBe(two.request.idempotencyKeyPreview);
    expect(one.receipt.receiptHash).not.toBe(two.receipt.receiptHash);
    expect(one.inputFingerprint).not.toBe(two.inputFingerprint);
    expect(one.request.proposedMinorUnits).not.toBe(two.request.proposedMinorUnits);
  });

  it("is insensitive to key insertion order", () => {
    const base = bestCase();
    // Same facts, different literal key order.
    const reordered: DryRunInput = {
      ...base,
      scope: {
        accountSelectionWhy: base.scope.accountSelectionWhy,
        accountIsWriteScope: base.scope.accountIsWriteScope,
        parentCampaignId: base.scope.parentCampaignId,
        entityId: base.scope.entityId,
        entityGrain: base.scope.entityGrain,
        providerAccountId: base.scope.providerAccountId,
        business: base.scope.business,
        businessId: base.scope.businessId,
      },
    };
    expect(buildBudgetProposalDryRun(reordered).inputFingerprint)
      .toBe(buildBudgetProposalDryRun(base).inputFingerprint);
  });
});


describe("D085 C3 — the ROUTE mapping, as a pure function", () => {
  const NOW = "2026-09-01T00:00:00.000Z";
  const gov = (over: Partial<Parameters<typeof governanceToKillSwitchFlag>[0]> = {}) =>
    governanceToKillSwitchFlag({
      killSwitchEngaged: false, killSwitchReason: null, verified: true,
      controlsConfigured: true, writeBlocked: false, blockReason: null,
      evaluatedAt: NOW, ...over,
    });

  it("reports a known engaged kill switch with source and as-of", () => {
    const f = gov({ killSwitchEngaged: true, killSwitchReason: "Zero-base Meta stop" });
    expect(f.state).toBe("engaged");
    expect(f.source).toBe("readEffectiveMetaWriteGovernance");
    expect(f.asOf).toBe(NOW);
    expect(f.why).toContain("Zero-base Meta stop");
  });

  it("clears only a VERIFIED read over a CONFIGURED control", () => {
    expect(gov().state).toBe("clear");
    expect(gov({ verified: false }).state).toBe("unknown");
    expect(gov({ controlsConfigured: false }).state).toBe("unknown");
  });

  it("treats a governance write-block as engaged, not clear", () => {
    const f = gov({ writeBlocked: true, blockReason: "control_state_unavailable" });
    expect(f.state).toBe("engaged");
    expect(f.why).toContain("control_state_unavailable");
  });

  it("never clears an unverified read even when the switch reads false", () => {
    // The exact r2/r3 defect.
    const f = gov({ verified: false, blockReason: "control_state_unavailable" });
    expect(f.state).not.toBe("clear");
    expect(f.source).toBeNull();
  });

  const adm = (over: Partial<Parameters<typeof admissionToSafetyFlag>[0]> = {}) =>
    admissionToSafetyFlag({
      status: "fresh", allowed: true, reason: "ok",
      evaluatedAt: NOW, serverEvaluatedAt: NOW, ...over,
    });

  it("reports a proved admission block as engaged", () => {
    const f = adm({ status: "blocked", allowed: false, reason: "table_budget_exceeded" });
    expect(f.state).toBe("engaged");
    expect(f.why).toContain("table_budget_exceeded");
    expect(f.asOf).toBe(NOW);
  });

  it.each(["unavailable", "missing", "invalid", "stale"])(
    "never fabricates an incident from a %s dimension", (status) => {
      expect(adm({ status, allowed: false, reason: "not evaluated" }).state).toBe("unknown");
    });

  it("clears only a fresh or warning dimension that actually allows", () => {
    expect(adm().state).toBe("clear");
    expect(adm({ status: "warning" }).state).toBe("clear");
    expect(adm({ status: "fresh", allowed: false }).state).toBe("unknown");
  });

  it("falls back to the server instant when the dimension carries no as-of", () => {
    expect(adm({ evaluatedAt: null }).asOf).toBe(NOW);
    expect(adm({ evaluatedAt: "" }).asOf).toBe(NOW);
  });

  it("feeds the builder so degraded provenance becomes an unverified blocker", () => {
    const unverified = gov({ verified: false });
    expect(blockersOf(bestCase({ safety: { ...bestCase().safety, killSwitch: unverified } })))
      .toContain("kill_switch_unverified");
    const engaged = gov({ killSwitchEngaged: true, killSwitchReason: "Zero-base Meta stop" });
    expect(blockersOf(bestCase({ safety: { ...bestCase().safety, killSwitch: engaged } })))
      .toContain("kill_switch_engaged");
  });
});


// ---------------------------------------------------------------------------
// Correction 4 — forged intents, derived preflight, readiness, self-contained proof
// ---------------------------------------------------------------------------

const SYN_CAP: ProviderCapabilityContract = {
  budgetEndpointExists: true, dispatchVerbExists: true,
  supportedFields: ["daily_budget"],
  source: "SYNTHETIC TEST CAPABILITY", why: "synthetic",
};

describe("D085 C4 — a forged intent can never reach a preview", () => {
  const statusOf = (over: Partial<DryRunInput>) =>
    buildBudgetProposalDryRun(bestCase({ capability: SYN_CAP, ...over }));

  it.skipIf(RESOLVER_APPROVED)("the favourable synthetic case blocks on the authority floor ALONE", () => {
    // r6 previewed here. With the resolver gate real, the most favourable
    // input this environment can express still blocks — and on exactly the
    // authority gate, with no other requirement open. That is the honest
    // reading of "the fixture is otherwise coherent".
    const run = statusOf({});
    expect(run.status).toBe("blocked");
    expect(run.blockers).toEqual(["role_authority_not_canonical"]);
    expect(run.wouldWriteRequest).toBeNull();
    expect(run.receiptPreview).toBeNull();
    // The one open requirement names the environment, not the fixture.
    expect(run.blockerDetail[0].why).toContain("approved");
  });

  it("refuses a forged proposed amount supplied as a validated cast", () => {
    // r4: proposed 999,999 on a 10% change from 10,000 previewed with NO blockers.
    const forged = { ...canonicalIntent(), proposedMinorUnits: 999_999, deltaMinorUnits: 989_999 };
    const run = statusOf({ intent: forged });
    expect(run.status).toBe("blocked");
    expect(run.blockers).toContain("intent_not_canonically_equal");
    expect(run.wouldWriteRequest).toBeNull();
  });

  it.each([
    ["a forged exponent", { currencyExponent: 3 }],
    ["a forged currency", { accountCurrency: "EUR" }],
  ] as Array<[string, Partial<DryRunInput>]>)("refuses %s against the canonical registry", (_l, over) => {
    const run = statusOf(over);
    expect(run.status).toBe("blocked");
  });

  it.each([
    ["intent clocks after the origin", { effectiveAsOf: "2026-09-02", knowledgeAsOf: "2026-09-02", authorityEvidenceAsOf: "2026-09-02" }],
    ["an empty fingerprint object", { sourceFingerprints: {} as never }],
    ["a non-hex fingerprint", { sourceFingerprints: { configStateHash: "forged", ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64) } }],
    ["an extra fingerprint key", { sourceFingerprints: { configStateHash: "a".repeat(64), ownerStateHash: "b".repeat(64), roleAuthorityHash: "c".repeat(64), extra: "d".repeat(64) } as never }],
    ["a reversed evidence window", { evidenceWindow: { from: "2026-09-02", to: "2026-08-01" } }],
    ["an evidence window ending after the origin", { evidenceWindow: { from: "2026-08-01", to: "2026-09-05" } }],
    ["a rollover effective date", { effectiveAsOf: "2026-02-30" }],
  ])("the canonical validator rejects %s", (_label, patch) => {
    const run = statusOf({ rawIntent: { ...bestCase().rawIntent!, ...patch } });
    expect(run.status).toBe("blocked");
    expect(run.blockers).toContain("intent_rejected_by_canonical_validator");
    expect(run.wouldWriteRequest).toBeNull();
  });

  it("refuses forged identity keys on a cast intent", () => {
    const run = statusOf({ intent: { ...canonicalIntent(), intentKey: "forged", idempotencyKey: "forged" } });
    expect(run.blockers).toContain("intent_not_canonically_equal");
  });

  it("refuses a validated cast with no raw input to re-derive from", () => {
    expect(statusOf({ rawIntent: null, intent: canonicalIntent() }).blockers)
      .toContain("intent_raw_input_missing");
  });

  it("refuses the whole forged bundle at once", () => {
    const run = statusOf({
      currencyExponent: 3,
      intent: { ...canonicalIntent(), proposedMinorUnits: 999_999, idempotencyKey: "forged" },
      rawIntent: { ...bestCase().rawIntent!, sourceFingerprints: {} as never, evidenceWindow: { from: "2026-09-02", to: "2026-08-01" } },
    });
    expect(run.status).toBe("blocked");
    expect(run.blockers.length).toBeGreaterThan(1);
    expect(run.wouldWriteRequest).toBeNull();
  });
});

describe("D085 C4 — the derived preflight is the authority", () => {
  const statusOf = (over: Partial<DryRunInput>) =>
    buildBudgetProposalDryRun(bestCase({ capability: SYN_CAP, ...over }));

  it("catches the 10-vs-0 age lie", () => {
    const run = statusOf({ preflight: { ...bestCase().preflight!, ageSeconds: 10 } });
    expect(run.blockers).toContain("preflight_summary_not_reproducible");
    const detail = run.blockerDetail.find((d) => d.code === "preflight_summary_not_reproducible");
    expect(detail?.why).toContain("published age 10s");
    expect(detail?.why).toContain("derived age 0s");
  });

  it.each([
    ["a forged claimed status", { claimedStatus: "failed" as const }],
    ["a forged why", { why: "totally fine" }],
    ["forged drift detail", { driftDetail: [{ field: "budgetMinorUnits" as const, baseline: 1, observed: 2 }] }],
  ])("catches %s in the summary", (_l, patch) => {
    expect(statusOf({ preflight: { ...bestCase().preflight!, ...patch } }).blockers)
      .toContain("preflight_summary_not_reproducible");
  });

  it("blocks an observation after the historical ORIGIN even when before knowledge", () => {
    // r4 checked only the knowledge cutoff, so a 2026-08-31 proposal could be
    // justified by a 2026-09-01 observation.
    const run = statusOf({
      originDate: "2026-08-31",
      decision: { ...bestCase().decision, decidedAt: "2026-08-31T00:00:00.000Z", maxAgeSeconds: 8_640_000 },
      role: { ...bestCase().role, asOf: "2026-08-31" },
      budgetFact: { ...bestCase().budgetFact, observedAt: "2026-08-31", capturedAt: "2026-08-31T00:00:00.000Z" },
      rawIntent: { ...bestCase().rawIntent!, originDate: "2026-08-31", effectiveAsOf: "2026-08-31", knowledgeAsOf: "2026-08-31", authorityEvidenceAsOf: "2026-08-31", evidenceWindow: { from: "2026-08-01", to: "2026-08-31" } },
    });
    expect(run.blockers).toContain("preflight_observation_after_cutoff");
    expect(run.status).toBe("blocked");
  });
});

describe("D085 C4 — governance readiness, safety and capability at runtime", () => {
  it("returns unknown for an unverified read even when every boolean is truthy", () => {
    const f = governanceToKillSwitchFlag({
      killSwitchEngaged: true, killSwitchReason: "x", verified: false,
      controlsConfigured: false, writeBlocked: true, blockReason: "read_failed",
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(f.state).toBe("unknown");
    expect(f.source).toBeNull();
  });

  it("returns unknown for an unconfigured control even when engaged", () => {
    expect(governanceToKillSwitchFlag({
      killSwitchEngaged: true, killSwitchReason: "x", verified: true,
      controlsConfigured: false, writeBlocked: false, blockReason: null,
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    }).state).toBe("unknown");
  });

  it("still reports a VERIFIED, CONFIGURED engaged switch as engaged", () => {
    const f = governanceToKillSwitchFlag({
      killSwitchEngaged: true, killSwitchReason: "Zero-base Meta stop", verified: true,
      controlsConfigured: true, writeBlocked: true, blockReason: "business_kill_switch",
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(f.state).toBe("engaged");
    expect(f.why).toContain("Zero-base Meta stop");
  });

  it("degrades an unrecognised safety state instead of treating it as clear", () => {
    const run = buildBudgetProposalDryRun(bestCase({
      capability: SYN_CAP,
      safety: { ...bestCase().safety, killSwitch: { state: "banana", source: "test", asOf: "2026-09-01", why: "w" } as never },
    }));
    expect(run.blockers).toContain("kill_switch_unverified");
    expect(run.status).toBe("blocked");
  });

  it.each([
    ["a non-boolean endpoint flag", { budgetEndpointExists: 1 as never }],
    ["a non-boolean verb flag", { dispatchVerbExists: "yes" as never }],
    ["a blank source", { source: "" }],
    ["a blank reason", { why: "" }],
    ["an unsupported field", { supportedFields: ["weekly_budget"] as never }],
  ])("rejects a capability with %s", (_l, patch) => {
    const cap = { ...SYN_CAP, ...patch } as ProviderCapabilityContract;
    expect(validateCapability(cap).valid).toBe(false);
    expect(capabilityPermitsWrite(cap)).toBe(false);
  });

  it("keeps the PRODUCTION capability well-formed but non-permitting", () => {
    expect(validateCapability(PROVIDER_CAPABILITY_TODAY).valid).toBe(true);
    expect(capabilityPermitsWrite(PROVIDER_CAPABILITY_TODAY)).toBe(false);
    expect(buildBudgetProposalDryRun(bestCase()).blockers).toEqual(AUTHORITY_FLOOR);
  });
});

describe("D085 C4 — evidence BEFORE the origin is legitimate", () => {
  it("accepts authority evidence dated before the origin", () => {
    // A draft of C4's hardening inverted its own comparison and rejected
    // evidence that was legitimately EARLIER than the origin, which broke the
    // accepted D081 worked example. Pin the direction.
    const v = validateBudgetIntent(
      { ...bestCase().rawIntent!, originDate: "2026-09-01", authorityEvidenceAsOf: "2026-08-28", maxAuthorityEvidenceAgeDays: 60 },
      bestCase().knownBindings,
    );
    expect(v.status).toBe("valid");
  });

  it("still rejects authority evidence dated AFTER the origin", () => {
    const v = validateBudgetIntent(
      { ...bestCase().rawIntent!, authorityEvidenceAsOf: "2026-09-05" },
      bestCase().knownBindings,
    );
    expect(v.status).toBe("rejected");
    if (v.status === "rejected") expect(v.rejections).toContain("authority_evidence_future");
  });
});

describe("D085 C4 — the receipt proof is self-contained", () => {
  // Assembled directly — the builder cannot reach a preview in an environment
  // that approves no resolver identity, and the gate is not weakened to make
  // one reachable.
  const built = () => {
    const { request, receipt, inputFingerprint } = assembledPreview();
    return { wouldWriteRequest: request, receiptPreview: receipt, inputFingerprint };
  };

  it("recomputes from ONLY the returned request and receipt", () => {
    const run = built();
    expect(recomputePreviewHash({ request: run.wouldWriteRequest, receipt: run.receiptPreview }))
      .toBe(run.receiptPreview.receiptHash);
  });

  it("publishes its own input and capability binding", () => {
    const run = built();
    expect(run.receiptPreview.inputFingerprint).toBe(run.inputFingerprint);
    expect(run.receiptPreview.capabilityFingerprint).toBe(capabilityFingerprint(SYNTHETIC_CAP));
    expect(run.receiptPreview.capabilitySnapshot?.source).toBe(SYNTHETIC_CAP.source);
    expect(run.receiptPreview.previewContractVersion).toBe(PREVIEW_CONTRACT_VERSION);
  });

  it.each([
    ["the capability binding", (r: ReceiptPreview) => ({ ...r, capabilityFingerprint: capabilityFingerprint(PROVIDER_CAPABILITY_TODAY) })],
    ["the input binding", (r: ReceiptPreview) => ({ ...r, inputFingerprint: "forged" })],
    ["nested redaction", (r: ReceiptPreview) => ({ ...r, redaction: { ...r.redaction, tokensIncluded: true as never } })],
    ["the before amount", (r: ReceiptPreview) => ({ ...r, before: { ...r.before, minorUnits: 1 } })],
    ["the rollback preview", (r: ReceiptPreview) => ({ ...r, rollbackPreview: { ...r.rollbackPreview, restoreMinorUnits: 1 } })],
  ])("detects tampering with %s", (_l, tamper) => {
    const run = built();
    expect(recomputePreviewHash({ request: run.wouldWriteRequest, receipt: tamper(run.receiptPreview) }))
      .not.toBe(run.receiptPreview.receiptHash);
  });

  it("is insensitive to receipt key insertion order", () => {
    const run = built();
    const r = run.receiptPreview;
    const entries = Object.entries(r as unknown as Record<string, unknown>).reverse();
    const reordered = Object.fromEntries(entries) as unknown as ReceiptPreview;
    expect(recomputePreviewHash({ request: run.wouldWriteRequest, receipt: reordered }))
      .toBe(r.receiptHash);
  });

  it("stays deeply frozen and preview-namespaced", () => {
    const run = built();
    expect(Object.isFrozen(run.receiptPreview)).toBe(true);
    expect(Object.isFrozen(run.receiptPreview.redaction)).toBe(true);
    expect(run.receiptPreview.previewKey.startsWith(`${PREVIEW_KEY_NAMESPACE}:`)).toBe(true);
    expect(run.wouldWriteRequest.idempotencyKeyPreview).not.toBe(canonicalIntent().idempotencyKey);
    expect(run.wouldWriteRequest.executable).toBe(false);
    expect(run.receiptPreview.ctaEnabled).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Correction 5 — the 27 rows a fresh probe drove through r5, made permanent
// ---------------------------------------------------------------------------

/**
 * Every row below returned `would_write_available` with an EMPTY blocker list
 * against r5. Codex's probe was a scratch file that was deleted after running;
 * these are the permanent replacements.
 */
describe("D085 C5 — the 27 r5 escapes all block", () => {
  const run = (over: Partial<DryRunInput>) =>
    buildBudgetProposalDryRun(bestCase({ capability: SYN_CAP, ...over }));
  const blocked = (over: Partial<DryRunInput>) => {
    const r = run(over);
    const label = JSON.stringify(over).slice(0, 90);
    expect(r.status, label).toBe("blocked");
    expect(r.wouldWriteRequest).toBeNull();
    expect(r.receiptPreview).toBeNull();
    // The mutation must contribute a blocker of its OWN. Passing merely
    // because the authority floor already blocks would prove nothing.
    const beyondFloor = r.blockers.filter((b) => b !== "role_authority_not_canonical");
    expect(beyondFloor.length, `${label} added no blocker beyond the authority floor`).toBeGreaterThan(0);
    return r.blockers;
  };
  const allSteps = (v: unknown) =>
    Object.fromEntries(WRITE_SAFETY_STEPS.map((k) => [k, v])) as DryRunInput["writeSafety"];

  it.skipIf(RESOLVER_APPROVED)("baseline: the fixture blocks on the authority floor and nothing else", () => {
    // r5's table rested on a previewing baseline, so every row read as "this
    // mutation is what blocked it". With the resolver gate real, the baseline
    // itself blocks — so each row below asserts its OWN blocker by name
    // rather than resting on a status change.
    const r = run({});
    expect(r.status).toBe("blocked");
    expect(r.blockers).toEqual(["role_authority_not_canonical"]);
    expect(campaignContextAuthorityResolverVersion()).toBeNull();
  });

  // 1 — write-safety ceremony
  it.each([
    ["an empty ceremony", {} as DryRunInput["writeSafety"]],
    ["every step 'banana'", allSteps("banana")],
    ["every step not_applicable", allSteps("not_applicable")],
    ["every step missing", allSteps("missing")],
    ["every step undefined", allSteps(undefined)],
    ["a ceremony that is not an object", null as never],
    ["an extra unknown step", { ...allSteps("satisfied"), surprise_step: "satisfied" } as never],
  ])("blocks %s", (_l, writeSafety) => {
    const b = blocked({ writeSafety });
    expect(b.some((x) => x === "write_safety_step_missing" || x === "write_safety_ceremony_malformed")).toBe(true);
  });

  it("keeps gatesSatisfied/gatesMissing a complete partition", () => {
    const v = validateWriteSafetyCeremony(allSteps("satisfied"));
    expect(v.satisfiedSteps.length + v.missingSteps.length).toBe(WRITE_SAFETY_STEPS.length);
    expect(v.satisfied).toBe(true);
    const half = validateWriteSafetyCeremony({ ...allSteps("satisfied"), persisted_preflight: "missing" });
    expect(half.satisfiedSteps.length + half.missingSteps.length).toBe(WRITE_SAFETY_STEPS.length);
    expect(half.missingSteps).toContain("persisted_preflight");
  });

  // 2 — authorised intent carrying blockers
  it("blocks an authorised intent that also carries blockers", () => {
    expect(blocked({ rawIntent: { ...bestCase().rawIntent!, authorityStatus: "authorised", blockerCodes: ["cap_unverified"] } }))
      .toContain("intent_rejected_by_canonical_validator");
  });

  // 3 — intent knowledge cutoff behind its own evidence
  it("blocks an intent whose knowledge date precedes its own evidence", () => {
    blocked({
      rawIntent: {
        ...bestCase().rawIntent!, originDate: "2026-08-31", knowledgeAsOf: "2026-08-01",
        effectiveAsOf: "2026-08-31", authorityEvidenceAsOf: "2026-08-31",
        evidenceWindow: { from: "2026-08-01", to: "2026-08-31" },
      },
    });
  });

  // 4 — daily intent carrying a lifetime flight
  it("blocks a daily intent carrying a lifetime flight", () => {
    blocked({ rawIntent: { ...bestCase().rawIntent!, lifetimeSchedule: { startDate: "2026-08-01", endDate: "2026-09-01" } } });
  });

  it("refuses a LIFETIME preview outright, with an honest reason", () => {
    const b = blocked({ budgetFact: { ...bestCase().budgetFact, budgetField: "lifetime_budget", scheduleStart: "2026-08-01", scheduleEnd: "2026-09-01" } });
    expect(b).toContain("lifetime_preview_unsupported");
  });

  /*
    5 — ROLE AUTHORITY.

    Every role defect shares ONE blocker code, so a row that only asserted the
    code would pass on the environment's unapproved resolver alone. Each row
    therefore names the exact problem the validator must report, and the
    assertion below proves the mutation was detected INDEPENDENTLY of the
    resolver gate.
  */
  const blockedRole = (patch: Record<string, unknown>, expectedProblem: string) => {
    const r = run({ role: { ...bestCase().role, ...patch } as DryRunInput["role"] });
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("role_authority_not_canonical");
    const why = r.blockerDetail.find((d) => d.code === "role_authority_not_canonical")!.why;
    expect(why, `expected the role blocker to name: ${expectedProblem}`).toContain(expectedProblem);
    // Independence: the SAME mutation is rejected by the pure validator even
    // when the resolver identity is stipulated to be approved.
    const direct = validateRoleAuthority({ ...bestCase().role, ...patch } as DryRunInput["role"]);
    expect(direct.canonical).toBe(false);
    expect(direct.problems.join("; "), `expected the validator to name: ${expectedProblem}`).toContain(expectedProblem);
    return r.blockers;
  };

  it.each([
    ["a null role", { role: null }, "is not a canonical automatic campaign role"],
    ["a commercial action as a role", { role: "scale" }, "is not a canonical automatic campaign role"],
    ["a manual label source", { source: "manual_label" }, "manual labels and campaign names never carry authority"],
    ["a campaign-name source", { source: "campaign_name" }, "manual labels and campaign names never carry authority"],
    ["an arbitrary source", { source: "automatic" }, "manual labels and campaign names never carry authority"],
    ["low confidence", { confidence: "low" }, "role confidence"],
    ["no resolver version", { resolverVersion: "" }, "no resolver version is carried"],
    ["a non-canonical producer", { producer: "operator" }, "role producer"],
    ["a resolution that does not satisfy authority", { satisfiesRoleAuthority: false }, "satisfiesRoleAuthority is false"],
    ["a resolution carrying blockers", { authorityBlockers: ["role_source_not_system_inferred"] }, "carries blockers"],
  ])("blocks %s", (_l, patch, expected) => {
    blockedRole(patch as Record<string, unknown>, expected as string);
  });

  /*
    THE SIX r6 ESCAPES, verbatim.

    Each of these returned `canonical: true` under r6's optional checks: four
    deletions of authority-bearing fields, one non-array blocker container, and
    an arbitrary resolver identity.
  */
  it.each([
    ["a deleted producer", { producer: undefined }, "role producer"],
    ["a deleted satisfiesRoleAuthority", { satisfiesRoleAuthority: undefined }, "satisfiesRoleAuthority is undefined"],
    ["a deleted authorityBlockers", { authorityBlockers: undefined }, "authorityBlockers is undefined, not an array"],
    ["a deleted campaignId", { campaignId: undefined }, "no campaignId"],
    ["a non-array blocker container", { authorityBlockers: "none" }, "authorityBlockers is \"none\", not an array"],
    ["an arbitrary resolver identity", { resolverVersion: "banana" }, "is not an approved campaign-context resolver identity"],
  ])("blocks %s, which r6 accepted", (_l, patch, expected) => {
    blockedRole(patch as Record<string, unknown>, expected as string);
  });

  it.skipIf(RESOLVER_APPROVED)("does not accept even the CANONICAL resolver identity without approval", () => {
    // The gate is environmental, not textual. The fixture already carries the
    // canonical identity, and it still does not validate.
    expect(bestCase().role.resolverVersion).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    expect(campaignContextAuthorityResolverVersion()).toBeNull();
    const direct = validateRoleAuthority(bestCase().role);
    expect(direct.canonical).toBe(false);
    expect(direct.problems.join("; ")).toContain("approved: none in this environment");
  });

  it.each([false, null, undefined, 0, "true", {}, []])(
    "rejects a non-literal-boolean accountScoped: %s", (accountScoped) => {
      const direct = validateRoleAuthority({ ...bestCase().role, accountScoped } as DryRunInput["role"]);
      expect(direct.canonical).toBe(false);
      expect(direct.problems.join("; ")).toContain("not account-scoped");
    });

  it.each([null, undefined, "yes", 1, {}, []])(
    "rejects a non-literal-boolean resolved: %s", (resolved) => {
      const direct = validateRoleAuthority({ ...bestCase().role, resolved } as DryRunInput["role"]);
      expect(direct.canonical).toBe(false);
      expect(direct.problems.join("; ")).toContain("not a literal boolean");
    });

  it.each([null, undefined, "role", 7, []])("rejects a role context that is %s", (role) => {
    const direct = validateRoleAuthority(role as unknown as DryRunInput["role"]);
    expect(direct.canonical).toBe(false);
    expect(direct.problems.length).toBeGreaterThan(0);
  });

  // 6 — commercial coherence
  it.each([
    ["non-empty blockers on an eligible verdict", { blockerCodes: ["evidence_floor"] }],
    ["a null selected action", { selectedAction: null }],
    ["an ineligible code", { code: "cut_ineligible" }],
    ["eligible false", { eligible: false }],
    ["evidence floors not exactly true", { evidenceFloorsClear: null }],
    ["change safety not exactly true", { changeSafetyClear: null }],
  ])("blocks %s", (_l, patch) => {
    expect(blocked({ commercial: { ...bestCase().commercial, ...patch } as DryRunInput["commercial"] }))
      .toContain("commercial_verdict_incoherent");
  });

  // 7 — registry and unit confidence
  it("blocks an arbitrary currency registry version", () => {
    expect(blocked({ currencyRegistryVersion: "made-up-registry" })).toContain("currency_registry_not_canonical");
  });
  it.each([["inferred", "inferred"], ["unknown", "unknown"], ["banana", "banana"]])(
    "blocks unit confidence %s", (_l, unitConfidence) => {
      expect(blocked({ unitConfidence: unitConfidence as never })).toContain("unit_confidence_not_exact");
    });

  // 8 — budget-fact provenance
  it.each([
    ["a null observedAt", { observedAt: null }],
    ["a null capturedAt", { capturedAt: null }],
    ["a blank lineage", { lineage: "  " }],
    ["a blank availability reason", { availabilityWhy: "" }],
  ])("blocks an available fact with %s", (_l, patch) => {
    expect(blocked({ budgetFact: { ...bestCase().budgetFact, ...patch } as DryRunInput["budgetFact"] }))
      .toContain("budget_fact_provenance_incomplete");
  });

  // 9 — truthy non-boolean casts
  it.each([
    ["accountIsWriteScope", { scope: { ...bestCase().scope, accountIsWriteScope: "yes" as never } }],
    ["budgetFact.available", { budgetFact: { ...bestCase().budgetFact, available: 1 as never } }],
    ["role.resolved", { role: { ...bestCase().role, resolved: "yes" as never } }],
  ])("blocks a truthy non-boolean %s", (_l, over) => {
    expect(blocked(over as Partial<DryRunInput>)).toContain("runtime_boolean_not_literal");
  });

  // 10 & 11 — clocks after a historical origin but before knowledge
  const historical = (): Partial<DryRunInput> => ({
    originDate: "2026-08-31",
    knowledgeAsOf: "2026-09-01T00:00:00.000Z",
    decision: { ...bestCase().decision, decidedAt: "2026-08-31T00:00:00.000Z", maxAgeSeconds: 8_640_000 },
    role: { ...bestCase().role, asOf: "2026-08-31" },
    budgetFact: { ...bestCase().budgetFact, observedAt: "2026-08-31", capturedAt: "2026-08-31T00:00:00.000Z" },
    rawIntent: { ...bestCase().rawIntent!, originDate: "2026-08-31", effectiveAsOf: "2026-08-31", knowledgeAsOf: "2026-08-31", authorityEvidenceAsOf: "2026-08-31", evidenceWindow: { from: "2026-08-01", to: "2026-08-31" } },
    preflightEvidence: {
      rawAttempt: { status: "succeeded", observedAt: "2026-08-31T00:00:00.000Z", projection: BASELINE },
      evaluatedAt: "2026-08-31T00:00:00.000Z", baselineFingerprint: readbackFingerprint(BASELINE),
    },
    preflight: { ...bestCase().preflight!, ageSeconds: 0 },
  });

  it("blocks a safety as-of after a historical origin but before knowledge", () => {
    const b = blocked({
      ...historical(),
      safety: { ...bestCase().safety, killSwitch: clearSafetyFlag("gov", "2026-09-01T00:00:00.000Z", "disengaged") },
    });
    expect(b).toContain("safety_provenance_after_origin");
  });

  it("blocks a decision decided after a historical origin but before knowledge", () => {
    const b = blocked({
      ...historical(),
      decision: { ...bestCase().decision, decidedAt: "2026-09-01T00:00:00.000Z", maxAgeSeconds: 8_640_000 },
    });
    expect(b).toContain("decision_after_origin");
  });
});

describe("D085 C5 — the three contract functions are strict at runtime", () => {
  it('governanceToKillSwitchFlag refuses the string "yes" as proof', () => {
    const f = governanceToKillSwitchFlag({
      killSwitchEngaged: false, killSwitchReason: null,
      verified: "yes" as never, controlsConfigured: "yes" as never,
      writeBlocked: false, blockReason: null, evaluatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(f.state).toBe("unknown");
    expect(f.source).toBeNull();
  });

  it('admissionToSafetyFlag refuses the string "yes" as proof', () => {
    const f = admissionToSafetyFlag({
      status: "fresh", allowed: "yes" as never, reason: "ok",
      evaluatedAt: "2026-09-01T00:00:00.000Z", serverEvaluatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(f.state).toBe("unknown");
  });

  it("validateCapability actually uses its requestedField argument", () => {
    const dailyOnly: ProviderCapabilityContract = {
      budgetEndpointExists: true, dispatchVerbExists: true,
      supportedFields: ["daily_budget"], source: "SYNTHETIC", why: "synthetic",
    };
    expect(validateCapability(dailyOnly, "lifetime_budget").valid).toBe(false);
    expect(validateCapability(dailyOnly, "lifetime_budget").problems.join(" "))
      .toContain("does not include the requested field lifetime_budget");
    expect(validateCapability(dailyOnly, "daily_budget").valid).toBe(true);
    // Omitting the argument still validates well-formedness only.
    expect(validateCapability(dailyOnly).valid).toBe(true);
  });
});

describe("D085 C5 — the builder is TOTAL on malformed boundary values", () => {
  it.each([
    ["a null scope grain", { scope: { ...bestCase().scope, entityGrain: "banana" as never } }],
    ["a numeric direction", { direction: 7 as never }],
    ["a null safety map", { safety: null as never }],
    ["a null capability", { capability: null as never }],
    ["a null writeSafety", { writeSafety: null as never }],
    ["a null budgetFact", { budgetFact: null as never }],
    ["a null role", { role: null as never }],
    ["a null commercial", { commercial: null as never }],
  ])("returns a blocked result rather than throwing on %s", (_l, over) => {
    let result: ReturnType<typeof buildBudgetProposalDryRun> | null = null;
    expect(() => { result = buildBudgetProposalDryRun(bestCase({ capability: SYN_CAP, ...(over as Partial<DryRunInput>) })); }).not.toThrow();
    expect(result!.status).toBe("blocked");
    expect(result!.wouldWriteRequest).toBeNull();
    expect(result!.blockers.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Correction 6 — the closed-world contract, made real
// ---------------------------------------------------------------------------

describe("D085 C6 — commercial coherence is a closed world", () => {
  const run = (over: Partial<DryRunInput>) => buildBudgetProposalDryRun(bestCase({ capability: SYNTHETIC_CAP, ...over }));
  const commercialWhy = (patch: Record<string, unknown>) => {
    const r = run({ commercial: { ...bestCase().commercial, ...patch } as DryRunInput["commercial"] });
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("commercial_verdict_incoherent");
    return r.blockerDetail.find((d) => d.code === "commercial_verdict_incoherent")!.why;
  };

  it("blocks an ineligibility REASON on an eligible verdict", () => {
    // r6 checked `code` and never `reason`, so `reason: "not eligible"` was
    // coherent — an eligible verdict carrying its own refusal.
    expect(commercialWhy({ reason: "not eligible" })).toContain("ineligibility reason");
  });

  it.each([
    ["a string blocker container", "none"],
    ["an object blocker container", {}],
    ["a null blocker container", null],
    ["an undefined blocker container", undefined],
    ["a numeric blocker container", 7],
  ])("blocks %s WITHOUT throwing", (_l, blockerCodes) => {
    // Correction 7 moved container shape to the one boundary pass, so the
    // honest code is now `input_container_malformed` — a wrong-shaped
    // container is not a claim about commercial coherence. The reason still
    // names the exact field, and it still never throws or reads as "empty".
    const call = () => run({ commercial: { ...bestCase().commercial, blockerCodes } as DryRunInput["commercial"] });
    expect(call).not.toThrow();
    const r = call();
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("input_container_malformed");
    const why = r.blockerDetail.find((d) => d.code === "input_container_malformed")!.why;
    expect(why).toContain("commercial.blockerCodes");
    expect(why).toContain("not an array");
  });

  it.each([
    ["floors clear", true],
    ["floors NOT clear", false],
  ])("blocks a malformed blocker container with %s, in either branch", (_l, evidenceFloorsClear) => {
    // r7 threw only in the second branch: `evidenceFloorsClear:false` selected
    // a message-building path that read `.length` on the null container.
    const call = () => run({ commercial: { ...bestCase().commercial, blockerCodes: null, evidenceFloorsClear } as never });
    expect(call).not.toThrow();
    expect(call().blockers).toContain("input_container_malformed");
  });

  it.each([
    ["a missing businessId", { businessId: undefined }],
    ["a missing account", { providerAccountId: undefined }],
    ["a blank account", { providerAccountId: "   " }],
  ])("blocks %s, so a verdict names the identity it was produced for", (_l, patch) => {
    expect(commercialWhy(patch as Record<string, unknown>)).toContain("exact business and account identity");
  });

  it.each([null, undefined, "true", 1, {}, []])(
    "blocks a non-literal-boolean eligible: %s", (eligible) => {
      expect(() => run({ commercial: { ...bestCase().commercial, eligible } as DryRunInput["commercial"] })).not.toThrow();
      expect(run({ commercial: { ...bestCase().commercial, eligible } as DryRunInput["commercial"] }).blockers)
        .toContain("commercial_verdict_incoherent");
    });

  it("blocks a non-canonical profile contract identity", () => {
    expect(commercialWhy({ profileContractVersion: "adsecute.account-decision-profile.v2" })).toBeTruthy();
  });
});

describe("D085 C6 — the ISO-4217 registry identity is required, always", () => {
  const blockersFor = (currencyRegistryVersion: unknown) =>
    buildBudgetProposalDryRun(bestCase({ capability: SYNTHETIC_CAP, currencyRegistryVersion } as Partial<DryRunInput>)).blockers;

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an arbitrary version", "iso-4217.v99"],
    ["a number", 4217],
    ["an object", {}],
    ["an empty string", ""],
  ])("blocks %s", (_l, version) => {
    // r6 treated `null` as "unspecified but fine", so a preview could be
    // assembled with no registry identity at all.
    expect(blockersFor(version)).toContain("currency_registry_not_canonical");
  });

  it("accepts ONLY the canonical registry identity", () => {
    expect(blockersFor(ISO_4217_REGISTRY_VERSION)).not.toContain("currency_registry_not_canonical");
  });
});

describe("D085 C6 — normalization is total for every nested safety child", () => {
  const flags = ["killSwitch", "admission", "cap", "cooldown", "conflict"] as const;
  const malformed = [
    ["null", null], ["undefined", undefined], ["a string", "clear"], ["a number", 1],
    ["an array", []], ["an empty object", {}], ["a state-less object", { source: "x", asOf: "2026-09-01" }],
    ["a non-canonical state", { state: "fine", source: "x", asOf: "2026-09-01", why: "w", verified: true }],
  ] as Array<[string, unknown]>;

  it.each(flags.flatMap((f) => malformed.map(([label, value]) => [f, label, value] as const)))(
    "blocks safety.%s when it is %s, and never throws", (flag, _label, value) => {
      // r6 threw `Cannot read properties of null (reading 'state')` on ALL
      // five of these — a crash where a blocked verdict was required.
      const call = () => buildBudgetProposalDryRun(bestCase({
        capability: SYNTHETIC_CAP,
        safety: { ...bestCase().safety, [flag]: value } as DryRunInput["safety"],
      }));
      expect(call).not.toThrow();
      const r = call();
      expect(r.status).toBe("blocked");
      expect(r.wouldWriteRequest).toBeNull();
      expect(r.blockers.length).toBeGreaterThan(0);
    });

  it("blocks ALL FIVE children malformed at once, without throwing", () => {
    const call = () => buildBudgetProposalDryRun(bestCase({
      capability: SYNTHETIC_CAP,
      safety: Object.fromEntries(flags.map((f) => [f, null])) as unknown as DryRunInput["safety"],
    }));
    expect(call).not.toThrow();
    expect(call().status).toBe("blocked");
  });

  it.each([
    ["a null safety map", null], ["an undefined safety map", undefined],
    ["a string safety map", "clear"], ["an array safety map", []],
  ])("blocks %s, without throwing", (_l, safety) => {
    const call = () => buildBudgetProposalDryRun(bestCase({ capability: SYNTHETIC_CAP, safety } as Partial<DryRunInput>));
    expect(call).not.toThrow();
    expect(call().status).toBe("blocked");
  });
});

describe("D085 C6 — the receipt publishes the capability it was hashed under", () => {
  const built = () => assembledPreview();

  it("publishes the COMPLETE sanitized snapshot, not a two-field excerpt", () => {
    const snap = built().receipt.capabilitySnapshot!;
    expect(Object.keys(snap).sort()).toEqual([
      "budgetEndpointExists", "dispatchVerbExists", "source", "supportedFields", "why",
    ]);
    expect(snap.budgetEndpointExists).toBe(true);
    expect(snap.dispatchVerbExists).toBe(true);
    expect(snap.source).toBe(SYNTHETIC_CAP.source);
    expect(snap.why).toBe(SYNTHETIC_CAP.why);
  });

  it("sorts and de-duplicates supportedFields, so the snapshot has one canonical form", () => {
    const messy = sanitizeCapabilitySnapshot({
      ...SYNTHETIC_CAP,
      supportedFields: ["lifetime_budget", "daily_budget", "daily_budget"],
    });
    expect(messy.supportedFields).toEqual(["daily_budget", "lifetime_budget"]);
  });

  it("verifies a genuine receipt from ONLY the request and receipt", () => {
    const { request, receipt } = built();
    const v = verifyReceiptPreviewIntegrity({ request, receipt });
    expect(v.problems).toEqual([]);
    expect(v.verified).toBe(true);
  });

  it("REFUSES a self-rehashed receipt whose snapshot and fingerprint disagree", () => {
    /*
      THE r6 ESCAPE, verbatim.

      An attacker who can edit a receipt can also re-hash it. r6 published no
      booleans and no `why`, and never compared the snapshot against the
      fingerprint, so a receipt claiming a permissive capability re-hashed
      cleanly and self-verified.
    */
    const { request, receipt } = built();
    const forged: ReceiptPreview = {
      ...receipt,
      capabilitySnapshot: {
        ...receipt.capabilitySnapshot!,
        budgetEndpointExists: false,
        source: "FORGED — a capability that never existed",
      },
    };
    /*
      Sealed with the TEST-ONLY raw hash.

      Correction 13 gave `recomputePreviewHash` an eligibility gate, after
      which this line produced a SENTINEL and the "it re-hashes cleanly"
      assertion below degraded into sentinel === sentinel — a claim about
      nothing. Correction 14 restores the r6 escape as written: the forgery
      really is self-consistent, and is refused anyway.
    */
    const rehashed: ReceiptPreview = {
      ...forged,
      receiptHash: rawCanonicalPreviewHashForTests({ request, receipt: forged }, PREVIEW_CONTRACT_VERSION),
    };
    // It re-hashes cleanly under the raw algorithm...
    expect(rawCanonicalPreviewHashForTests({ request, receipt: rehashed }, PREVIEW_CONTRACT_VERSION)).toBe(rehashed.receiptHash);
    // ...our own hash entrypoint refuses to bless it...
    expect(recomputePreviewHash({ request, receipt: rehashed })).not.toBe(rehashed.receiptHash);
    // ...and the verifier still refuses it. Correction 7 refuses it EARLIER
    // and for a better reason: a receipt whose snapshot says no budget
    // endpoint exists cannot be a would-write receipt at all, whatever its
    // fingerprint says.
    const v = verifyReceiptPreviewIntegrity({ request, receipt: rehashed });
    expect(v.verified).toBe(false);
    expect(v.problems.join("; ")).toContain("no budget endpoint exists");
  });

  it.each([
    ["a missing snapshot", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: undefined })],
    ["a null snapshot", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: null as never })],
    ["a string snapshot", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: "cap" as never })],
    ["an array snapshot", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: [] as never })],
    ["a non-boolean endpoint flag", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: { ...r.capabilitySnapshot!, budgetEndpointExists: "true" as never } })],
    ["an unsorted field list", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: { ...r.capabilitySnapshot!, supportedFields: ["lifetime_budget", "daily_budget"] as never } })],
    ["a field outside the allowlist", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: { ...r.capabilitySnapshot!, supportedFields: ["bid_amount"] as never } })],
    ["a blank source", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: { ...r.capabilitySnapshot!, source: "  " } })],
    ["a missing why", (r: ReceiptPreview) => ({ ...r, capabilitySnapshot: { ...r.capabilitySnapshot!, why: undefined as never } })],
    ["no receipt hash", (r: ReceiptPreview) => ({ ...r, receiptHash: undefined })],
    ["no capability fingerprint", (r: ReceiptPreview) => ({ ...r, capabilityFingerprint: undefined })],
    ["a tampered before amount", (r: ReceiptPreview) => ({ ...r, before: { ...r.before, minorUnits: 1 } })],
  ])("refuses %s", (_l, tamper) => {
    const { request, receipt } = built();
    const v = verifyReceiptPreviewIntegrity({ request, receipt: tamper(receipt) });
    expect(v.verified).toBe(false);
    expect(v.problems.length).toBeGreaterThan(0);
  });

  it("is MIGRATION-SAFE: an unversioned receipt is unverifiable, not valid", () => {
    const { request, receipt } = built();
    const legacy = { ...receipt, previewContractVersion: undefined } as unknown as ReceiptPreview;
    const v = verifyReceiptPreviewIntegrity({ request, receipt: legacy });
    expect(v.verified).toBe(false);
    expect(v.problems.join("; ")).toContain("cannot be verified rather than being valid");
  });

  it("refuses a request whose field the published snapshot does not support", () => {
    const { request, receipt } = built();
    const v = verifyReceiptPreviewIntegrity({
      request: { ...request, field: "lifetime_budget" },
      receipt,
    });
    expect(v.verified).toBe(false);
    // Correction 8 rejects it EARLIER, in the semantic layer: the receipt says
    // this proposal is for `daily_budget`, so a request naming
    // `lifetime_budget` is not a request for this receipt at all. That is a
    // stronger and more honest reason than capability membership.
    expect(v.problems.join("; ")).toContain("receipt.before.field");
  });
});

describe("D085 C6 — capability refusal is never reported as an intent failure", () => {
  it("names the CAPABILITY when the field is unsupported", () => {
    // The fixture writes `daily_budget`; this capability supports only the
    // other field. That is a provider-path refusal, not a broken intent.
    const lifetimeOnly: ProviderCapabilityContract = {
      ...SYNTHETIC_CAP, supportedFields: ["lifetime_budget"],
    };
    const r = buildBudgetProposalDryRun(bestCase({ capability: lifetimeOnly }));
    expect(r.status).toBe("blocked");
    expect(r.blockers).toContain("no_provider_write_path_exists");
    expect(r.blockers).not.toContain("intent_not_validated");
    expect(r.blockers).not.toContain("capability_contract_invalid");
    const why = r.blockerDetail.find((d) => d.code === "no_provider_write_path_exists")!.why;
    expect(why).toContain("does not include the requested field daily_budget");
  });

  it("still separates a MALFORMED capability from an unsupported field", () => {
    const malformed = { ...SYNTHETIC_CAP, budgetEndpointExists: "yes" } as unknown as ProviderCapabilityContract;
    const r = buildBudgetProposalDryRun(bestCase({ capability: malformed }));
    expect(r.blockers).toContain("capability_contract_invalid");
  });

  it("keeps the PRODUCTION capability well-formed for the real field", () => {
    // Production supports NO fields, so the requested field is unsupported —
    // a refusal, while the contract itself stays well-formed.
    expect(validateCapability(PROVIDER_CAPABILITY_TODAY).valid).toBe(true);
    expect(validateCapability(PROVIDER_CAPABILITY_TODAY, "daily_budget").valid).toBe(false);
    expect(capabilityPermitsWrite(PROVIDER_CAPABILITY_TODAY)).toBe(false);
  });
});
