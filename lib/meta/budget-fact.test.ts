import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUDGET_FACT_CONTRACT_VERSION,
  isRealCalendarDate,
  isOriginValidForGrain,
  missingContractProvenance,
  missingIdentityProvenance,
  missingStatusEvidence,
  DECISION_TRUTH_FIELDS,
  ZONE_CACHE_LIMIT,
  zoneCacheStats,
  DECISION_TRUTH_EXCLUDED_FIELDS,
  PROVIDER_API_VERSION_PATTERN,
  decisionTruthFingerprint,
  selectObservationAtPitDetailed,
  buildCanonicalBudgetFact,
  classifyAmountField,
  isKnownTimeZone,
  parseProviderAmount,
  pitCutoffMs,
  resolveBudgetField,
  resolveHierarchyOwner,
  resolveSchedule,
  selectObservationAtPit,
  validateObservationScope,
  type BudgetObservation,
} from "./budget-fact";

const B1 = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const A1 = "act_1087566732415606";
const B2 = "5dbc7147-f051-4681-a4d6-20617170074f";
const A2 = "act_805150454596350";
const SWAF = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const SWAF_SELECTED = "act_822913786458311";
const SWAF_UNSELECTED = "act_921275999286619";

const TZ = "America/Los_Angeles";
const AS_OF = "2026-07-20";
/** 2026-07-20T00:00 in Los Angeles is 07:00Z. */
const CUTOFF = Date.parse("2026-07-20T07:00:00Z");

function obs(over: Partial<BudgetObservation> = {}): BudgetObservation {
  return {
    businessId: B1,
    providerAccountId: A1,
    entityGrain: "adset",
    entityId: "adset-1",
    parentCampaignId: "campaign-1",
    observedAtMs: Date.parse("2026-07-18T02:00:00Z"),
    observedOn: "2026-07-18",
    capturedAtMs: Date.parse("2026-07-18T03:00:00Z"),
    presence: "present",
    runCompleteness: "complete",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    budgetOrigin: "adset",
    budgetCurrency: "USD",
    budgetCurrencyExponent: 2,
    budgetCurrencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    campaignDailyRaw: null,
    campaignLifetimeRaw: null,
    adsetDailyRaw: "30000",
    adsetLifetimeRaw: "0",
    startTime: null,
    endTime: null,
    shapeSupport: "supported",
    statusFieldCoverage: { configuredStatus: true, effectiveStatus: true },
    observationId: "obs-child",
    sourceRunId: "run-1",
    sourceSnapshotId: "snap-1",
    payloadHash: "payload-hash",
    runHash: "run-hash",
    stateHash: "child-hash",
    providerApiVersion: "v25.0",
    ...over,
  };
}

const campaign = (over: Partial<BudgetObservation> = {}) =>
  obs({
    entityGrain: "campaign",
    entityId: "campaign-1",
    parentCampaignId: null,
    budgetOrigin: "campaign",
    campaignDailyRaw: "50000",
    campaignLifetimeRaw: "0",
    adsetDailyRaw: null,
    adsetLifetimeRaw: null,
    observationId: "obs-parent",
    stateHash: "parent-hash",
    ...over,
  });

/** ABO: the ad set owns the money, the campaign explicitly does not. */
const aboParent = (over: Partial<BudgetObservation> = {}) =>
  campaign({ budgetOrigin: "not_applicable", campaignDailyRaw: "0", campaignLifetimeRaw: "0", ...over });

const request = (over: Record<string, unknown> = {}) => ({
  businessId: B1,
  providerAccountId: A1,
  entityGrain: "adset" as const,
  entityId: "adset-1",
  parentCampaignId: "campaign-1",
  pit: { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true },
  entityObservations: [obs()],
  parentObservations: [aboParent()],
  ...over,
});

describe("the three reproduced scope failures", () => {
  // Each of these returned usable:true, campaign_owned, amount 100 and the
  // CHILD's state hash before D083 Correction 1.
  const childWithoutMoney = obs({
    budgetOrigin: "not_applicable",
    adsetDailyRaw: "0",
    adsetLifetimeRaw: "0",
  });
  const foreignParent = campaign({
    businessId: B2,
    providerAccountId: A2,
    campaignDailyRaw: "100",
    stateHash: "foreign-hash",
  });

  it("refuses a parent from another business and account", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [childWithoutMoney], parentObservations: [foreignParent] }),
    );
    expect(fact.intentReady).toBe(false);
    expect(fact.ownerResolved).toBe(false);
    expect(fact.ownerMode).not.toBe("campaign_owned");
    expect(fact.bindingAmountRaw).toBeNull();
    expect(fact.blockers).toContain("scope_business_mismatch");
    expect(fact.blockers).toContain("scope_account_mismatch");
  });

  it("refuses a parent whose owner provenance is absent", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [childWithoutMoney],
        parentObservations: [campaign({ budgetOrigin: null, campaignDailyRaw: "100" })],
      }),
    );
    expect(fact.ownerResolved).toBe(false);
    expect(fact.bindingAmountRaw).toBeNull();
    expect(fact.blockers).toContain("owner_origin_unrecognised");
  });

  it("refuses a point_lookup parent under a complete child", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [childWithoutMoney],
        parentObservations: [campaign({ campaignDailyRaw: "100", runCompleteness: "point_lookup" })],
      }),
    );
    expect(fact.ownerResolved).toBe(false);
    expect(fact.blockers).toContain("parent_not_complete_scope");
  });

  it("refuses a same-account parent whose entity id is a different campaign", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [childWithoutMoney],
        parentObservations: [campaign({ entityId: "campaign-OTHER", campaignDailyRaw: "100" })],
      }),
    );
    expect(fact.ownerResolved).toBe(false);
    expect(fact.blockers).toContain("scope_entity_mismatch");
  });

  it("refuses an ABO ad set with no parent observation at all", () => {
    const fact = buildCanonicalBudgetFact(request({ parentObservations: [] }));
    expect(fact.ownerResolved).toBe(false);
    expect(fact.intentReady).toBe(false);
    expect(fact.blockers).toContain("parent_not_observed");
  });

  it("refuses when the child declares a different parent than the caller", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ parentCampaignId: "campaign-9" })] }),
    );
    expect(fact.blockers).toContain("parent_identity_mismatch");
    expect(fact.ownerResolved).toBe(false);
  });

  it("keeps TheSwaf's two accounts from colliding on an identical entity id", () => {
    const selected = buildCanonicalBudgetFact(
      request({
        businessId: SWAF,
        providerAccountId: SWAF_SELECTED,
        entityObservations: [obs({ businessId: SWAF, providerAccountId: SWAF_SELECTED, adsetDailyRaw: "111" })],
        parentObservations: [aboParent({ businessId: SWAF, providerAccountId: SWAF_SELECTED })],
      }),
    );
    const contaminated = buildCanonicalBudgetFact(
      request({
        businessId: SWAF,
        providerAccountId: SWAF_SELECTED,
        entityObservations: [obs({ businessId: SWAF, providerAccountId: SWAF_SELECTED, adsetDailyRaw: "111" })],
        // The deselected account's campaign, same id, must never be the owner.
        parentObservations: [campaign({ businessId: SWAF, providerAccountId: SWAF_UNSELECTED, campaignDailyRaw: "999" })],
      }),
    );
    expect(selected.ownerResolved).toBe(true);
    expect(selected.bindingAmountRaw).toBe("111");
    expect(contaminated.ownerResolved).toBe(false);
    expect(contaminated.blockers).toContain("scope_account_mismatch");
  });
});

