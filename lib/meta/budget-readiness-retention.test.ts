/**
 * D086 — the three retention contracts.
 *
 * Each blocker was first reproduced against the LIVE schema and data, SELECT-only,
 * before any of this existed:
 *
 *   A  a search of every column in `public` for
 *      `exponent|minor_unit|currency_scale|currency_decimal` returned ZERO rows;
 *   B  the only profile-shaped table (`business_decision_calibration_profiles`) is a
 *      multiplier config table holding 0 rows — nothing retains the resolver result;
 *   C  all 2,350 retained role rows for the six businesses carry the retired
 *      `campaign-context-resolver.v1-shadow-2026-07-06` AND a NULL provider account.
 *
 * These tests hold the rules that decide whether a fact may be retained at all.
 */
import { describe, expect, it } from "vitest";

import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import type { AccountDecisionProfile } from "@/lib/creative-decision-engine/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ISO_4217_REGISTRY_SOURCE, ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";
import type { CommercialAnchorBlockerCode } from "@/lib/creative-decision-engine/commercial-anchor";

import { ACCOUNT_DECISION_PROFILE_CONTRACT } from "@/lib/creative-decision-engine/account-decision-profile";
import { CAMPAIGN_CONTEXT_MAX_AGE_DAYS } from "@/lib/creative-decision-engine/campaign-context/source";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { META_CAMPAIGN_KINDS } from "@/lib/meta/campaign-label-types";
import {
  D086_CANONICAL_BLOCKER_CODES,
  D086_RETENTION_CONTRACT,
  classifyRetainedBudgetFact,
  classifyRetainedProfile,
  D086_SUPERSEDED_RETENTION_CONTRACTS,
  projectCanonicalProfileOutput,
  qualifyRoleAuthorityRow,
  validateCanonicalBudgetFact,
  type BudgetFactCaptureScope,
  type ProfileCaptureScope,
  type RoleAuthorityGate,
} from "@/lib/meta/budget-readiness-retention";

const BUSINESS = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const ACCOUNT = "act_1087566732415606";
const CUTOFF = "2026-08-22T00:00:00Z";

const budgetScope: BudgetFactCaptureScope = {
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  cutoffIso: CUTOFF,
};

const budgetFact = (over: Record<string, unknown> = {}) => ({
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  entityGrain: "campaign",
  entityId: "23851234567890123",
  parentCampaignId: null,
  budgetOwnerMode: "campaign_budget_optimization",
  budgetField: "daily_budget",
  rawMinorUnits: 250000,
  sourceCurrency: "TRY",
  scheduleState: "active",
  effectiveFrom: "2026-08-01",
  effectiveTo: null,
  providerApiVersion: "v22.0",
  sourceKind: "meta_entity_observation",
  sourceSnapshotId: null,
  sourceRunId: "run_2026-08-21T03:00:00Z",
  capturedAt: "2026-08-21T03:00:00Z",
  effectiveAt: "2026-08-21T03:00:00Z",
  recordedAt: "2026-08-21T03:00:05Z",
  ...over,
});

// ---------------------------------------------------------------------------
// A — currency_exponent_not_captured
// ---------------------------------------------------------------------------