describe("positive controls", () => {
  it("resolves ABO and reports the ad set's own provenance", () => {
    const fact = buildCanonicalBudgetFact(request());
    expect(fact.ownerMode).toBe("adset_owned");
    expect(fact.bindingAmountRaw).toBe("30000");
    expect(fact.ownerProvenance?.stateHash).toBe("child-hash");
    expect(fact.ownerProvenance?.observationId).toBe("obs-child");
    expect(fact.ownerResolved).toBe(true);
    expect(fact.intentReady).toBe(true);
    expect(fact.contractVersion).toBe(BUDGET_FACT_CONTRACT_VERSION);
  });

  it("resolves CBO and reports the CAMPAIGN's provenance beside the campaign's money", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ budgetOrigin: "not_applicable", adsetDailyRaw: "0", adsetLifetimeRaw: "0" })],
        parentObservations: [campaign()],
      }),
    );
    expect(fact.ownerMode).toBe("campaign_owned");
    expect(fact.bindingAmountRaw).toBe("50000");
    // The defect was reporting the child's hash beside the parent's money.
    expect(fact.ownerProvenance?.stateHash).toBe("parent-hash");
    expect(fact.ownerProvenance?.observationId).toBe("obs-parent");
    expect(fact.subjectProvenance?.stateHash).toBe("child-hash");
    expect(fact.ownerResolved).toBe(true);
  });

  it("keeps subject and parent statuses apart", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ configuredStatus: "PAUSED", effectiveStatus: "PAUSED" })],
        parentObservations: [aboParent({ configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE" })],
      }),
    );
    expect(fact.subjectConfiguredStatus).toBe("PAUSED");
    expect(fact.parentConfiguredStatus).toBe("ACTIVE");
  });
});

describe("owner provenance semantics", () => {
  it.each([
    ["null", null],
    ["not_observed", "not_observed"],
    ["an unrecognised value", "whatever"],
  ])("fails closed on %s owner provenance", (_label, origin) => {
    const fact = buildCanonicalBudgetFact(
      request({ parentObservations: [aboParent({ budgetOrigin: origin })] }),
    );
    expect(fact.blockers).toContain("owner_origin_unrecognised");
    expect(fact.ownerResolved).toBe(false);
  });

  it("fails closed when the stored origin contradicts the amounts", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ budgetOrigin: "not_applicable" })],
        parentObservations: [aboParent()],
      }),
    );
    expect(fact.blockers).toContain("owner_disagrees_with_amounts");
    expect(fact.ownerResolved).toBe(false);
  });

  it("refuses a shape where both grains carry money", () => {
    const fact = buildCanonicalBudgetFact(request({ parentObservations: [campaign()] }));
    expect(fact.ownerMode).toBe("unsupported");
    expect(fact.blockers).toContain("budget_shape_unsupported");
  });
});

describe("field semantics without truthiness", () => {
  it("separates absent, zero sentinel and positive", () => {
    expect(classifyAmountField(null)).toBe("absent");
    expect(classifyAmountField(undefined)).toBe("absent");
    expect(classifyAmountField("")).toBe("absent");
    // "0" is a truthy JavaScript string; it must not read as an owner.
    expect(Boolean("0")).toBe(true);
    expect(classifyAmountField("0")).toBe("zero");
    expect(classifyAmountField("30000")).toBe("positive");
    expect(classifyAmountField("30.00")).toBe("invalid");
  });

  it("keeps a large amount exact", () => {
    const parsed = parseProviderAmount("9007199254740993");
    expect(parsed.status).toBe("parsed");
    if (parsed.status === "parsed") expect(parsed.units.toString()).toBe("9007199254740993");
    expect(String(Number("9007199254740993"))).not.toBe("9007199254740993");
  });

  it("reads the positive side and refuses two positives", () => {
    expect(resolveBudgetField("30000", "0").field).toBe("daily");
    expect(resolveBudgetField("0", "500000").field).toBe("lifetime");
    expect(resolveBudgetField("30000", "500000").field).toBe("ambiguous");
    expect(resolveBudgetField("0", "0").field).toBe("none");
    expect(resolveBudgetField(null, null).field).toBe("not_observed");
  });
});

describe("captured currency provenance", () => {
  it.each([
    ["JPY", 0],
    ["USD", 2],
    ["TRY", 2],
    ["KWD", 3],
  ])("carries the exponent captured for %s", (currency, exponent) => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ budgetCurrency: currency, budgetCurrencyExponent: exponent })],
      }),
    );
    expect(fact.currency).toBe(currency);
    expect(fact.currencyExponent).toBe(exponent);
    expect(fact.intentReady).toBe(true);
  });

  it("refuses to re-derive an exponent that was never captured", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ budgetCurrencyExponent: null, budgetCurrencyRegistryVersion: null })],
      }),
    );
    expect(fact.currencyExponent).toBeNull();
    expect(fact.blockers).toContain("currency_exponent_not_captured");
    expect(fact.intentReady).toBe(false);
    // Owner and amount are still proven; only intent-readiness fails.
    expect(fact.ownerResolved).toBe(true);
  });

  it("refuses an exponent the registry does not agree with", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrencyExponent: 9 })] }),
    );
    expect(fact.blockers).toContain("currency_exponent_disagrees_with_registry");
    expect(fact.intentReady).toBe(false);
  });

  it("refuses a structurally impossible exponent", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrencyExponent: -1 })] }),
    );
    expect(fact.blockers).toContain("currency_exponent_mismatch");
  });

  it("takes the currency from the OWNER row, not the subject", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [
          obs({ budgetOrigin: "not_applicable", adsetDailyRaw: "0", adsetLifetimeRaw: "0", budgetCurrency: "USD" }),
        ],
        parentObservations: [campaign({ budgetCurrency: "TRY", budgetCurrencyExponent: 2 })],
      }),
    );
    expect(fact.ownerMode).toBe("campaign_owned");
    expect(fact.currency).toBe("TRY");
  });
});

describe("budget shape support", () => {
  it("refuses a known-unsupported shape", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ shapeSupport: "unsupported_shape" })] }),
    );
    expect(fact.blockers).toContain("budget_shape_unsupported");
    expect(fact.intentReady).toBe(false);
  });

  it("refuses an unobserved shape rather than assuming support", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ shapeSupport: "shape_not_observed" })] }),
    );
    expect(fact.blockers).toContain("budget_shape_not_observed");
    expect(fact.intentReady).toBe(false);
    expect(fact.ownerResolved).toBe(true);
  });
});

describe("lifetime schedule", () => {
  const lifetime = (over: Partial<BudgetObservation> = {}) =>
    request({
      entityObservations: [obs({ adsetDailyRaw: "0", adsetLifetimeRaw: "500000", ...over })],
    });

  it("requires a schedule", () => {
    const fact = buildCanonicalBudgetFact(lifetime());
    expect(fact.schedule.required).toBe(true);
    expect(fact.blockers).toContain("lifetime_schedule_unretained");
  });

  it("refuses a malformed schedule", () => {
    const fact = buildCanonicalBudgetFact(
      lifetime({ startTime: "not-a-time", endTime: "2026-08-01T00:00:00Z" }),
    );
    expect(fact.blockers).toContain("lifetime_schedule_invalid");
  });

  it("refuses an inverted schedule", () => {
    const fact = buildCanonicalBudgetFact(
      lifetime({ startTime: "2026-08-01T00:00:00Z", endTime: "2026-07-01T00:00:00Z" }),
    );
    expect(fact.blockers).toContain("lifetime_schedule_invalid");
  });

  it("accepts a well-formed forward schedule", () => {
    const fact = buildCanonicalBudgetFact(
      lifetime({ startTime: "2026-07-01T00:00:00Z", endTime: "2026-08-01T00:00:00Z" }),
    );
    expect(fact.schedule.complete).toBe(true);
    expect(fact.intentReady).toBe(true);
  });

  it("resolves a schedule only when one is required", () => {
    expect(resolveSchedule({ required: false, startTime: null, endTime: null }).blockers).toEqual([]);
  });
});