describe("D086 A — a budget value is retained only with its unit", () => {
  it("POSITIVE CONTROL: a complete observation is retained with a registry exponent", () => {
    const out = validateCanonicalBudgetFact(budgetFact(), budgetScope);
    expect(out.blockers).toEqual([]);
    expect(out.retained).toBe(true);
    if (!out.retained) return;
    expect(out.value.contract).toBe(D086_RETENTION_CONTRACT);
    expect(out.value.sourceCurrency).toBe("TRY");
    expect(out.value.currencyExponent).toBe(2);
    expect(out.value.currencyRegistryVersion).toMatch(/^iso4217\.minor-units\./);
    expect(out.value.rawMinorUnits).toBe(250000);
  });

  it("the exponent comes from the REGISTRY, never from the caller", () => {
    /*
      A caller-supplied exponent is the failure mode this blocker is about: it makes
      the unit an opinion. The key is not in the admitted schema at all, so supplying
      one is an exact-schema violation rather than a silently ignored field.
    */
    const out = validateCanonicalBudgetFact(
      budgetFact({ currencyExponent: 0 }),
      budgetScope,
    );
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("budget_fact_schema_exact_mismatch");
  });

  it.each([
    ["a currency the registry does not carry", { sourceCurrency: "ZZZ" }, /currency_unresolvable/],
    ["a blank currency", { sourceCurrency: "" }, /currency_unresolvable/],
    ["a non-string currency", { sourceCurrency: 949 }, /currency_unresolvable/],
    ["a lifetime budget", { budgetField: "lifetime_budget" }, /lifetime_budget_unsupported/],
    ["an unsupported field", { budgetField: "bid_amount" }, /field_unsupported/],
    ["a major-unit float", { rawMinorUnits: 2500.75 }, /not_minor_units/],
    ["a negative amount", { rawMinorUnits: -1 }, /not_positive/],
    ["a zero amount", { rawMinorUnits: 0 }, /not_positive/],
    // Refused EARLIER than the predicate: the hardened observer rejects a
    // non-JSON-representable number before any budget rule runs. Recorded as the
    // refusal that actually happens rather than the one I first expected.
    ["a non-finite amount", { rawMinorUnits: Number.POSITIVE_INFINITY }, /unobservable/],
    ["an unsafe integer", { rawMinorUnits: 2 ** 53 }, /not_exact/],
    ["a foreign business", { businessId: "other-business" }, /cross_business/],
    ["a foreign account", { providerAccountId: "act_999" }, /cross_account/],
    ["an ad set with no parent", { entityGrain: "adset", parentCampaignId: null }, /parent_campaign_missing/],
    ["a campaign carrying a parent", { parentCampaignId: "23859999" }, /cross_grain_parent/],
    ["an unknown grain", { entityGrain: "ad" }, /grain_unsupported/],
    ["an unknown owner mode", { budgetOwnerMode: "guessed" }, /owner_mode_unknown/],
    ["an unknown schedule state", { scheduleState: "maybe" }, /schedule_state_unknown/],
    ["a missing provider API version", { providerApiVersion: "" }, /provider_api_version_missing/],
    ["a missing run identity", { sourceRunId: "" }, /source_run_missing/],
    ["capture after the cutoff", { capturedAt: "2026-08-23T00:00:00Z" }, /captured_after_cutoff/],
    ["an effective time after the cutoff", { effectiveAt: "2026-09-01T00:00:00Z" }, /effective_after_cutoff/],
    ["a record time after the cutoff", { recordedAt: "2026-09-01T00:00:00Z" }, /recorded_after_cutoff/],
    ["a naive local timestamp", { capturedAt: "2026-08-21 03:00:00" }, /captured_at_malformed/],
    ["a malformed effective date", { effectiveFrom: "01/08/2026" }, /effective_from_malformed/],
  ])("REFUSES %s", (_label, over, expected) => {
    const out = validateCanonicalBudgetFact(budgetFact(over), budgetScope);
    expect(out.retained, `${JSON.stringify(over)} was retained`).toBe(false);
    expect(out.blockers.join(" | ")).toMatch(expected);
  });

  it("an ad set WITH its parent is retained", () => {
    const out = validateCanonicalBudgetFact(
      budgetFact({ entityGrain: "adset", parentCampaignId: "23851234567890123", budgetOwnerMode: "adset_budget" }),
      budgetScope,
    );
    expect(out.blockers).toEqual([]);
    expect(out.retained).toBe(true);
  });

  it("a zero-exponent currency keeps its own exponent, not a default of 2", () => {
    const out = validateCanonicalBudgetFact(budgetFact({ sourceCurrency: "JPY" }), budgetScope);
    expect(out.retained).toBe(true);
    if (out.retained) expect(out.value.currencyExponent).toBe(0);
  });

  /*
    ── ROUND 6 AUDIT ITEM 3: v10 IS HISTORY, AND HISTORY AUTHORIZES NOTHING ──
    `d086.budget-readiness-retention.v10` meant two different things: it was
    minted for the semantic projection, its own source comment claimed the
    artifact had been regenerated with it (it had not), and Round 6 then
    changed what BOTH fingerprint halves digest again without moving it. v11
    closes the collision, and a row still stamped v10 must be readable as
    evidence that an older capture ran — never as a verdict that may be
    retained or acted on.
  */
  it("mints v12 and lists every predecessor among the superseded identities", () => {
    expect(D086_RETENTION_CONTRACT).toBe("d086.budget-readiness-retention.v12");
    /*
      Every predecessor, not just the newest one. A superseded list that
      forgot a version would let a row stamped with it be read as current —
      the list is what makes "readable as history only" enforceable — so the
      whole range is asserted rather than the last entry.
    */
    for (let version = 1; version <= 11; version += 1) {
      expect(D086_SUPERSEDED_RETENTION_CONTRACTS).toContain(
        `d086.budget-readiness-retention.v${version}`,
      );
    }
    // The current mint is never in its own superseded list.
    expect(D086_SUPERSEDED_RETENTION_CONTRACTS).not.toContain(
      D086_RETENTION_CONTRACT,
    );
  });

  it("refuses to retain a v10-stamped profile row, and says why", () => {
    const captured = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    expect(captured.retained).toBe(true);
    if (!captured.retained) return;
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    // The control: the SAME row under the current contract is usable, so the
    // refusal below is attributable to the stamp and to nothing else.
    expect(classifyRetainedProfile(captured.value, expected)).toEqual({
      usable: true,
      reason: null,
    });
    const asV10 = {
      ...captured.value,
      contract: "d086.budget-readiness-retention.v10",
    };
    expect(classifyRetainedProfile(asV10, expected)).toMatchObject({
      usable: false,
      reason: "retained_profile_contract_superseded",
    });
  });

  it("is TOTAL on hostile input", () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const cyclic: Record<string, unknown> = budgetFact();
    cyclic.self = cyclic;
    const throwing = Object.defineProperty(budgetFact(), "sourceCurrency", {
      get() { throw new Error("trap"); }, enumerable: true, configurable: true,
    });
    for (const hostile of [
      null, undefined, 7, "x", [], true, Symbol("s"), () => 1, BigInt(1),
      revoked, cyclic, throwing, budgetFact({ rawMinorUnits: BigInt(5) }),
    ]) {
      expect(() => validateCanonicalBudgetFact(hostile, budgetScope)).not.toThrow();
      const out = validateCanonicalBudgetFact(hostile, budgetScope);
      expect(out.retained, String(typeof hostile)).toBe(false);
      expect(out.blockers.length).toBeGreaterThan(0);
    }
  });

  it("PIT: an observation AT the cutoff instant is refused, not admitted", () => {
    /*
      The contract says "nothing at or after the cutoff". r1 rejected only
      `> cutoff`, so the boundary observation was quietly admitted.
    */
    const at = "2026-08-22T00:00:00Z";
    for (const field of ["capturedAt", "effectiveAt", "recordedAt"] as const) {
      const out = validateCanonicalBudgetFact(budgetFact({ [field]: at }), budgetScope);
      expect(out.retained, field).toBe(false);
      expect(out.blockers.join(" | "), field).toMatch(/after_cutoff/);
    }
    // One millisecond earlier is still admissible, so this is a boundary, not a ban.
    const justBefore = "2026-08-21T23:59:59Z";
    const ok = validateCanonicalBudgetFact(
      budgetFact({ capturedAt: justBefore, effectiveAt: justBefore, recordedAt: justBefore }),
      budgetScope,
    );
    expect(ok.retained).toBe(true);
  });

  it("PIT: a profile capture AT the cutoff instant is refused", () => {
    const at = "2026-08-22T00:00:00Z";
    const out = projectCanonicalProfileOutput(profile(), "cut", {
      ...profileScope, effectiveAt: at, recordedAt: at,
    });
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("profile_recorded_after_cutoff");
  });

  it("a blank business or provider account is refused at projection", () => {
    for (const over of [{ businessId: "" }, { providerAccountId: "" }]) {
      const out = projectCanonicalProfileOutput(profile(over.businessId === "" ? { businessId: "" } : {}), "cut", {
        ...profileScope, ...over,
      });
      expect(out.retained, JSON.stringify(over)).toBe(false);
    }
  });

  it("a malformed scope fingerprint is refused at projection", () => {
    for (const over of [{ inputFingerprint: "nope" }, { sourceFingerprint: "" }]) {
      const out = projectCanonicalProfileOutput(profile(), "cut", { ...profileScope, ...over });
      expect(out.retained, JSON.stringify(over)).toBe(false);
    }
  });

  it("an invalid cutoff refuses rather than admitting everything", () => {
    const out = validateCanonicalBudgetFact(budgetFact(), { ...budgetScope, cutoffIso: "yesterday" });
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("capture_cutoff_invalid");
  });
});