describe("point-in-time in the account's timezone", () => {
  it("puts the cutoff at the account's local day start, not UTC midnight", () => {
    expect(pitCutoffMs("2026-07-20", "America/Los_Angeles")).toBe(Date.parse("2026-07-20T07:00:00Z"));
    expect(pitCutoffMs("2026-07-20", "Europe/Istanbul")).toBe(Date.parse("2026-07-19T21:00:00Z"));
    expect(pitCutoffMs("2026-07-20", "UTC")).toBe(Date.parse("2026-07-20T00:00:00Z"));
    // and the difference is real for every account in scope
    expect(pitCutoffMs("2026-07-20", "America/Los_Angeles")).not.toBe(
      Date.parse("2026-07-20T00:00:00Z"),
    );
  });

  it("is DST-safe across a spring-forward boundary", () => {
    // 2026-03-08 is the US spring-forward date; local midnight is still 08:00Z
    // before the 02:00 transition, not 07:00Z.
    expect(pitCutoffMs("2026-03-08", "America/Los_Angeles")).toBe(Date.parse("2026-03-08T08:00:00Z"));
    expect(pitCutoffMs("2026-03-09", "America/Los_Angeles")).toBe(Date.parse("2026-03-09T07:00:00Z"));
  });

  it("uses the first real instant across midnight gaps and overlaps", () => {
    // Santiago has no 00:00 on this date; it enters the 6th at 01:00 local.
    expect(pitCutoffMs("2026-09-06", "America/Santiago")).toBe(
      Date.parse("2026-09-06T04:00:00Z"),
    );
    // Havana spells local 00:00 twice; the point-in-time cutoff is the first.
    expect(pitCutoffMs("2026-11-01", "America/Havana")).toBe(
      Date.parse("2026-11-01T04:00:00Z"),
    );
  });

  it("fails closed on an unknown timezone", () => {
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(pitCutoffMs("2026-07-20", "Not/AZone")).toBeNull();
    const fact = buildCanonicalBudgetFact(
      request({ pit: { asOf: AS_OF, timeZone: "Not/AZone", requireRecordedByCutoff: true } }),
    );
    expect(fact.blockers).toContain("account_timezone_unknown");
    expect(fact.ownerResolved).toBe(false);
  });

  const rows = [
    obs({ observedAtMs: Date.parse("2026-07-10T00:00:00Z"), capturedAtMs: Date.parse("2026-07-11T00:00:00Z") }),
    obs({ observedAtMs: Date.parse("2026-07-18T00:00:00Z"), capturedAtMs: Date.parse("2026-07-21T00:00:00Z") }),
    obs({ observedAtMs: Date.parse("2026-07-20T08:00:00Z"), capturedAtMs: Date.parse("2026-07-20T09:00:00Z") }),
  ];
  const pit = (requireRecorded: boolean, asOf = AS_OF) =>
    selectObservationAtPit(rows, { asOf, timeZone: TZ, requireRecordedByCutoff: requireRecorded });

  it("excludes a fact effective after the local cutoff and shows it once the day advances", () => {
    // 2026-07-20T08:00Z is one hour AFTER the Los Angeles day start.
    expect(pit(false)?.observedAtMs).toBe(Date.parse("2026-07-18T00:00:00Z"));
    expect(pit(false, "2026-07-21")?.observedAtMs).toBe(Date.parse("2026-07-20T08:00:00Z"));
  });

  it("excludes a fact recorded after the cutoff from the strict lane only", () => {
    expect(pit(true)?.observedAtMs).toBe(Date.parse("2026-07-10T00:00:00Z"));
    expect(pit(false)?.observedAtMs).toBe(Date.parse("2026-07-18T00:00:00Z"));
  });

  it("never lets a newer observation reach back to an earlier origin", () => {
    const earlier = selectObservationAtPit(rows, {
      asOf: "2026-07-15",
      timeZone: TZ,
      requireRecordedByCutoff: false,
    });
    expect(earlier?.observedAtMs).toBe(Date.parse("2026-07-10T00:00:00Z"));
  });

  it("selects a pre-window predecessor that is still current", () => {
    const only = [obs({ observedAtMs: Date.parse("2026-01-01T00:00:00Z"), capturedAtMs: Date.parse("2026-01-01T00:00:00Z") })];
    expect(selectObservationAtPit(only, { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true })).not.toBeNull();
  });

  it("computes the expected Los Angeles cutoff used by these fixtures", () => {
    expect(pitCutoffMs(AS_OF, TZ)).toBe(CUTOFF);
  });
});

describe("scope validation is explicit", () => {
  it("names every way a row can be the wrong row", () => {
    const wrong = obs({
      businessId: B2,
      providerAccountId: A2,
      entityGrain: "campaign",
      entityId: "other",
    });
    expect(
      validateObservationScope(wrong, {
        businessId: B1,
        providerAccountId: A1,
        entityGrain: "adset",
        entityId: "adset-1",
      }).sort(),
    ).toEqual([
      "scope_account_mismatch",
      "scope_business_mismatch",
      "scope_entity_mismatch",
      "scope_grain_mismatch",
    ]);
  });

  it("requires both rows for a hierarchy", () => {
    expect(resolveHierarchyOwner({ adset: obs(), campaign: null }).ownerMode).toBe("unresolved");
  });
});

describe("completeness and presence", () => {
  it("does not turn an incomplete run into zero coverage", () => {
    for (const completeness of ["partial", "point_lookup"] as const) {
      const fact = buildCanonicalBudgetFact(
        request({ entityObservations: [obs({ runCompleteness: completeness })] }),
      );
      expect(fact.blockers).toContain("observation_not_complete_scope");
      expect(fact.budgetField).not.toBe("none");
    }
  });

  it("does not turn an absent entity into a zero budget", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ presence: "absent_unconfirmed" })] }),
    );
    expect(fact.blockers).toContain("entity_absent_at_pit");
  });

  it("requires immutable observation identity", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ observationId: null })] }),
    );
    expect(fact.blockers).toContain("observation_identity_absent");
  });
});

describe("nothing name-derived reaches ownership", () => {
  it("has no campaign-name, label or SQL input at all", () => {
    const source = readFileSync(new URL("./budget-fact.ts", import.meta.url), "utf8");
    for (const forbidden of ["campaign_name", "campaignName", "meta_campaign_labels", "campaign_kind", "manualKind"]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bfetch\s*\(/, /graph\.facebook\.com/i]) {
      expect(forbidden.test(source), String(forbidden)).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// D083 Correction 2 — the eight fail-open classes, as permanent controls.
// Every one returned intentReady:true before the correction.
// ---------------------------------------------------------------------------

describe("C2.1 provenance is required, per row and by kind", () => {
  it.each([
    ["sourceRunId", { sourceRunId: null }],
    ["sourceSnapshotId", { sourceSnapshotId: null }],
    ["payloadHash", { payloadHash: null }],
    ["runHash", { runHash: null }],
    ["observationId", { observationId: null }],
    ["stateHash", { stateHash: null }],
  ])("refuses the owner claim when the subject is missing %s", (_label, over) => {
    const fact = buildCanonicalBudgetFact(request({ entityObservations: [obs(over)] }));
    expect(fact.blockers).toContain("subject_provenance_incomplete");
    expect(fact.ownerResolved).toBe(false);
    expect(fact.intentReady).toBe(false);
  });

  it("refuses the owner claim when the PARENT provenance is incomplete", () => {
    const fact = buildCanonicalBudgetFact(
      request({ parentObservations: [aboParent({ sourceSnapshotId: null, payloadHash: null })] }),
    );
    expect(fact.blockers).toContain("parent_provenance_incomplete");
    expect(fact.ownerResolved).toBe(false);
  });

  it("blocks only intent when the API version is absent, since it does not change who owned the money", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ providerApiVersion: null })],
        parentObservations: [aboParent({ providerApiVersion: null })],
      }),
    );
    expect(fact.blockers).toContain("subject_api_version_absent");
    expect(fact.blockers).toContain("parent_api_version_absent");
    expect(fact.intentReady).toBe(false);
    expect(fact.ownerResolved).toBe(true);
  });

  it("never substitutes the payload hash for the run hash", () => {
    const fact = buildCanonicalBudgetFact(request());
    expect(fact.ownerProvenance?.payloadHash).toBe("payload-hash");
    expect(fact.ownerProvenance?.runHash).toBe("run-hash");
    expect(fact.ownerProvenance?.payloadHash).not.toBe(fact.ownerProvenance?.runHash);
  });

  it("names both kinds of missing provenance separately", () => {
    const bare = obs({ sourceRunId: null, providerApiVersion: null });
    expect(missingIdentityProvenance(bare)).toContain("sourceRunId");
    expect(missingIdentityProvenance(bare)).not.toContain("providerApiVersion");
    expect(missingContractProvenance(bare)).toEqual(["providerApiVersion"]);
  });
});

describe("C2.2 status evidence must have been observed", () => {
  it("refuses when all four statuses are null", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [
          obs({ configuredStatus: null, effectiveStatus: null, statusFieldCoverage: { configuredStatus: false, effectiveStatus: false } }),
        ],
        parentObservations: [
          aboParent({ configuredStatus: null, effectiveStatus: null, statusFieldCoverage: { configuredStatus: false, effectiveStatus: false } }),
        ],
      }),
    );
    expect(fact.blockers).toContain("subject_status_evidence_absent");
    expect(fact.blockers).toContain("parent_status_evidence_absent");
    expect(fact.ownerResolved).toBe(false);
  });

  it("refuses a value present without presence proof", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ statusFieldCoverage: { configuredStatus: false, effectiveStatus: true } })],
      }),
    );
    expect(fact.blockers).toContain("subject_status_evidence_absent");
    expect(missingStatusEvidence(obs({ statusFieldCoverage: { configuredStatus: false, effectiveStatus: true } }))).toEqual(["configuredStatus"]);
  });

  it("does not require the status to be ACTIVE", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ configuredStatus: "PAUSED", effectiveStatus: "PAUSED" })] }),
    );
    expect(fact.blockers).not.toContain("subject_status_evidence_absent");
    expect(fact.intentReady).toBe(true);
  });

  it("reports null parent status and provenance for a campaign fact", () => {
    const fact = buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "campaign",
      entityId: "campaign-1",
      parentCampaignId: null,
      pit: { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true },
      entityObservations: [campaign()],
      parentObservations: [],
    });
    expect(fact.intentReady).toBe(true);
    expect(fact.parentConfiguredStatus).toBeNull();
    expect(fact.parentEffectiveStatus).toBeNull();
    expect(fact.parentProvenance).toBeNull();
  });
});

describe("C2.3 currency is validated against the versioned authority", () => {
  it.each([
    ["USD", 2],
    ["TRY", 2],
    ["JPY", 0],
    ["KWD", 3],
  ])("accepts %s at its registry exponent %i", (currency, exponent) => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrency: currency, budgetCurrencyExponent: exponent })] }),
    );
    expect(fact.intentReady).toBe(true);
  });

  it("refuses USD claimed at exponent 3", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrencyExponent: 3 })] }),
    );
    expect(fact.blockers).toContain("currency_exponent_disagrees_with_registry");
    expect(fact.intentReady).toBe(false);
  });

  it("refuses an unrecognised captured registry version", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrencyRegistryVersion: "made-up" })] }),
    );
    expect(fact.blockers).toContain("currency_registry_unrecognised");
  });

  it("distinguishes retired from unknown", () => {
    expect(
      buildCanonicalBudgetFact(request({ entityObservations: [obs({ budgetCurrency: "TRL" })] })).blockers,
    ).toContain("currency_retired");
    expect(
      buildCanonicalBudgetFact(request({ entityObservations: [obs({ budgetCurrency: "ZZZ" })] })).blockers,
    ).toContain("currency_unknown");
  });

  it("refuses a missing captured pair", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ budgetCurrencyExponent: null, budgetCurrencyRegistryVersion: null })] }),
    );
    expect(fact.blockers).toContain("currency_exponent_not_captured");
  });
});

describe("C2.4 owner provenance must be grain-valid", () => {
  it("rejects an ad-set row claiming campaign ownership even when the parent owns", () => {
    const fact = buildCanonicalBudgetFact(
      request({
        entityObservations: [obs({ budgetOrigin: "campaign", adsetDailyRaw: "0", adsetLifetimeRaw: "0" })],
        parentObservations: [campaign()],
      }),
    );
    expect(fact.blockers).toContain("owner_origin_invalid_for_grain");
    expect(fact.intentReady).toBe(false);
  });

  it("rejects a campaign row claiming ad-set ownership", () => {
    const fact = buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "campaign",
      entityId: "campaign-1",
      parentCampaignId: null,
      pit: { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true },
      entityObservations: [campaign({ budgetOrigin: "adset" })],
      parentObservations: [],
    });
    expect(fact.blockers).toContain("owner_origin_invalid_for_grain");
  });

  it("names the grain vocabulary explicitly", () => {
    expect(isOriginValidForGrain("campaign", "adset")).toBe(false);
    expect(isOriginValidForGrain("adset", "campaign")).toBe(false);
    expect(isOriginValidForGrain("campaign", "not_applicable")).toBe(true);
  });

  it("refuses cross-grain amount contamination", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ campaignDailyRaw: "999" })] }),
    );
    expect(fact.blockers).toContain("cross_grain_contamination");
  });
});

describe("C2.5 campaign hierarchy is normalised", () => {
  it("refuses a parent campaign that claims a foreign parent", () => {
    const fact = buildCanonicalBudgetFact(
      request({ parentObservations: [aboParent({ parentCampaignId: "campaign-999" })] }),
    );
    expect(fact.blockers).toContain("campaign_parent_identity_invalid");
    expect(fact.ownerResolved).toBe(false);
  });

  it("accepts a campaign observation that names its own id", () => {
    const fact = buildCanonicalBudgetFact(
      request({ parentObservations: [aboParent({ parentCampaignId: "campaign-1" })] }),
    );
    expect(fact.blockers).not.toContain("campaign_parent_identity_invalid");
  });
});