// ---------------------------------------------------------------------------
// B — canonical_profile_output_not_retained
// ---------------------------------------------------------------------------

const profileScope: ProfileCaptureScope = {
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  inputFingerprint: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
  effectiveAt: "2026-08-21T03:00:00Z",
  recordedAt: "2026-08-21T03:00:05Z",
  cutoffIso: CUTOFF,
};

const profile = (over: Record<string, unknown> = {}): AccountDecisionProfile =>
  ({
    businessId: BUSINESS,
    asOfDate: "2026-08-21",
    spendUnit: 1200,
    hardActionEligibility: {
      scale: false,
      cut: false,
      refresh: true,
      reason: null,
      codes: { scale: "target_roas_missing", cut: "break_even_roas_missing" },
      anchor: { source: "account_baseline", confidence: "low", provenance: "account_history_p50" },
    },
    ...over,
  }) as unknown as AccountDecisionProfile;

describe("D086 B — the resolver result is projected, never re-derived", () => {
  it("POSITIVE CONTROL: an ineligible action retains its own canonical code", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    expect(out.blockers).toEqual([]);
    expect(out.retained).toBe(true);
    if (!out.retained) return;
    expect(out.value.eligible).toBe(false);
    expect(out.value.blockerCode).toBe("break_even_roas_missing");
    expect(out.value.anchorSource).toBe("account_baseline");
    expect(out.value.inputFingerprint).toBe(profileScope.inputFingerprint);
  });

  it("an ELIGIBLE action is retained with no blocker code", () => {
    const out = projectCanonicalProfileOutput(profile(), "refresh", profileScope);
    expect(out.retained).toBe(true);
    if (out.retained) {
      expect(out.value.eligible).toBe(true);
      expect(out.value.blockerCode).toBeNull();
    }
  });

  it("REFUSES an eligible action that also carries a withholding code", () => {
    // D079 correction 2: the code and the boolean derive from the same effective
    // code. A contradiction is refused, not resolved in either direction.
    const out = projectCanonicalProfileOutput(
      profile({
        hardActionEligibility: {
          scale: true, cut: false, refresh: false, reason: null,
          codes: { scale: "target_roas_missing" },
        },
      }),
      "scale",
      profileScope,
    );
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("profile_eligible_action_carries_blocker_code");
  });

  it("REFUSES an ineligible action with no code — absence is unknown, never eligible", () => {
    const out = projectCanonicalProfileOutput(
      profile({ hardActionEligibility: { scale: false, cut: false, refresh: false, reason: null } }),
      "cut",
      profileScope,
    );
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("profile_withholding_code_unknown");
  });

  it.each([
    ["a foreign business", { businessId: "other" }, /cross_business/],
    ["no eligibility at all", { hardActionEligibility: undefined }, /eligibility_absent/],
    ["a non-boolean eligibility", {
      hardActionEligibility: { scale: "yes", cut: false, refresh: false, reason: null, codes: { cut: "x" } },
    }, /not_boolean/],
    ["a malformed as-of", { asOfDate: "21-08-2026" }, /as_of_malformed/],
  ])("REFUSES %s", (_l, over, expected) => {
    const out = projectCanonicalProfileOutput(profile(over), "scale", profileScope);
    expect(out.retained).toBe(false);
    expect(out.blockers.join(" | ")).toMatch(expected);
  });

  it("REFUSES a capture whose clocks are after the cutoff", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", {
      ...profileScope, recordedAt: "2026-09-01T00:00:00Z",
    });
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("profile_recorded_after_cutoff");
  });

  it("is TOTAL on hostile input", () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const hostile of [null, undefined, 7, "x", [], true, revoked, BigInt(2)]) {
      expect(() => projectCanonicalProfileOutput(hostile, "cut", profileScope)).not.toThrow();
      expect(projectCanonicalProfileOutput(hostile, "cut", profileScope).retained).toBe(false);
    }
  });

  it("a retained profile is REVIEW-ONLY unless it matches exactly and is fresh", () => {
    const captured = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    expect(captured.retained).toBe(true);
    if (!captured.retained) return;
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    expect(classifyRetainedProfile(captured.value, expected)).toEqual({ usable: true, reason: null });

    expect(classifyRetainedProfile(null, expected).reason).toBe("retained_profile_missing");
    expect(classifyRetainedProfile({ ...captured.value, engineEpoch: "other" }, expected).reason)
      .toBe("retained_profile_epoch_mismatch");
    expect(classifyRetainedProfile({ ...captured.value, engineVersion: "v2" }, expected).reason)
      .toBe("retained_profile_engine_version_mismatch");
    expect(classifyRetainedProfile(captured.value, { ...expected, inputFingerprint: "c".repeat(64) }).reason)
      .toBe("retained_profile_input_mismatch");
    expect(classifyRetainedProfile(captured.value, { ...expected, nowIso: "2026-08-23T00:00:00Z" }).reason)
      .toBe("retained_profile_stale");
    expect(classifyRetainedProfile(captured.value, { ...expected, nowIso: "2026-08-20T00:00:00Z" }).reason)
      .toBe("retained_profile_recorded_in_future");
    expect(classifyRetainedProfile(captured.value, { ...expected, nowIso: "not-a-time" }).reason)
      .toBe("retained_profile_clock_unverifiable");
    /*
      r1 retained BOTH fingerprints and compared only the input one, so a verdict
      whose SOURCE had changed served as if nothing had.
    */
    expect(classifyRetainedProfile(captured.value, { ...expected, sourceFingerprint: "d".repeat(64) }).reason)
      .toBe("retained_profile_source_mismatch");
    expect(classifyRetainedProfile(captured.value, { ...expected, maxAgeMs: 0 }).reason)
      .toBe("retained_profile_max_age_invalid");
    expect(classifyRetainedProfile(captured.value, { ...expected, maxAgeMs: Number.NaN }).reason)
      .toBe("retained_profile_max_age_invalid");
  });

  it("the classifier is TOTAL on hostile retained input", () => {
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const cyclic: Record<string, unknown> = { contract: D086_RETENTION_CONTRACT };
    cyclic.self = cyclic;
    for (const hostile of [null, undefined, 7, "x", [], true, revoked, cyclic, BigInt(1), Symbol("s")]) {
      expect(() => classifyRetainedProfile(hostile, expected)).not.toThrow();
      expect(classifyRetainedProfile(hostile, expected).usable, String(typeof hostile)).toBe(false);
    }
  });

  it("NO external expectation is UNVERIFIABLE, never usable", () => {
    /*
      r2 read `null` as "skip the check" and returned usable, so an arbitrary
      engine version and arbitrary digests served as a verified verdict.
    */
    const captured = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    expect(captured.retained).toBe(true);
    if (!captured.retained) return;
    const base = {
      inputFingerprint: null,
      sourceFingerprint: null,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    expect(classifyRetainedProfile(captured.value, base))
      .toEqual({ usable: false, reason: "profile_identity_agreement_unavailable" });
    const withInput = { ...base, inputFingerprint: profileScope.inputFingerprint };
    expect(classifyRetainedProfile(captured.value, withInput).reason)
      .toBe("profile_identity_agreement_unavailable");
    // Form is still checked, and it is checked FIRST.
    const full = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    expect(classifyRetainedProfile({ ...captured.value, sourceFingerprint: "short" }, full).reason)
      .toBe("retained_profile_source_malformed");
    expect(classifyRetainedProfile({ ...captured.value, inputFingerprint: "" }, full).reason)
      .toBe("retained_profile_input_malformed");
    expect(classifyRetainedProfile({ ...captured.value, engineVersion: "arbitrary-version" }, full).reason)
      .toBe("retained_profile_engine_version_mismatch");
  });
});