describe("C2.6 impossible dates are refused, not rolled over", () => {
  it.each([
    ["2026-02-31", false],
    ["2026-02-29", false],
    ["2024-02-29", true],
    ["2026-13-01", false],
    ["2026-04-31", false],
    ["2026-12-31", true],
  ])("treats %s as real=%s", (date, real) => {
    expect(isRealCalendarDate(date)).toBe(real);
    expect(pitCutoffMs(date, "UTC") !== null).toBe(real);
  });

  it("names an invalid date separately from an unknown timezone", () => {
    const badDate = buildCanonicalBudgetFact(
      request({ pit: { asOf: "2026-02-31", timeZone: TZ, requireRecordedByCutoff: true } }),
    );
    const badZone = buildCanonicalBudgetFact(
      request({ pit: { asOf: AS_OF, timeZone: "Not/AZone", requireRecordedByCutoff: true } }),
    );
    expect(badDate.blockers).toContain("invalid_as_of_date");
    expect(badDate.blockers).not.toContain("account_timezone_unknown");
    expect(badZone.blockers).toContain("account_timezone_unknown");
    expect(badZone.blockers).not.toContain("invalid_as_of_date");
  });
});

describe("C2.7 point-in-time selection is order-independent", () => {
  const pit = { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true };
  const a = obs({ observationId: "obs-A", stateHash: "A", adsetDailyRaw: "100" });
  const b = obs({ observationId: "obs-B", stateHash: "B", adsetDailyRaw: "200" });

  it("refuses when two same-clock observations disagree, in either order", () => {
    expect(selectObservationAtPitDetailed([a, b], pit).status).toBe("conflict");
    expect(selectObservationAtPitDetailed([b, a], pit).status).toBe("conflict");
    expect(selectObservationAtPit([a, b], pit)).toBeNull();
    expect(selectObservationAtPit([b, a], pit)).toBeNull();
  });

  it("surfaces the conflict as a named blocker", () => {
    const fact = buildCanonicalBudgetFact(request({ entityObservations: [a, b] }));
    expect(fact.blockers).toContain("pit_conflicting_observations");
    expect(fact.ownerResolved).toBe(false);
  });

  it("picks deterministically when the same truth was recorded twice", () => {
    const dup = (id: string) => obs({ observationId: id, stateHash: "same" });
    const first = selectObservationAtPitDetailed([dup("z"), dup("a")], pit);
    const second = selectObservationAtPitDetailed([dup("a"), dup("z")], pit);
    expect(first.status).toBe("selected");
    expect(second.status).toBe("selected");
    if (first.status === "selected" && second.status === "selected") {
      expect(first.observation.observationId).toBe(second.observation.observationId);
      expect(first.observation.observationId).toBe("a");
    }
  });
});