// ---------------------------------------------------------------------------
// C — automatic_role_authority_absent
// ---------------------------------------------------------------------------

const roleGate: RoleAuthorityGate = {
  expectedScope: { businessId: BUSINESS, providerAccountId: ACCOUNT },
  compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  approvedResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  cutoffIso: CUTOFF,
};

const roleRow = (over: Record<string, unknown> = {}) => ({
  contract: D086_RETENTION_CONTRACT,
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  campaignId: "23851234567890123",
  asOfDate: "2026-08-21",
  inferredKind: "main",
  kindSource: "system_inferred",
  resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  confidenceClass: "high",
  evidenceHash: "e".repeat(64),
  inputHash: "f".repeat(64),
  effectiveAt: "2026-08-21T03:00:00Z",
  recordedAt: "2026-08-21T03:00:05Z",
  provenance: "engine_v3_campaign_role_authority",
  ...over,
});

describe("D086 C — role authority is exact, account-scoped and name-neutral", () => {
  it("POSITIVE CONTROL: an exact fresh row under an approved gate qualifies", () => {
    const v = qualifyRoleAuthorityRow(roleRow(), roleGate);
    expect(v.blockers).toEqual([]);
    expect(v.qualified).toBe(true);
    expect(v.disposition).toBe("authority");
  });

  it("REPRODUCES the live population: a null account and a shadow version both disqualify", () => {
    /*
      Exactly the retained rows measured in production: all 2,350 carry
      `campaign-context-resolver.v1-shadow-2026-07-06` and a NULL provider account,
      484 of them at high confidence. Neither failure is historically repairable.
    */
    const v = qualifyRoleAuthorityRow(
      roleRow({
        providerAccountId: "",
        resolverVersion: "campaign-context-resolver.v1-shadow-2026-07-06",
      }),
      roleGate,
    );
    expect(v.qualified).toBe(false);
    expect(v.disposition).toBe("review_only");
    expect(v.blockers).toContain("role_provider_account_scope_missing");
    expect(v.blockers).toContain("role_resolver_version_not_compiled");
  });

  it.each([
    ["a manual kind source", { kindSource: "manual" }, "role_kind_source_not_system_inferred"],
    ["an operator override", { kindSource: "operator_override" }, "role_kind_source_not_system_inferred"],
    ["medium confidence", { confidenceClass: "medium" }, "role_confidence_not_high"],
    ["conflict confidence", { confidenceClass: "conflict" }, "role_confidence_not_high"],
    ["a missing account scope", { providerAccountId: "" }, "role_provider_account_scope_missing"],
    ["a retired resolver", { resolverVersion: "campaign-context-resolver.v2-account-scoped-2026-08-29" }, "role_resolver_version_not_compiled"],
    ["a stale as-of", { asOfDate: "2026-08-01" }, "role_as_of_stale"],
    ["an as-of after the cutoff", { asOfDate: "2026-08-30" }, "role_as_of_after_cutoff"],
    ["a missing evidence hash", { evidenceHash: "" }, "role_evidence_hash_missing"],
    ["a record time after the cutoff", { recordedAt: "2026-09-01T00:00:00Z" }, "role_recorded_after_cutoff"],
  ])("%s is REVIEW-ONLY, never hidden", (_l, over, code) => {
    const v = qualifyRoleAuthorityRow(roleRow(over), roleGate);
    expect(v.qualified).toBe(false);
    expect(v.disposition).toBe("review_only");
    expect(v.blockers).toContain(code);
  });

  it("a NON-EMPTY FOREIGN account fails — presence is not scope", () => {
    /*
      r1 checked only that the row's own account was non-empty, which verifies a
      row against itself: a well-formed foreign account passed. The expected
      scope comes from the authorized caller and is compared.
    */
    const v = qualifyRoleAuthorityRow(roleRow({ providerAccountId: "act_SOMEONE_ELSE" }), roleGate);
    expect(v.qualified).toBe(false);
    expect(v.disposition).toBe("review_only");
    expect(v.blockers).toContain("role_provider_account_scope_mismatch");
    // ...and it is NOT reported as merely missing, which would hide the tenancy.
    expect(v.blockers).not.toContain("role_provider_account_scope_missing");
  });

  it("a FOREIGN business fails even with the right account", () => {
    const v = qualifyRoleAuthorityRow(roleRow({ businessId: "another-business" }), roleGate);
    expect(v.qualified).toBe(false);
    expect(v.blockers).toContain("role_business_scope_mismatch");
  });

  it("a FOREIGN campaign fails when the caller named one", () => {
    const v = qualifyRoleAuthorityRow(roleRow(), {
      ...roleGate,
      expectedScope: { businessId: BUSINESS, providerAccountId: ACCOUNT, campaignId: "other-campaign" },
    });
    expect(v.qualified).toBe(false);
    expect(v.blockers).toContain("role_campaign_scope_mismatch");
  });

  it("an UNRESOLVED expected scope can never qualify a row", () => {
    // No expectation is not a free pass; it is a refusal.
    for (const expectedScope of [
      { businessId: "", providerAccountId: ACCOUNT },
      { businessId: BUSINESS, providerAccountId: "" },
    ]) {
      const v = qualifyRoleAuthorityRow(roleRow(), { ...roleGate, expectedScope });
      expect(v.qualified).toBe(false);
      expect(v.blockers).toContain("role_expected_scope_unresolved");
    }
  });

  it("PIT: a row AT the cutoff instant is refused, not admitted", () => {
    const v = qualifyRoleAuthorityRow(
      roleRow({ recordedAt: "2026-08-22T00:00:00Z" }),
      { ...roleGate, cutoffIso: "2026-08-22T00:00:00Z" },
    );
    expect(v.blockers).toContain("role_recorded_after_cutoff");
  });

  it("an UNSET authority gate is not an approval", () => {
    const v = qualifyRoleAuthorityRow(roleRow(), { ...roleGate, approvedResolverVersion: null });
    expect(v.qualified).toBe(false);
    expect(v.blockers).toContain("role_resolver_authority_gate_unset");
  });

  it("a gate approving a DIFFERENT version cannot arm the compiled one", () => {
    const v = qualifyRoleAuthorityRow(roleRow(), {
      ...roleGate, approvedResolverVersion: "campaign-context-resolver.v1-shadow-2026-07-06",
    });
    expect(v.qualified).toBe(false);
    expect(v.blockers).toContain("role_resolver_authority_gate_mismatch");
  });

  it("NAME NEUTRALITY: a campaign name cannot even be supplied", () => {
    /*
      Not "a name is ignored" — a name is not in the admitted key set, so a row
      carrying one is refused by exact schema. There is no code path in which a
      name, a Test/Main/Mixed label, or an override reaches a predicate.
    */
    for (const named of [
      { campaignName: "TEST — do not scale" },
      { campaignName: "MAIN" },
      { label: "Test" },
      { manualLabel: "Main" },
      { override: "test" },
    ]) {
      const v = qualifyRoleAuthorityRow(roleRow(named), roleGate);
      expect(v.qualified, `${JSON.stringify(named)} qualified`).toBe(false);
      expect(v.blockers).toContain("role_row_schema_exact_mismatch");
    }
  });

  it("two rows differing ONLY by inferred kind qualify identically", () => {
    // The verdict follows evidence, not the value of the kind.
    const main = qualifyRoleAuthorityRow(roleRow({ inferredKind: "main" }), roleGate);
    const test = qualifyRoleAuthorityRow(roleRow({ inferredKind: "test" }), roleGate);
    expect(main.qualified).toBe(test.qualified);
    expect(main.blockers).toEqual(test.blockers);
  });

  it("is TOTAL on hostile input", () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const cyclic: Record<string, unknown> = roleRow();
    cyclic.self = cyclic;
    for (const hostile of [null, undefined, 7, "x", [], true, revoked, cyclic, BigInt(3), Symbol("s")]) {
      expect(() => qualifyRoleAuthorityRow(hostile, roleGate)).not.toThrow();
      const v = qualifyRoleAuthorityRow(hostile, roleGate);
      expect(v.qualified).toBe(false);
      expect(v.disposition).toBe("review_only");
    }
  });
});