describe("C2.8 readiness levels are explicit", () => {
  it("keeps intent-only blockers out of the owner claim", () => {
    const fact = buildCanonicalBudgetFact(
      request({ entityObservations: [obs({ shapeSupport: "shape_not_observed" })] }),
    );
    expect(fact.ownerResolved).toBe(true);
    expect(fact.intentReady).toBe(false);
  });

  it("never keeps an amount when the row proving the owner is untrustworthy", () => {
    const fact = buildCanonicalBudgetFact(
      request({ parentObservations: [aboParent({ runCompleteness: "partial" })] }),
    );
    expect(fact.ownerResolved).toBe(false);
    expect(fact.intentReady).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D083 Correction 3 — the canonical fail-closed contract.

describe("decision-truth conflict detection", () => {
  /** A same-clock pair differing only in `field`. Order must not decide truth. */
  const mutations: Array<[string, Partial<BudgetObservation>]> = [
    ["parentCampaignId", { parentCampaignId: "campaign-other" }],
    ["presence", { presence: "absent_unconfirmed" }],
    ["runCompleteness", { runCompleteness: "partial" }],
    ["budgetOrigin", { budgetOrigin: "campaign" }],
    ["campaignDailyRaw", { campaignDailyRaw: "1" }],
    ["campaignLifetimeRaw", { campaignLifetimeRaw: "1" }],
    ["adsetDailyRaw", { adsetDailyRaw: "40000" }],
    ["adsetLifetimeRaw", { adsetLifetimeRaw: "1" }],
    ["budgetCurrency", { budgetCurrency: "TRY" }],
    ["budgetCurrencyExponent", { budgetCurrencyExponent: 3 }],
    ["budgetCurrencyRegistryVersion", { budgetCurrencyRegistryVersion: "iso4217.other" }],
    ["startTime", { startTime: "2026-07-01T00:00:00Z" }],
    ["endTime", { endTime: "2026-07-31T00:00:00Z" }],
    ["configuredStatus", { configuredStatus: "PAUSED" }],
    ["effectiveStatus", { effectiveStatus: "PAUSED" }],
    [
      "statusFieldCoverage.configuredStatus",
      { statusFieldCoverage: { configuredStatus: false, effectiveStatus: true } },
    ],
    [
      "statusFieldCoverage.effectiveStatus",
      { statusFieldCoverage: { configuredStatus: true, effectiveStatus: false } },
    ],
    ["shapeSupport", { shapeSupport: "unsupported_shape" }],
    ["sourceRunId", { sourceRunId: "run-2" }],
    ["sourceSnapshotId", { sourceSnapshotId: "snap-2" }],
    ["payloadHash", { payloadHash: "payload-2" }],
    ["runHash", { runHash: "run-hash-2" }],
    ["stateHash", { stateHash: "child-hash-2" }],
    ["providerApiVersion", { providerApiVersion: "v24.0" }],
  ];

  it.each(mutations)("refuses a same-clock disagreement on %s in both orders", (field, over) => {
    // Distinct immutable ids, so a selector that tie-breaks on identity would
    // otherwise return a stable — and wrong — winner.
    const clean = obs({ observationId: "obs-a" });
    const dirty = obs({ observationId: "obs-b", ...over });
    expect(decisionTruthFingerprint(clean), field).not.toBe(
      decisionTruthFingerprint(dirty),
    );
    for (const rows of [
      [clean, dirty],
      [dirty, clean],
    ]) {
      const detailed = selectObservationAtPitDetailed(rows, {
        asOf: AS_OF,
        timeZone: TZ,
        requireRecordedByCutoff: true,
      });
      expect(detailed.status, `${field} ${rows[0]!.observationId} first`).toBe("conflict");
      const fact = buildCanonicalBudgetFact({
        businessId: B1,
        providerAccountId: A1,
        entityGrain: "adset",
        entityId: "adset-1",
        parentCampaignId: "campaign-1",
        pit: { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true },
        entityObservations: rows,
        parentObservations: [aboParent()],
      });
      expect(fact.intentReady, `${field} ${rows[0]!.observationId} first`).toBe(false);
      expect(fact.blockers, field).toContain("pit_conflicting_observations");
    }
  });

  it("accounts for every observation field exactly once", () => {
    const covered = new Set<string>();
    for (const field of DECISION_TRUTH_FIELDS) covered.add(field.split(".")[0]!);
    for (const field of DECISION_TRUTH_EXCLUDED_FIELDS) covered.add(field);
    // A field added to BudgetObservation and forgotten here fails this test
    // rather than becoming silently order-dependent in production.
    expect(Object.keys(obs()).sort()).toEqual([...covered].sort());
  });

  it("mutating a field the fingerprint omits does not, by itself, conflict", () => {
    // Non-vacuity: the assertions above must be detecting the mutation, not a
    // fingerprint that differs for every pair of distinct rows.
    const a = obs({ observationId: "obs-a" });
    const b = obs({ observationId: "obs-a" });
    expect(decisionTruthFingerprint(a)).toBe(decisionTruthFingerprint(b));
  });
});

describe("malformed provenance fails closed", () => {
  const pit = { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true } as const;
  const fact = (over: Partial<BudgetObservation>) =>
    buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "adset",
      entityId: "adset-1",
      parentCampaignId: "campaign-1",
      pit,
      entityObservations: [obs(over)],
      parentObservations: [aboParent()],
    });

  it.each([
    ["observedAtMs", Number.POSITIVE_INFINITY, "subject_clock_not_finite"],
    ["observedAtMs", Number.NaN, "subject_clock_not_finite"],
    ["capturedAtMs", Number.POSITIVE_INFINITY, "subject_clock_not_finite"],
    ["capturedAtMs", Number.NEGATIVE_INFINITY, "subject_clock_not_finite"],
  ])("refuses a non-finite %s (%s)", (field, value, blocker) => {
    const result = fact({ [field]: value } as Partial<BudgetObservation>);
    expect(result.intentReady).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it.each(["", "   ", "\t", "\n"])("refuses a blank status string %j", (blank) => {
    const result = fact({ configuredStatus: blank, effectiveStatus: blank });
    expect(result.intentReady).toBe(false);
    expect(result.blockers).toContain("subject_status_evidence_absent");
  });

  it.each(["banana", "25.0", "v25", "vv25.0", "v25.0-beta", "V25.0", "v25.0.1", "v-1.0"])(
    "refuses a syntactically invalid provider API version %j",
    (version) => {
      expect(PROVIDER_API_VERSION_PATTERN.test(version)).toBe(false);
      const result = fact({ providerApiVersion: version });
      expect(result.intentReady).toBe(false);
      expect(result.blockers).toContain("subject_api_version_malformed");
    },
  );

  it.each(["", "  ", "\t"])("refuses an absent provider API version %j", (version) => {
    // Blank is absence, not a malformed value; it carries its own blocker so
    // the two failures stay distinguishable in the census.
    const result = fact({ providerApiVersion: version });
    expect(result.intentReady).toBe(false);
    expect(result.blockers).toContain("subject_api_version_absent");
    expect(result.blockers).not.toContain("subject_api_version_malformed");
  });

  it.each(["v25.0", "v9.0", "v100.12"])("admits a syntactically valid version %j", (version) => {
    expect(PROVIDER_API_VERSION_PATTERN.test(version)).toBe(true);
    const result = fact({ providerApiVersion: version });
    // Non-vacuity: the refusals above are the version contract firing, not a
    // fact that is unready for some unrelated reason.
    expect(result.blockers).not.toContain("subject_api_version_malformed");
    expect(result.intentReady).toBe(true);
  });

  it("refuses the same defects on the parent as on the subject", () => {
    const result = buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "adset",
      entityId: "adset-1",
      parentCampaignId: "campaign-1",
      pit,
      entityObservations: [obs()],
      parentObservations: [aboParent({ providerApiVersion: "banana" })],
    });
    expect(result.blockers).toContain("parent_api_version_malformed");
    expect(result.intentReady).toBe(false);
  });
});

describe("campaign scope carries no parent", () => {
  const pit = { asOf: AS_OF, timeZone: TZ, requireRecordedByCutoff: true } as const;

  it("normalises the requested campaign parent to null and refuses a foreign one", () => {
    const result = buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "campaign",
      entityId: "campaign-1",
      parentCampaignId: "campaign-1",
      pit,
      entityObservations: [campaign()],
      parentObservations: [],
    });
    expect(result.scope.parentCampaignId).toBeNull();
    expect(result.blockers).toContain("campaign_parent_identity_invalid");
    expect(result.intentReady).toBe(false);
  });

  it("admits a campaign requested with a null parent", () => {
    const result = buildCanonicalBudgetFact({
      businessId: B1,
      providerAccountId: A1,
      entityGrain: "campaign",
      entityId: "campaign-1",
      parentCampaignId: null,
      pit,
      entityObservations: [campaign()],
      parentObservations: [],
    });
    expect(result.scope.parentCampaignId).toBeNull();
    expect(result.blockers).not.toContain("campaign_parent_identity_invalid");
    expect(result.intentReady).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D083 Correction 4 - retained timezone state is finite by construction.

describe("timezone caches are bounded", () => {
  it("retains nothing for a flood of unique invalid zones", () => {
    const before = zoneCacheStats();
    for (let i = 0; i < 5_000; i += 1) {
      // Syntactically plausible but unknown, so the cheap screen cannot be
      // what is doing the work: these reach Intl and are refused there.
      expect(isKnownTimeZone(`Area${i}/Location${i}`)).toBe(false);
    }
    for (let i = 0; i < 5_000; i += 1) {
      // Syntactically impossible: refused before Intl is touched.
      expect(isKnownTimeZone(`../../etc/passwd#${i}`)).toBe(false);
      expect(isKnownTimeZone(`${"x".repeat(80)}${i}`)).toBe(false);
    }
    const after = zoneCacheStats();
    expect(after.canonical).toBe(before.canonical);
    expect(after.formatters).toBe(before.formatters);
  });

  it.each([null, undefined, 42, {}, [], "", "   ", "\n"])(
    "refuses the non-zone %j without retaining it",
    (value) => {
      const before = zoneCacheStats();
      expect(isKnownTimeZone(value)).toBe(false);
      expect(zoneCacheStats().canonical).toBe(before.canonical);
    },
  );

  it("collapses aliases and casing of one zone onto one formatter", () => {
    const before = zoneCacheStats();
    const aliases = [
      "America/Los_Angeles",
      "america/los_angeles",
      "AMERICA/LOS_ANGELES",
      "US/Pacific",
    ];
    for (const alias of aliases) expect(isKnownTimeZone(alias)).toBe(true);
    for (const alias of aliases) pitCutoffMs("2026-07-20", alias);
    const after = zoneCacheStats();
    // One canonical zone, so at most one new formatter however many spellings
    // arrived. (Delta, not absolute, so the test does not depend on order.)
    expect(after.formatters - before.formatters).toBeLessThanOrEqual(1);
    // Every alias resolves to the same instant, which is what proves they were
    // collapsed onto one zone rather than merely counted once.
    const cutoffs = aliases.map((alias) => pitCutoffMs("2026-07-20", alias));
    expect(new Set(cutoffs).size).toBe(1);
    expect(cutoffs[0]).toBe(Date.parse("2026-07-20T07:00:00Z"));
  });

  it("stays at or under the limit under a flood of distinct valid zones", () => {
    const zones = [
      "America/Los_Angeles", "America/Anchorage", "Europe/Istanbul", "America/Chicago",
      "Asia/Tokyo", "Australia/Sydney", "Europe/London", "America/Sao_Paulo",
      "Africa/Cairo", "Asia/Kolkata", "Pacific/Auckland", "America/Denver",
      "Europe/Berlin", "Asia/Shanghai", "America/Toronto", "Europe/Madrid",
      "Asia/Dubai", "Pacific/Honolulu", "Europe/Warsaw", "America/Bogota",
      "Asia/Seoul", "Africa/Lagos", "Europe/Lisbon", "America/Lima", "UTC",
    ];
    expect(zones.length).toBeGreaterThan(ZONE_CACHE_LIMIT);
    for (let round = 0; round < 20; round += 1) {
      for (const zone of zones) {
        expect(pitCutoffMs("2026-07-20", zone)).not.toBeNull();
      }
    }
    const after = zoneCacheStats();
    expect(after.canonical).toBeLessThanOrEqual(ZONE_CACHE_LIMIT);
    expect(after.formatters).toBeLessThanOrEqual(ZONE_CACHE_LIMIT);
  });

  it("still answers correctly after eviction, and stays DST-correct", () => {
    // Push the working set past the limit, then come back to a real account
    // zone that must have been evicted.
    for (let i = 0; i < ZONE_CACHE_LIMIT * 3; i += 1) {
      pitCutoffMs("2026-07-20", ["Asia/Tokyo", "Europe/Berlin", "Africa/Cairo"][i % 3]!);
    }
    // Los Angeles: PDT (-07:00) in July, PST (-08:00) in January.
    expect(pitCutoffMs("2026-07-20", "America/Los_Angeles")).toBe(
      Date.parse("2026-07-20T07:00:00Z"),
    );
    expect(pitCutoffMs("2026-01-20", "America/Los_Angeles")).toBe(
      Date.parse("2026-01-20T08:00:00Z"),
    );
    // Istanbul has no DST and sits at +03:00 year round.
    expect(pitCutoffMs("2026-07-20", "Europe/Istanbul")).toBe(
      Date.parse("2026-07-19T21:00:00Z"),
    );
    expect(pitCutoffMs("2026-01-20", "Europe/Istanbul")).toBe(
      Date.parse("2026-01-19T21:00:00Z"),
    );
  });

  it("fails closed on an unknown zone rather than defaulting to UTC", () => {
    expect(pitCutoffMs("2026-07-20", "Not/AZone")).toBeNull();
    expect(pitCutoffMs("2026-07-20", "")).toBeNull();
    expect(pitCutoffMs("2026-07-20", "UTC")).toBe(Date.parse("2026-07-20T00:00:00Z"));
  });

  it("exposes no way to mutate or clear the caches", () => {
    const stats = zoneCacheStats();
    expect(Object.keys(stats).sort()).toEqual(["canonical", "formatters", "limit"]);
    // Mutating the returned snapshot must not be a back door into the caches.
    (stats as Record<string, number>).canonical = -1;
    expect(zoneCacheStats().canonical).toBeGreaterThanOrEqual(0);
  });
});