// ===========================================================================
// Correction 2 — the executable reproductions, made permanent
// ===========================================================================

const retainedScope = { businessId: BUSINESS, providerAccountId: ACCOUNT, cutoffIso: CUTOFF };

/** A retained row that carries EVERYTHING the persisted contract requires. */
const retainedBudget = (over: Record<string, unknown> = {}) => ({
  contract: D086_RETENTION_CONTRACT,
  businessId: BUSINESS,
  providerAccountId: ACCOUNT,
  entityGrain: "campaign",
  entityId: "23851234567890123",
  parentCampaignId: null,
  budgetOwnerMode: "campaign_budget_optimization",
  budgetField: "daily_budget",
  rawMinorUnits: 250000,
  sourceCurrency: "TRY",
  currencyExponent: 2,
  // CANONICAL constants, imported — never a copied or truncated literal.
  currencyRegistry: ISO_4217_REGISTRY_SOURCE,
  currencyRegistryVersion: ISO_4217_REGISTRY_VERSION,
  scheduleState: "active",
  effectiveFrom: "2026-08-01",
  effectiveTo: null,
  providerApiVersion: "v22.0",
  sourceKind: "meta_entity_observation",
  sourceSnapshotId: null,
  sourceRunId: "run_2026-08-21T03:00:00Z",
  capturedAt: "2026-08-21T03:00:00Z",
  effectiveAt: "2026-08-21T03:00:00Z",
  recordedAt: "2026-08-21T03:00:05Z",
  ...over,
});

describe("D086 C2 #3/#6 — a retained fact is judged on STORED provenance", () => {
  it("POSITIVE CONTROL: a complete retained row is usable", () => {
    const v = classifyRetainedBudgetFact(retainedBudget(), retainedScope);
    expect(v.blockers).toEqual([]);
    expect(v.usable).toBe(true);
  });

  it.each([
    ["no stored exponent", { currencyExponent: null }, "retained_budget_exponent_absent"],
    ["no stored registry", { currencyRegistry: null }, "retained_budget_registry_absent"],
    ["no stored registry version", { currencyRegistryVersion: null }, "retained_budget_registry_version_absent"],
    ["no stored currency", { sourceCurrency: null }, "retained_budget_currency_absent"],
    ["a lower-case currency", { sourceCurrency: "try" }, "retained_budget_currency_absent"],
    ["an out-of-range exponent", { currencyExponent: 9 }, "retained_budget_exponent_absent"],
    ["a fractional exponent", { currencyExponent: 2.5 }, "retained_budget_exponent_absent"],
  ])("%s makes the row UNUSABLE", (_l, over, code) => {
    /*
      r2 re-resolved the currency through TODAY'S registry at read time, so a row
      that persisted no unit at all was reported ready. That is the historical
      restatement this slice exists to prevent, and it also hid the gap.
    */
    const v = classifyRetainedBudgetFact(retainedBudget(over), retainedScope);
    expect(v.usable, JSON.stringify(over)).toBe(false);
    expect(v.blockers).toContain(code);
  });

  it("a ZERO amount is not an actionable budget", () => {
    // r2 accepted 0: an unpopulated column coercing to 0 was indistinguishable
    // from a real free budget, and neither can be moved by a percentage.
    for (const raw of [0, -1, 2500.5]) {
      const v = classifyRetainedBudgetFact(retainedBudget({ rawMinorUnits: raw }), retainedScope);
      expect(v.usable, String(raw)).toBe(false);
    }
  });

  it.each([
    ["no persisted contract", { contract: null }, "retained_budget_contract_absent"],
    ["a superseded contract", { contract: "d086.budget-readiness-retention.v1" }, "retained_budget_contract_superseded"],
    ["a foreign contract", { contract: "something.else.v1" }, "retained_budget_contract_unknown"],
    ["a foreign business", { businessId: "other" }, "retained_budget_business_scope_mismatch"],
    ["a foreign account", { providerAccountId: "act_OTHER" }, "retained_budget_account_scope_mismatch"],
    ["an unknown owner mode", { budgetOwnerMode: "unknown" }, "owner_mode_unknown"],
    ["a mixed owner mode", { budgetOwnerMode: "mixed" }, "owner_mode_mixed"],
    ["an owner mode against the grain", { budgetOwnerMode: "adset_budget" }, "owner_mode_disagrees_with_grain"],
    ["an unknown schedule state", { scheduleState: "unknown" }, "schedule_state_unknown"],
    ["a lifetime budget", { budgetField: "lifetime_budget" }, "retained_budget_lifetime_unsupported"],
    ["no provenance run", { sourceRunId: "" }, "retained_budget_source_run_absent"],
    ["an impossible effective date", { effectiveFrom: "2026-02-30" }, "retained_budget_effective_from_malformed"],
    ["a clock AT the cutoff", { recordedAt: CUTOFF }, "retained_budget_recorded_after_cutoff"],
  ])("%s makes the row UNUSABLE", (_l, over, code) => {
    const v = classifyRetainedBudgetFact(retainedBudget(over), retainedScope);
    expect(v.usable, JSON.stringify(over)).toBe(false);
    expect(v.blockers).toContain(code);
  });

  it("is TOTAL on hostile input and on an unresolved scope", () => {
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const hostile of [null, undefined, 7, "x", [], true, revoked, BigInt(1), Symbol("s")]) {
      expect(() => classifyRetainedBudgetFact(hostile, retainedScope)).not.toThrow();
      expect(classifyRetainedBudgetFact(hostile, retainedScope).usable).toBe(false);
    }
    expect(classifyRetainedBudgetFact(retainedBudget(), { ...retainedScope, providerAccountId: "" }).reason)
      .toBe("retained_budget_expected_scope_unresolved");
    expect(classifyRetainedBudgetFact(retainedBudget(), { ...retainedScope, cutoffIso: "nope" }).reason)
      .toBe("retained_budget_cutoff_invalid");
  });

  it("an UNRECOGNISED registry is refused; a RECOGNISED one is verified against", () => {
    /*
      The corrected rule, in order: recognition of the frozen source+version
      first — an unknown pair is refused, never repaired by a current lookup —
      and only then verification of the stored currency/exponent against that
      same version's mapping.
    */
    expect(classifyRetainedBudgetFact(retainedBudget({ sourceCurrency: "ZZZ" }), retainedScope).reason)
      .toBe("retained_budget_currency_unknown");
    const v = classifyRetainedBudgetFact(retainedBudget(), retainedScope);
    expect(v.usable).toBe(true);
    /*
      Structural, not incidental: the retained classifier's own body must not
      mention the registry resolver at all. Sliced from its declaration to the
      next top-level declaration.
    */
    const src = readFileSync(resolve("lib/meta/budget-readiness-retention.ts"), "utf8");
    const from = src.indexOf("export function classifyRetainedBudgetFact");
    expect(from).toBeGreaterThan(0);
    // The function ends at its own closing brace in column 0.
    const rest = src.slice(from);
    const close = rest.indexOf("\n}\n");
    expect(close).toBeGreaterThan(0);
    /*
      A CALL, not a mention. The body's own comment explains that it does not
      resolve the exponent, and a substring scan fires on that sentence — the
      prose-versus-linkage trap corrected twice already in this programme.
    */
    const executable = rest.slice(0, close)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(executable).not.toMatch(/\bresolveMinorUnitExponent\s*\(/);
    // POSITIVE CONTROL: the detector still sees a real call.
    expect(/\bresolveMinorUnitExponent\s*\(/.test("const e = resolveMinorUnitExponent(row.c);")).toBe(true);
    // ...and the CAPTURE path legitimately does call it, which proves the
    // separation is real rather than the symbol being absent everywhere.
    expect(src).toMatch(/\bresolveMinorUnitExponent\s*\(/);
  });
});

describe("D086 C2 #2 — role authority is canonical, not merely well-shaped", () => {
  it.each([
    ["no retained contract", { contract: null }, "role_contract_absent"],
    ["a superseded contract", { contract: "d086.budget-readiness-retention.v1" }, "role_contract_superseded"],
    ["an unknown inferred kind", { inferredKind: "banana" }, "role_inferred_kind_unknown"],
    ["a one-character evidence hash", { evidenceHash: "x" }, "role_evidence_hash_malformed"],
    ["a one-character input hash", { inputHash: "y" }, "role_input_hash_malformed"],
    ["an upper-case hash", { evidenceHash: "E".repeat(64) }, "role_evidence_hash_malformed"],
    ["arbitrary provenance", { provenance: "anything at all" }, "role_provenance_unrecognised"],
  ])("%s is REVIEW-ONLY", (_l, over, code) => {
    /*
      r2 returned {qualified:true, blockers:[]} for a row with no contract,
      kind "banana", and hashes "x"/"y". Shape is not canonical authority.
    */
    const v = qualifyRoleAuthorityRow(roleRow(over), roleGate);
    expect(v.qualified, JSON.stringify(over)).toBe(false);
    expect(v.disposition).toBe("review_only");
    expect(v.blockers).toContain(code);
  });

  it("every canonical kind is accepted, and only those", () => {
    for (const kind of META_CAMPAIGN_KINDS) {
      expect(qualifyRoleAuthorityRow(roleRow({ inferredKind: kind }), roleGate).qualified, kind).toBe(true);
    }
    for (const kind of ["all", "TEST", "Main", "", "banana"]) {
      expect(qualifyRoleAuthorityRow(roleRow({ inferredKind: kind }), roleGate).qualified, kind).toBe(false);
    }
  });

  it("#11 uses the CANONICAL freshness window, not a second one", () => {
    /*
      r1 hard-coded three days while `CAMPAIGN_CONTEXT_MAX_AGE_DAYS` is two — a
      second authority rule quietly diverging from the runtime's.
    */
    expect(CAMPAIGN_CONTEXT_MAX_AGE_DAYS).toBe(2);
    const cutoff = "2026-08-22T12:00:00Z";
    const within = qualifyRoleAuthorityRow(roleRow({ asOfDate: "2026-08-20" }), { ...roleGate, cutoffIso: cutoff });
    expect(within.blockers).not.toContain("role_as_of_stale");
    const beyond = qualifyRoleAuthorityRow(roleRow({ asOfDate: "2026-08-19" }), { ...roleGate, cutoffIso: cutoff });
    expect(beyond.blockers).toContain("role_as_of_stale");
  });

  it("#12 a DATE-ONLY as-of follows day granularity: the cutoff's own day is allowed", () => {
    /*
      Correction 1 over-generalised at-or-after instant equality onto a
      date-only value. The shared PIT policy compares such a value day-to-day,
      so an as-of on the cutoff's own day is admissible; a later day is not.
    */
    const cutoff = "2026-08-22T12:00:00Z";
    const sameDay = qualifyRoleAuthorityRow(roleRow({ asOfDate: "2026-08-22" }), { ...roleGate, cutoffIso: cutoff });
    expect(sameDay.blockers).not.toContain("role_as_of_after_cutoff");
    expect(sameDay.qualified).toBe(true);
    const nextDay = qualifyRoleAuthorityRow(roleRow({ asOfDate: "2026-08-23" }), { ...roleGate, cutoffIso: cutoff });
    expect(nextDay.blockers).toContain("role_as_of_after_cutoff");
    // ...and an impossible calendar day is refused, never rolled into March.
    const impossible = qualifyRoleAuthorityRow(roleRow({ asOfDate: "2026-02-30" }), { ...roleGate, cutoffIso: cutoff });
    expect(impossible.blockers).toContain("role_as_of_malformed");
  });

  it("an INSTANT at the cutoff is still refused — instants keep instant semantics", () => {
    const cutoff = "2026-08-22T12:00:00Z";
    const v = qualifyRoleAuthorityRow(
      roleRow({ asOfDate: "2026-08-22", recordedAt: cutoff }), { ...roleGate, cutoffIso: cutoff },
    );
    expect(v.blockers).toContain("role_recorded_after_cutoff");
  });
});

describe("D086 C2 #9/#14/#15 — profile identity is stamped, not supplied", () => {
  it("the retained verdict carries the CANONICAL contracts, whatever the caller wanted", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    expect(out.retained).toBe(true);
    if (!out.retained) return;
    expect(out.value.profileContract).toBe(ACCOUNT_DECISION_PROFILE_CONTRACT);
    expect(out.value.engineEpoch).toBe(ENGINE_VERSION);
    expect(out.value.engineVersion).toBe(ENGINE_VERSION);
    expect(out.value.contract).toBe(D086_RETENTION_CONTRACT);
  });

  it("an ARBITRARY engine version on a retained row is refused", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    if (!out.retained) throw new Error("fixture");
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    expect(classifyRetainedProfile({ ...out.value, engineVersion: "arbitrary-version" }, expected).reason)
      .toBe("retained_profile_engine_version_mismatch");
    expect(classifyRetainedProfile({ ...out.value, profileContract: "other" }, expected).reason)
      .toBe("retained_profile_profile_contract_mismatch");
  });

  it("#14 the eligible boolean is read LITERALLY", () => {
    /*
      r2 coerced with `=== true`, so a malformed value became `false` and, paired
      with a non-empty code, looked like a valid withholding.
    */
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    if (!out.retained) throw new Error("fixture");
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    for (const bogus of ["false", 0, 1, null, "t", {}]) {
      expect(
        classifyRetainedProfile({ ...out.value, eligible: bogus, blockerCode: "break_even_roas_missing" }, expected).reason,
        JSON.stringify(bogus),
      ).toBe("retained_profile_eligibility_not_boolean");
    }
  });

  it("#14 an UNKNOWN action never qualifies", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    if (!out.retained) throw new Error("fixture");
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    for (const action of ["pause", "", "SCALE", null]) {
      expect(classifyRetainedProfile({ ...out.value, action }, expected).reason, String(action))
        .toBe("retained_profile_action_unknown");
    }
  });

  it("#15 a FUTURE or IMPOSSIBLE as-of / effective clock is refused", () => {
    const out = projectCanonicalProfileOutput(profile(), "cut", profileScope);
    if (!out.retained) throw new Error("fixture");
    const expected = {
      inputFingerprint: profileScope.inputFingerprint,
      sourceFingerprint: profileScope.sourceFingerprint,
      nowIso: "2026-08-21T09:00:00Z",
      maxAgeMs: 12 * 3_600_000,
    };
    expect(classifyRetainedProfile({ ...out.value, asOfDate: "2026-08-22" }, expected).reason)
      .toBe("retained_profile_as_of_in_future");
    expect(classifyRetainedProfile({ ...out.value, asOfDate: "2026-02-30" }, expected).reason)
      .toBe("retained_profile_as_of_malformed");
    expect(classifyRetainedProfile({ ...out.value, effectiveAt: "2026-09-01T00:00:00Z" }, expected).reason)
      .toBe("retained_profile_effective_in_future");
    // Same-day as-of is fine: date-only values compare day-to-day.
    expect(classifyRetainedProfile({ ...out.value, asOfDate: "2026-08-21" }, expected).usable).toBe(true);
  });
});

// ===========================================================================
// Correction 4 — the codes C3 introduced, made permanent behaviour tests
// ===========================================================================

describe("D086 C4 #11 — every C3/C4 code has a durable behavioural test", () => {
  it.each([
    ["retained_budget_registry_unrecognised", { currencyRegistry: "made-up", currencyRegistryVersion: "v999" }],
    ["retained_budget_registry_unrecognised", { currencyRegistry: "ISO 4217 published minor units, transcribed per currency." }],
    ["retained_budget_registry_unrecognised", { currencyRegistryVersion: "iso4217.minor-units.1999-01-01" }],
    ["retained_budget_exponent_disagrees_with_registry", { sourceCurrency: "USD", currencyExponent: 4 }],
    ["retained_budget_currency_unknown", { sourceCurrency: "ZZZ" }],
    ["retained_budget_provider_api_version_malformed", { providerApiVersion: "banana" }],
    ["retained_budget_source_kind_unrecognised", { sourceKind: "anything" }],
    ["retained_budget_source_run_malformed", { sourceRunId: "x" }],
    ["retained_budget_source_snapshot_malformed", { sourceSnapshotId: "not-a-uuid" }],
    ["retained_budget_amount_not_positive", { rawMinorUnits: 0 }],
  ])("RETAINED read emits %s", (code, over) => {
    const v = classifyRetainedBudgetFact(retainedBudget(over), retainedScope);
    expect(v.usable, JSON.stringify(over)).toBe(false);
    expect(v.blockers).toContain(code);
  });

  it.each([
    ["budget_fact_provider_api_version_malformed", { providerApiVersion: "banana" }],
    ["budget_fact_source_kind_unrecognised", { sourceKind: "anything" }],
    ["budget_fact_source_run_malformed", { sourceRunId: "x" }],
    ["budget_fact_source_snapshot_malformed", { sourceSnapshotId: "not-a-uuid" }],
    ["budget_fact_raw_value_not_positive", { rawMinorUnits: 0 }],
  ])("CAPTURE emits %s — the same contract, both boundaries", (code, over) => {
    /*
      r4's capture validator checked only presence, so it stamped a canonical
      fact carrying `providerApiVersion: "banana"`, `sourceKind: "anything"` and
      `sourceRunId: "x"` — rows guaranteed unusable the moment anything read them.
    */
    const out = validateCanonicalBudgetFact(budgetFact(over), budgetScope);
    expect(out.retained, JSON.stringify(over)).toBe(false);
    expect(out.blockers).toContain(code);
  });

  it("POSITIVE CONTROL: the canonical provenance passes at BOTH boundaries", () => {
    const captured = validateCanonicalBudgetFact(budgetFact(), budgetScope);
    expect(captured.blockers).toEqual([]);
    expect(captured.retained).toBe(true);
    expect(classifyRetainedBudgetFact(retainedBudget(), retainedScope).usable).toBe(true);
  });

  it("a valid UUID snapshot is accepted at both boundaries; null stays optional", () => {
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(validateCanonicalBudgetFact(budgetFact({ sourceSnapshotId: uuid }), budgetScope).retained).toBe(true);
    expect(classifyRetainedBudgetFact(retainedBudget({ sourceSnapshotId: uuid }), retainedScope).usable).toBe(true);
    expect(validateCanonicalBudgetFact(budgetFact({ sourceSnapshotId: null }), budgetScope).retained).toBe(true);
  });

  it("profile_blocker_code_unrecognised: an arbitrary code is not a verdict", () => {
    const out = projectCanonicalProfileOutput(
      profile({
        hardActionEligibility: {
          scale: false, cut: false, refresh: false, reason: null,
          codes: { cut: "because I said so", scale: "target_roas_missing", refresh: "target_roas_missing" },
        },
      }),
      "cut",
      profileScope,
    );
    expect(out.retained).toBe(false);
    expect(out.blockers).toContain("profile_blocker_code_unrecognised");
  });

  it("#12 the blocker vocabulary is the canonical union, not a divergent list", () => {
    /*
      Typed as `CommercialAnchorBlockerCode[]`, so a member the union does not
      have is a compile error rather than a silent second vocabulary.
    */
    const canonical: readonly CommercialAnchorBlockerCode[] = D086_CANONICAL_BLOCKER_CODES;
    expect(canonical.length).toBeGreaterThan(0);
    for (const code of canonical) {
      const out = projectCanonicalProfileOutput(
        profile({
          hardActionEligibility: {
            scale: false, cut: false, refresh: false, reason: null,
            codes: { cut: code, scale: code, refresh: code },
          },
        }),
        "cut", profileScope,
      );
      expect(out.retained, code).toBe(true);
    }
  });

  it("#12 version-bound verification: recognition first, THEN the mapping", () => {
    /*
      The corrected rule, tested by behaviour rather than by grepping for a call.
      An unrecognised registry fails BEFORE any mapping question is asked, so an
      unknown provenance can never be repaired by a lookup; a recognised one is
      then verified against its own version's mapping.
    */
    const unrecognisedButPlausible = classifyRetainedBudgetFact(
      retainedBudget({ currencyRegistryVersion: "iso4217.minor-units.2099-01-01", sourceCurrency: "USD", currencyExponent: 2 }),
      retainedScope,
    );
    expect(unrecognisedButPlausible.blockers).toContain("retained_budget_registry_unrecognised");
    // ...and it does NOT fall through to a mapping verdict of any kind.
    expect(unrecognisedButPlausible.blockers).not.toContain("retained_budget_exponent_disagrees_with_registry");
    // A recognised pair IS verified against that version's mapping.
    expect(classifyRetainedBudgetFact(retainedBudget({ sourceCurrency: "JPY", currencyExponent: 2 }), retainedScope).blockers)
      .toContain("retained_budget_exponent_disagrees_with_registry");
    expect(classifyRetainedBudgetFact(retainedBudget({ sourceCurrency: "JPY", currencyExponent: 0 }), retainedScope).usable)
      .toBe(true);
  });
});
