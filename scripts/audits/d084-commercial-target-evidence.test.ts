import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  D084_ORDER_SEMANTICS,
  buildWorldSpace,
  capInWorld,
  cooldownInWorld,
  lookbackInWorld,
  scopeKeyOf,
  setPartitions,
  type CellOutcome,
  type GroupInput,
  type WorldScope,
} from "@/scripts/audits/d084-possible-worlds";
import {
  oracleCell,
  oracleRepeatBounds,
  oracleSpace,
  type OracleCell,
} from "@/scripts/audits/d084-independent-oracle";

/** The six published extrema, for cell-vs-oracle comparison. */
const pickBounds = (o: CellOutcome | OracleCell) => ({
  evaluatedLower: o.evaluatedLower, evaluatedUpper: o.evaluatedUpper,
  blockedLower: o.blockedLower, blockedUpper: o.blockedUpper,
  clearedLower: o.clearedLower, clearedUpper: o.clearedUpper,
});
import { loadPinnedSources, type ConfigStateRow, type DailyRow, type OwnerStateRow } from "@/scripts/audits/d084-pinned-sources";
import {
  D084_CHARTER_BUSINESSES,
  D084_CONCENTRATION_CANDIDATES,
  D084_CONTRACT_ID,
  D084_COUNT_SEMANTICS,
  D084_EVENT_WINDOWS_DAYS,
  D084_GRID_BASELINE,
  D084_GRID_DIMENSIONS,
  D084_JSON_OUT,
  D084_PROFILE_ACTIONS,
  D084_SUPERSEDES,
  ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED,
  analyse,
  assembleFrozen,
  buildCanonicalProfileAvailability,
  buildCapGrid,
  buildConcentrationGrid,
  buildCooldownGrid,
  buildEventGroups,
  buildEventMembers,
  buildLookbackGrid,
  buildTargetPackAsOf,
  budgetAsOfPit,
  daysBetween,
  decodeConfig,
  decodeDaily,
  encodeDaily,
  eventCountBounds,
  instantMs,
  selectTargetPackAsOf,
  selectOwnerStateAsOf,
  toWorldGroups,
  verifyArtifact,
  type Row,
} from "@/scripts/audits/d084-commercial-target-evidence";
import { checkPinnedSources } from "@/scripts/audits/d084-pinned-sources";

const ARTIFACT_PATH = resolve(D084_JSON_OUT);
const loadArtifact = () => JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Record<string, unknown>;

const IWA = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";

// ---------------------------------------------------------------------------
// Rejection 2 — date-only parsing
// ---------------------------------------------------------------------------

describe("clocks parse dates and hours-only offsets alike", () => {
  it.each([
    ["2026-05-23", Date.parse("2026-05-23T00:00:00.000Z")],
    ["2026-04-30", Date.parse("2026-04-30T00:00:00.000Z")],
    ["2026-08-06", Date.parse("2026-08-06T00:00:00.000Z")],
  ])("parses the date-only value %s", (value, expected) => {
    // The exact r2 defect: the `/[+-]\d{2}$/` repair matched the DAY component
    // and produced the unparsable "2026-05-23:00", so every date-only value
    // became null.
    expect(instantMs(value)).toBe(expected);
    expect(instantMs(value)).not.toBeNull();
  });

  it.each([
    ["2026-05-23 00:00:00+00", Date.parse("2026-05-23T00:00:00.000Z")],
    ["2026-05-23 12:00:00-05", Date.parse("2026-05-23T17:00:00.000Z")],
    ["2026-05-23 12:00:00.123456+03", Date.parse("2026-05-23T09:00:00.123Z")],
  ])("still completes the hours-only offset in %s", (value, expected) => {
    // Postgres renders timestamptz with an hours-only offset that Date.parse
    // rejects outright, so the repair must survive.
    expect(Date.parse(value.replace(" ", "T"))).toBeNaN();
    expect(instantMs(value)).toBe(expected);
  });

  it.each([
    ["2026-05-23T00:00:00Z", Date.parse("2026-05-23T00:00:00.000Z")],
    ["2026-05-23 12:00:00+03:00", Date.parse("2026-05-23T09:00:00.000Z")],
  ])("leaves an already-complete instant alone: %s", (value, expected) => {
    expect(instantMs(value)).toBe(expected);
  });

  it.each([["not a date"], ["2026-13-45"], [""], [null], [undefined], [{}]])(
    "refuses the invalid value %s",
    (value) => {
      expect(instantMs(value)).toBeNull();
    },
  );

  it("orders instants correctly across all three forms", () => {
    const ordered = ["2026-05-22", "2026-05-23 00:00:00+00", "2026-05-23T06:00:00Z", "2026-05-24"];
    const parsed = ordered.map((v) => instantMs(v));
    expect(parsed.every((p) => p !== null)).toBe(true);
    for (let i = 1; i < parsed.length; i += 1) {
      expect(parsed[i]! > parsed[i - 1]!, `${ordered[i]} after ${ordered[i - 1]}`).toBe(true);
    }
  });

  it("measures whole-day gaps, which cooldown and lookback depend on", () => {
    expect(daysBetween("2026-05-20", "2026-05-27")).toBe(7);
    expect(daysBetween("2026-05-20", "2026-05-20")).toBe(0);
    expect(daysBetween("2026-05-27", "2026-05-20")).toBe(-7);
    expect(daysBetween("nonsense", "2026-05-20")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rejection 7 — tombstones
// ---------------------------------------------------------------------------

describe("the target selector honours tombstones", () => {
  const pack = (over: Row = {}): Row => ({
    id: "r1", business_id: IWA, operation: "upsert",
    effective_at: "2026-05-01 00:00:00+00", recorded_at: "2026-05-01 00:00:00+00",
    target_roas: 3.5, break_even_roas: 2.7,
    ...over,
  });

  it("returns the latest knowable upsert", () => {
    const packs = [pack(), pack({ id: "r2", effective_at: "2026-06-01 00:00:00+00", recorded_at: "2026-06-01 00:00:00+00", target_roas: 4 })];
    const chosen = selectTargetPackAsOf(packs, "2026-07-01");
    expect(chosen.selected?.revisionId).toBe("r2");
    expect(chosen.absentReason).toBeNull();
  });

  it("returns NOTHING when the latest knowable revision is a delete", () => {
    const packs = [
      pack(),
      pack({ id: "r2", operation: "delete", effective_at: "2026-06-01 00:00:00+00", recorded_at: "2026-06-01 00:00:00+00" }),
    ];
    const chosen = selectTargetPackAsOf(packs, "2026-07-01");
    expect(chosen.selected).toBeNull();
    expect(chosen.absentReason).toBe("latest_knowable_revision_is_a_tombstone");
    expect(chosen.tombstone?.revisionId).toBe("r2");
    const asOf = buildTargetPackAsOf(packs, "2026-07-01");
    expect(asOf.configured).toBe(false);
    expect(asOf.approvedForPolicyWhy).toContain("tombstone");
  });

  it("still returns the earlier pack at an origin BEFORE the tombstone", () => {
    // Non-vacuity: the delete removes the pack from its own time forward, not
    // retroactively.
    const packs = [
      pack(),
      pack({ id: "r2", operation: "delete", effective_at: "2026-06-01 00:00:00+00", recorded_at: "2026-06-01 00:00:00+00" }),
    ];
    expect(selectTargetPackAsOf(packs, "2026-05-15").selected?.revisionId).toBe("r1");
  });

  it("re-selects a pack written after a tombstone", () => {
    const packs = [
      pack(),
      pack({ id: "r2", operation: "delete", effective_at: "2026-06-01 00:00:00+00", recorded_at: "2026-06-01 00:00:00+00" }),
      pack({ id: "r3", effective_at: "2026-07-01 00:00:00+00", recorded_at: "2026-07-01 00:00:00+00" }),
    ];
    expect(selectTargetPackAsOf(packs, "2026-08-01").selected?.revisionId).toBe("r3");
  });

  it("needs BOTH clocks: a future-effective revision recorded early is not knowable", () => {
    const packs = [pack({ id: "future", effective_at: "2026-12-01 00:00:00+00", recorded_at: "2026-05-01 00:00:00+00" })];
    expect(selectTargetPackAsOf(packs, "2026-06-01").selected).toBeNull();
    expect(selectTargetPackAsOf(packs, "2026-06-01").absentReason).toBe("no_revision_knowable_at_this_origin");
    expect(selectTargetPackAsOf(packs, "2026-12-02").selected?.revisionId).toBe("future");
  });

  it("needs BOTH clocks: a backfilled revision is not knowable before it was recorded", () => {
    const packs = [pack({ id: "backfill", effective_at: "2026-04-01 00:00:00+00", recorded_at: "2026-07-14 00:00:00+00" })];
    expect(selectTargetPackAsOf(packs, "2026-05-01").selected).toBeNull();
    expect(selectTargetPackAsOf(packs, "2026-07-15").selected?.revisionId).toBe("backfill");
  });

  it("publishes the five states side by side at every origin", () => {
    const asOf = buildTargetPackAsOf([pack()], "2026-07-01");
    expect(asOf.configured).toBe(true);
    expect(asOf.pitKnowableAt).not.toBeNull();
    expect(Object.keys(asOf.freshUnderWindowDays).length).toBeGreaterThan(0);
    expect(typeof asOf.economicallyReconciled).toBe("boolean");
    expect(asOf.approvedForPolicy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rejection 6 — no invented profile verdict
// ---------------------------------------------------------------------------

describe("no canonical profile verdict is manufactured", () => {
  const availability = buildCanonicalProfileAvailability([
    {
      businessId: IWA, businessName: "IwaStore", currency: "USD",
      byAction: [{ action: "cut", heldBefore: 534, eligibleBefore: 0, profileFamilyTransitions: 511 }],
      sourceContract: "adsecute.meta.commercial-anchor-counterfactual.v2",
    },
  ]);

  it("publishes every action as not_determinable with a named reason", () => {
    expect(availability).toHaveLength(D084_CHARTER_BUSINESSES.length);
    for (const business of availability) {
      expect(business.byAction.map((a) => a.action)).toEqual([...D084_PROFILE_ACTIONS]);
      for (const action of business.byAction) {
        expect(action.status).toBe("not_determinable");
        expect(action.reasonCode).toBe("canonical_profile_output_not_retained");
        // No invented true and no invented false.
        expect(action.eligible).toBeNull();
        expect(action.code).toBeNull();
        expect(action.anchorExplanation).toBeNull();
      }
    }
  });

  it("names the expected contract and refuses to name an observed one", () => {
    for (const business of availability) {
      for (const action of business.byAction) {
        expect(action.expectedContract).toBe(ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED);
        expect(action.observedContract).toBeNull();
        // r2 labelled its inferred boolean with the D079 COUNTERFACTUAL
        // contract, which never produced an AccountDecisionProfile.
        expect(action.expectedContract).not.toContain("commercial-anchor-counterfactual");
      }
    }
  });

  it("keeps the persisted census as evidence and never as eligibility", () => {
    const iwa = availability.find((a) => a.businessId === IWA)!;
    expect(iwa.persistedDecisionCensus?.byAction[0]?.profileFamilyTransitions).toBe(511);
    expect(iwa.censusIsNotAProfile).toContain("never be read as eligibility");
    // A large family count must not have become an ineligible verdict.
    expect(iwa.byAction.every((a) => a.eligible === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejection 3 — grouping, members, and honest bounds
// ---------------------------------------------------------------------------

describe("event grouping proves what it claims and no more", () => {
  const daily = (grain: string, entityId: string, parent: string): DailyRow => ({
    businessId: IWA, providerAccountId: "act_1", grain, entityId,
    parentCampaignId: parent, date: "2026-06-01", status: "ACTIVE", accountCurrency: "USD",
    dailyBudgetRaw: 1000, lifetimeBudgetRaw: null, isBudgetMixed: false,
    spend: 10, conversions: 1, revenue: 40, truthState: "finalized",
  });
  const owner = (entityType: string, entityId: string, origin: string): OwnerStateRow => ({
    businessId: IWA, providerAccountId: "act_1", entityType, entityId,
    campaignId: "c1", observedOn: "2026-06-01", capturedAt: "2026-06-01 00:00:00+00",
    budgetOrigin: origin, budgetCurrency: "USD",
  });
  const tx = (grain: string, entityId: string) => ({
    sourceRowKey: `${IWA}|act_1|${grain}|${entityId}|2026-05-30|2026-06-02`,
    sourceEntityKey: `act_1|${grain}|${entityId}`,
    businessId: IWA, providerAccountId: "act_1", grain, entityId,
    prevEffectiveFrom: "2026-05-30", effectiveFrom: "2026-06-02",
    direction: "increase", percent: 20, semantics: "resolved",
  });

  it("refuses to merge two sibling ad sets into one proved action", () => {
    // The exact defect: same account, same date, same direction, same percent,
    // DIFFERENT entities. r2's key omitted grain and entity, so these became
    // one event whose bounds stayed 1..1 with no owner proof at all.
    const members = buildEventMembers(
      [tx("adset", "a1"), tx("adset", "a2")],
      [daily("adset", "a1", "c1"), daily("adset", "a2", "c1")],
      [],
    );
    const groups = buildEventGroups(members);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
    expect(groups[0]!.groupingProof).toBe("ambiguous_multi_member");
    expect(groups[0]!.representativeMemberKey).toBeNull();
    expect(groups[0]!.upperBoundActions).toBe(2);
    const bounds = eventCountBounds(groups);
    expect(bounds.lower).toBe(1);
    expect(bounds.upper).toBe(2);
  });

  it("proves an owner mirror only when the retained owner rows say so", () => {
    const members = buildEventMembers(
      [tx("campaign", "c1"), tx("adset", "a1")],
      [daily("campaign", "c1", "c1"), daily("adset", "a1", "c1")],
      [owner("campaign", "c1", "campaign"), owner("adset", "a1", "not_applicable")],
    );
    const groups = buildEventGroups(members);
    expect(groups[0]!.groupingProof).toBe("proved_owner_mirror_single_child");
    expect(groups[0]!.representativeMemberKey).toContain("campaign");
    expect(groups[0]!.upperBoundActions).toBe(1);
    expect(groups[0]!.groupingProofDetail).toContain("budget_origin=campaign");
  });

  it("refuses the mirror when owner evidence is missing", () => {
    // Non-vacuity for the case above: same shape, no owner rows.
    const groups = buildEventGroups(
      buildEventMembers(
        [tx("campaign", "c1"), tx("adset", "a1")],
        [daily("campaign", "c1", "c1"), daily("adset", "a1", "c1")],
        [],
      ),
    );
    expect(groups[0]!.groupingProof).toBe("ambiguous_multi_member");
    expect(groups[0]!.groupingProofDetail).toContain("knowable on both clocks");
  });

  it("refuses the mirror when the child is not the campaign's own", () => {
    // Parent lineage now comes from the OWNER row knowable at the event, so the
    // divergence must be expressed there. A parent asserted only by a later
    // daily row is exactly what may no longer be trusted.
    const foreignParent: OwnerStateRow = { ...owner("adset", "a1", "not_applicable"), campaignId: "OTHER" };
    const groups = buildEventGroups(
      buildEventMembers(
        [tx("campaign", "c1"), tx("adset", "a1")],
        [daily("campaign", "c1", "c1"), daily("adset", "a1", "c1")],
        [owner("campaign", "c1", "campaign"), foreignParent],
      ),
    );
    expect(groups[0]!.groupingProof).toBe("ambiguous_multi_member");
    expect(groups[0]!.groupingProofDetail).toContain("is not in this group");
  });

  it("refuses the mirror when owner evidence post-dates the event", () => {
    const late = { ...owner("campaign", "c1", "campaign"), observedOn: "2026-07-01" };
    const groups = buildEventGroups(
      buildEventMembers(
        [tx("campaign", "c1"), tx("adset", "a1")],
        [daily("campaign", "c1", "c1"), daily("adset", "a1", "c1")],
        [late, owner("adset", "a1", "not_applicable")],
      ),
    );
    expect(groups[0]!.groupingProof).toBe("ambiguous_multi_member");
  });

  it("never represents a group by an alphabetical grain", () => {
    const groups = buildEventGroups(
      buildEventMembers(
        [tx("campaign", "c1"), tx("adset", "a1"), tx("adset", "a2")],
        [daily("campaign", "c1", "c1"), daily("adset", "a1", "c1"), daily("adset", "a2", "c1")],
        [owner("campaign", "c1", "campaign"), owner("adset", "a1", "not_applicable"), owner("adset", "a2", "not_applicable")],
      ),
    );
    // Two moving children: the campaign cannot stand for a single action.
    expect(groups[0]!.groupingProof).toBe("ambiguous_multi_member");
    expect(groups[0]!.representativeMemberKey).toBeNull();
    expect(groups[0]!.members.map((m) => m.grain)).toContain("adset");
    expect(groups[0]!.members.map((m) => m.grain)).toContain("campaign");
  });

  it("keeps every member's identity, parent and exact source row", () => {
    const members = buildEventMembers(
      [tx("adset", "a1")],
      [daily("adset", "a1", "c1")],
      [owner("adset", "a1", "not_applicable")],
    );
    const m = members[0]!;
    expect(m.grain).toBe("adset");
    expect(m.entityId).toBe("a1");
    expect(m.parentCampaignId).toBe("c1");
    expect(m.sourceRowKey).toContain("2026-05-30");
    expect(m.sourceEntityKey).toBe("act_1|adset|a1");
    expect(m.budgetOriginAtEvent).toBe("not_applicable");
  });

  it("refuses a parent when the retained lineage disagrees with itself", () => {
    const members = buildEventMembers(
      [tx("adset", "a1")],
      [daily("adset", "a1", "c1"), { ...daily("adset", "a1", "c2"), date: "2026-06-02" }],
      [],
    );
    expect(members[0]!.parentCampaignId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rejection 5 — PIT budget on both clocks
// ---------------------------------------------------------------------------

describe("owner and parent lineage are selected bitemporally", () => {
  const owner = (
    observedOn: string, capturedAt: string | null,
    budgetOrigin: string | null = "campaign", campaignId: string | null = "c1",
  ): OwnerStateRow => ({
    businessId: IWA, providerAccountId: "act_1", entityType: "campaign", entityId: "c1",
    campaignId, observedOn, capturedAt, budgetOrigin, budgetCurrency: "USD",
  });

  it("refuses a historically observed row that was captured after the event", () => {
    // The exact r3 defect: both its proofs rested on child rows observed
    // 2026-06-02 but captured 2026-08-22, after the events they justified.
    const selection = selectOwnerStateAsOf([owner("2026-06-02", "2026-08-22 14:19:35.141+00")], "2026-07-28");
    expect(selection.status).toBe("no_knowable_row");
    expect(selection.budgetOrigin).toBeNull();
    expect(selection.campaignId).toBeNull();
    expect(selection.excludedByCaptureClock).toBe(1);
  });

  it("accepts the same row once its capture precedes the origin", () => {
    // Non-vacuity: the refusal above is the capture clock, not the shape.
    const selection = selectOwnerStateAsOf([owner("2026-06-02", "2026-07-25 17:41:31.801+00")], "2026-07-28");
    expect(selection.status).toBe("resolved");
    expect(selection.budgetOrigin).toBe("campaign");
    expect(selection.campaignId).toBe("c1");
    // The knowable instant is max(observed, captured), not observed alone.
    expect(selection.knowableFrom).toBe(new Date(Date.parse("2026-07-25T17:41:31.801Z")).toISOString());
  });

  it("treats a same-day capture as unordered against a day-precision event", () => {
    const selection = selectOwnerStateAsOf([owner("2026-06-02", "2026-07-28 09:00:00+00")], "2026-07-28");
    expect(selection.status).toBe("same_day_capture_ambiguous");
    expect(selection.excludedBySameDayCapture).toBe(1);
    expect(selection.budgetOrigin).toBeNull();
  });

  it("refuses when two knowable rows of the same day disagree", () => {
    const selection = selectOwnerStateAsOf(
      [owner("2026-06-02", "2026-07-01 00:00:00+00", "campaign"), owner("2026-06-02", "2026-07-02 00:00:00+00", "adset")],
      "2026-07-28",
    );
    expect(selection.status).toBe("conflicting_knowable_rows");
    expect(selection.budgetOrigin).toBeNull();
  });

  it("takes the newest knowable day, not the newest observed day", () => {
    const selection = selectOwnerStateAsOf(
      [
        owner("2026-06-02", "2026-06-03 00:00:00+00", "campaign"),
        // Newer observation, but only recorded after the origin.
        owner("2026-07-20", "2026-08-22 00:00:00+00", "adset"),
      ],
      "2026-07-28",
    );
    expect(selection.status).toBe("resolved");
    expect(selection.budgetOrigin).toBe("campaign");
    expect(selection.observedOn).toBe("2026-06-02");
  });

  it("never takes parent lineage from the future daily horizon", () => {
    // r3 built `parentOf` from every retained daily row, and the daily slice
    // carries no recorded clock at all.
    const tx = {
      sourceRowKey: "k", sourceEntityKey: "e", businessId: IWA, providerAccountId: "act_1",
      grain: "campaign", entityId: "c1", prevEffectiveFrom: "2026-07-01",
      effectiveFrom: "2026-07-28", direction: "decrease", percent: -25, semantics: "resolved",
    };
    const futureDaily: DailyRow[] = [{
      businessId: IWA, providerAccountId: "act_1", grain: "campaign", entityId: "c1",
      parentCampaignId: "PARENT_FROM_THE_FUTURE", date: "2026-08-20", status: "ACTIVE",
      accountCurrency: "USD", dailyBudgetRaw: 1, lifetimeBudgetRaw: null, isBudgetMixed: false,
      spend: 1, conversions: 0, revenue: 0, truthState: "finalized",
    }];
    const withoutOwner = buildEventMembers([tx], futureDaily, [])[0]!;
    expect(withoutOwner.parentCampaignId).toBeNull();
    expect(withoutOwner.parentLineageSource).toBe("not_determinable");
    expect(withoutOwner.parentLineageWhy).toContain("no recorded clock");
    // With a knowable owner row the parent comes from THAT row.
    const withOwner = buildEventMembers([tx], futureDaily, [owner("2026-06-02", "2026-07-25 00:00:00+00", "campaign", "PARENT_AT_EVENT")])[0]!;
    expect(withOwner.parentCampaignId).toBe("PARENT_AT_EVENT");
    expect(withOwner.parentLineageSource).toBe("owner_state_at_event");
  });
});

describe("the point-in-time budget refuses an unresolved collapsed day", () => {
  const cfg = (
    effectiveFrom: string, capturedAt: string | null, dailyBudgetRaw: number | null,
    distinctFingerprints = 1, rawCaptures = 1,
  ): ConfigStateRow => ({
    businessId: IWA, providerAccountId: "act_1", grain: "adset", entityId: "a1",
    effectiveFrom, capturedAt, configFingerprint: "f", dailyBudgetRaw,
    lifetimeBudgetRaw: null, anyMixed: false, rawCaptures, distinctFingerprints,
    lane: "strict_pit_authority", knowledgeTo: null,
  });
  const origin = Date.parse("2026-07-01T00:00:00.000Z");

  it("uses a predecessor knowable on both clocks", () => {
    const got = budgetAsOfPit([cfg("2026-06-01", "2026-06-01 00:00:00+00", 500)], origin);
    expect(got.status).toBe("resolved_unique_terminal");
    expect(got.budget).toBe(500);
  });

  it("SKIPS a sole capture that arrived after the origin instead of calling it collapsed", () => {
    // r4 labelled this a collapsed-day ambiguity; 1,305 of its 2,647 such
    // verdicts were this case. With raw_captures = 1 nothing was dropped, so
    // the day simply supplied no knowledge and must be walked past.
    const got = budgetAsOfPit([cfg("2026-06-01", "2026-08-01 00:00:00+00", 500, 1, 1)], origin);
    expect(got.status).toBe("not_determinable_no_predecessor_in_retention");
    expect(got.status).not.toBe("not_determinable_collapsed_skyline");
    expect(got.skipped).toHaveLength(1);
    expect(got.skipped[0]!.why).toContain("supplied no knowledge");
  });

  it("uses the older knowable predecessor once the newer day is skipped", () => {
    const got = budgetAsOfPit(
      [
        cfg("2026-05-01", "2026-05-01 00:00:00+00", 100),
        cfg("2026-06-01", "2026-08-01 00:00:00+00", 900, 1, 1),
      ],
      origin,
    );
    expect(got.status).toBe("resolved_unique_terminal");
    expect(got.budget).toBe(100);
    expect(got.skipped).toHaveLength(1);
    expect(got.why).toContain("skipped as not yet known");
  });

  it("refuses a MULTI-capture later terminal, because earlier captures were dropped", () => {
    const got = budgetAsOfPit(
      [
        cfg("2026-05-01", "2026-05-01 00:00:00+00", 100),
        cfg("2026-06-01", "2026-08-01 00:00:00+00", 900, 2, 5),
      ],
      origin,
    );
    expect(got.status).toBe("not_determinable_collapsed_skyline");
    expect(got.budget).toBeNull();
    // The tempting old-budget fallback is exactly what must NOT happen here.
    expect(got.budget).not.toBe(100);
  });

  it("treats a null or invalid clock as unknown, never as a safe fallback", () => {
    const got = budgetAsOfPit(
      [cfg("2026-05-01", "2026-05-01 00:00:00+00", 100), cfg("2026-06-01", null, 900, 1, 1)],
      origin,
    );
    expect(got.status).toBe("not_determinable_unknown_clock");
    expect(got.budget).toBeNull();
  });

  it("still resolves a multi-fingerprint day whose latest capture is knowable", () => {
    // A collapsed day is usable when the retained row — which IS that day's
    // latest capture — was itself recorded before the origin: every capture of
    // the day then precedes the origin, so the retained state is terminal.
    const got = budgetAsOfPit([cfg("2026-06-01", "2026-06-02 00:00:00+00", 900, 3, 7)], origin);
    expect(got.status).toBe("resolved_unique_terminal");
    expect(got.budget).toBe(900);
    expect(got.collapsedDay).toBe(true);
    expect(got.why).toContain("unique terminal");
  });

  it("refuses when the retained floor may hide a predecessor", () => {
    const got = budgetAsOfPit([cfg("2026-07-15", "2026-07-15 00:00:00+00", 500)], origin);
    expect(got.status).toBe("not_determinable_no_predecessor_in_retention");
  });

  it("never leaks a change effective after the origin", () => {
    const got = budgetAsOfPit(
      [cfg("2026-06-01", "2026-06-01 00:00:00+00", 900), cfg("2026-07-20", "2026-07-20 00:00:00+00", 1)],
      origin,
    );
    expect(got.budget).toBe(900);
  });

  it("reports a missing daily budget under its own status", () => {
    const got = budgetAsOfPit([cfg("2026-06-01", "2026-06-01 00:00:00+00", null)], origin);
    expect(got.status).toBe("not_determinable_no_daily_budget");
  });
});

describe("safety controls evaluate coupled possible action worlds", () => {
  const group = (
    key: string, day: string, direction: string,
    members: Array<{ member: string; entity: string }>,
    account = "act_1", exact = members.length === 1,
  ): GroupInput => ({
    key, businessId: IWA, business: "IwaStore", providerAccountId: account,
    effectiveFrom: day, direction, percent: 20,
    memberKeys: members.map((m) => m.member),
    memberEntityKeys: members.map((m) => m.entity),
    exact,
  });

  it("enumerates every set partition of a 2- and a 3-member group", () => {
    expect(setPartitions(["a", "b"])).toHaveLength(2);
    // Bell(3) = 5.
    expect(setPartitions(["a", "b", "c"])).toHaveLength(5);
    const two = buildWorldSpace([group("g", "2026-06-01", "increase", [
      { member: "m1", entity: "e1" }, { member: "m2", entity: "e2" },
    ])]);
    expect(two.worldCount).toBe(2);
    expect(two.actionLowerBound).toBe(1);
    expect(two.actionUpperBound).toBe(2);
    const three = buildWorldSpace([group("g", "2026-06-01", "increase", [
      { member: "m1", entity: "e1" }, { member: "m2", entity: "e2" }, { member: "m3", entity: "e3" },
    ])]);
    expect(three.worldCount).toBe(5);
    expect(three.actionUpperBound).toBe(3);
  });

  it("derives the world count from the groups rather than assuming it", () => {
    // Seven 2-member groups and one 3-member group is 2^7 x 5.
    const groups = [
      ...Array.from({ length: 7 }, (_, i) =>
        group(`g${i}`, "2026-06-01", "increase", [
          { member: `a${i}`, entity: `e${i}` }, { member: `b${i}`, entity: `f${i}` },
        ])),
      group("g7", "2026-06-02", "decrease", [
        { member: "x", entity: "ex" }, { member: "y", entity: "ey" }, { member: "z", entity: "ez" },
      ]),
    ];
    const space = buildWorldSpace(groups);
    expect(space.worldCount).toBe(2 ** 7 * 5);
    expect(space.actionLowerBound).toBe(8);
    expect(space.actionUpperBound).toBe(17);
  });

  it("gives every action an identity from its sorted member keys, not an ordinal", () => {
    const space = buildWorldSpace([group("g", "2026-06-01", "increase", [
      { member: "zz", entity: "e1" }, { member: "aa", entity: "e1" },
    ])]);
    const merged = space.worlds.flatMap((w) => w.actions).find((a) => a.memberKeys.length === 2)!;
    expect(merged.actionKey).toBe("g::aa+zz");
    expect(merged.memberKeys).toEqual(["aa", "zz"]);
  });

  it("REGRESSION: never publishes a negative cleared count", () => {
    // r4 published cap=1/entity with cleared=[-6,23] because it computed
    // `evaluatedLower - blockedUpper` across worlds that cannot coexist.
    const groups = [
      ...Array.from({ length: 7 }, (_, i) =>
        group(`g${i}`, "2026-06-01", "increase", [
          { member: `a${i}`, entity: `e${i}` }, { member: `b${i}`, entity: `e${i}` },
        ])),
      group("g7", "2026-06-02", "decrease", [
        { member: "x", entity: "ex" }, { member: "y", entity: "ex" }, { member: "z", entity: "ex" },
      ]),
    ];
    const space = buildWorldSpace(groups);
    for (const cell of [...buildCapGrid(space), ...buildCooldownGrid(space), ...buildLookbackGrid(space), ...buildConcentrationGrid(space)]) {
      for (const v of [cell.outcome.blockedLower, cell.outcome.blockedUpper, cell.outcome.clearedLower, cell.outcome.clearedUpper, cell.outcome.evaluatedLower, cell.outcome.evaluatedUpper]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(cell.outcome.blockedUpper).toBeLessThanOrEqual(cell.outcome.evaluatedUpper);
      expect(cell.outcome.clearedUpper).toBeLessThanOrEqual(cell.outcome.evaluatedUpper);
    }
  });

  it("keeps blocked + cleared = evaluated inside EVERY world", () => {
    const space = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }, { member: "b", entity: "e1" }]),
      group("g1", "2026-06-01", "decrease", [{ member: "c", entity: "e2" }]),
    ]);
    for (const world of space.worlds) {
      for (const scope of ["entity", "account", "business", "fleet"] as const) {
        for (const control of [
          cooldownInWorld(world, scope, 7),
          capInWorld(world, scope, 1),
          lookbackInWorld(world, scope, 14),
        ]) {
          expect(control.blockedLower).toBeLessThanOrEqual(control.blockedUpper);
          expect(control.blockedUpper).toBeLessThanOrEqual(control.evaluated);
          expect(control.evaluated - control.blockedUpper).toBeGreaterThanOrEqual(0);
          // Counts are order extrema; identities are an intersection and a
          // union. They must never be derived from one another.
          expect(control.blockedIdentitiesGuaranteed.every((k) => control.blockedIdentitiesPossible.includes(k))).toBe(true);
        }
      }
    }
  });

  it("publishes an ACTION denominator, never a group census", () => {
    const space = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }, { member: "b", entity: "e1" }]),
    ]);
    for (const cell of [...buildCooldownGrid(space), ...buildCapGrid(space), ...buildLookbackGrid(space), ...buildConcentrationGrid(space)]) {
      expect(cell.outcome.denominatorUnit).toBe("possible_economic_actions");
      expect(cell.outcome.identityUnit).toBe("possible_economic_action_key");
      // Group diagnostics travel beside, never as the denominator.
      expect(cell.outcome.groupCount).toBe(1);
      // r4 published 14-14 for cooldown/concentration/lookback.
      expect(cell.outcome.evaluatedLower).not.toBe(cell.outcome.evaluatedUpper);
    }
  });

  it("evaluates additional within-group actions against one another", () => {
    // Two members of ONE group can violate an account cooldown against each
    // other once they are two distinct actions. r4 never evaluated that.
    const space = buildWorldSpace([
      group("g", "2026-06-01", "increase", [{ member: "a", entity: "e1" }, { member: "b", entity: "e2" }]),
    ]);
    const cell = buildCooldownGrid(space).find((c) => c.cooldownDays === 7 && c.scope === "account")!;
    // In the split world both actions share a day at account scope, so one of
    // them could be blocked; in the merged world there is only one action.
    expect(cell.outcome.blockedUpper).toBeGreaterThan(0);
    expect(cell.outcome.blockedLower).toBe(0);
    expect(cell.outcome.semantics).toBe("bounded");
  });

  it("excludes an action whose entity target is indeterminate instead of double counting", () => {
    const space = buildWorldSpace([
      group("g", "2026-06-01", "increase", [{ member: "a", entity: "e1" }, { member: "b", entity: "e2" }]),
    ]);
    // The merged block spans two entities, so entity scope cannot place it.
    expect(space.indeterminateEntityActionKeys).toHaveLength(1);
    const entityCell = buildCapGrid(space).find((c) => c.cap === 1 && c.scope === "entity")!;
    expect(entityCell.outcome.excludedActionsUpper).toBeGreaterThan(0);
    // Account scope can place it, so nothing is excluded there.
    const accountCell = buildCapGrid(space).find((c) => c.cap === 1 && c.scope === "account")!;
    expect(accountCell.outcome.excludedActionsUpper).toBe(0);
  });

  it("never names a guaranteed cap identity, because no action time is retained", () => {
    const space = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-01", "increase", [{ member: "b", entity: "e2" }], "act_1", true),
      group("g2", "2026-06-01", "increase", [{ member: "c", entity: "e3" }], "act_1", true),
    ]);
    const cell = buildCapGrid(space).find((c) => c.cap === 1 && c.scope === "account")!;
    // Three actions, cap one: exactly two refused in every order.
    expect(cell.outcome.blockedLower).toBe(2);
    expect(cell.outcome.blockedUpper).toBe(2);
    expect(cell.outcome.semantics).toBe("exact");
    expect(cell.outcome.guaranteedBlockedKeys).toEqual([]);
    expect(cell.outcome.identitySemantics).toBe("possible_only");
  });

  it("treats same-day peers as unordered, never symmetric priors", () => {
    const sameDay = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-01", "increase", [{ member: "b", entity: "e2" }], "act_1", true),
    ]);
    const cell = buildCooldownGrid(sameDay).find((c) => c.cooldownDays === 7 && c.scope === "account")!;
    expect(cell.outcome.guaranteedBlockedKeys).toEqual([]);
    expect(cell.outcome.blockedUpper).toBe(1);
    const earlier = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-03", "increase", [{ member: "b", entity: "e2" }], "act_1", true),
    ]);
    const exact = buildCooldownGrid(earlier).find((c) => c.cooldownDays === 7 && c.scope === "account")!;
    expect(exact.outcome.guaranteedBlockedKeys).toHaveLength(1);
    expect(exact.outcome.identitySemantics).toBe("exact");
  });

  it("keys concentration degeneracy to acting ACCOUNTS, not group counts", () => {
    // One account, one ambiguous group: r4 called this non-degenerate because
    // the day had one GROUP; the share is 1 whatever the multiplicity.
    const oneAccount = buildWorldSpace([
      group("g", "2026-06-01", "increase", [{ member: "a", entity: "e1" }, { member: "b", entity: "e2" }]),
    ]);
    const cell = buildConcentrationGrid(oneAccount).find((c) => c.maxAccountShareOfFleet === 0.25)!;
    expect(cell.degenerateFleetDaysLower).toBe(1);
    expect(cell.degenerateFleetDaysUpper).toBe(1);
    expect(cell.shareInvariantAcrossWorlds).toBe(true);
    expect(cell.degeneracyWhy).toContain("ONE acting account");

    // Two acting accounts: no longer degenerate.
    const twoAccounts = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-01", "increase", [{ member: "b", entity: "e2" }], "act_2", true),
    ]);
    const cell2 = buildConcentrationGrid(twoAccounts).find((c) => c.maxAccountShareOfFleet === 0.25)!;
    expect(cell2.degenerateFleetDaysUpper).toBe(0);
  });

  it("mixes entity, account and business scopes without conflating them", () => {
    const space = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-01", "increase", [{ member: "b", entity: "e1" }], "act_2", true),
    ]);
    const at = (scope: string) => buildCapGrid(space).find((c) => c.cap === 1 && c.scope === scope)!;
    // Same entity key, different accounts: entity scope sees two, account one each.
    expect(at("entity").outcome.blockedUpper).toBeGreaterThan(0);
    expect(at("account").outcome.blockedUpper).toBe(0);
    expect(at("business").outcome.blockedUpper).toBeGreaterThan(0);
  });

  it("counts a same-day opposite-direction reversal EXACTLY once, and names neither", () => {
    const space = buildWorldSpace([
      group("g0", "2026-06-01", "increase", [{ member: "a", entity: "e1" }], "act_1", true),
      group("g1", "2026-06-01", "decrease", [{ member: "b", entity: "e2" }], "act_1", true),
    ]);
    const cell = buildLookbackGrid(space).find((c) => c.lookbackDays === 7 && c.scope === "account")!;
    // r5 published blocked=[0,2] here by counting the identity sets. No total
    // order can block both: the first action has no prior, and the second is
    // the only reversal. The COUNT is settled; the IDENTITY is not.
    expect(cell.outcome.blockedLower).toBe(1);
    expect(cell.outcome.blockedUpper).toBe(1);
    expect(cell.outcome.semantics).toBe("exact");
    expect(cell.outcome.guaranteedBlockedKeys).toEqual([]);
    expect(cell.outcome.possiblyBlockedKeys).toHaveLength(2);
    expect(cell.outcome.identitySemantics).toBe("possible_only");
  });
});

// ---------------------------------------------------------------------------
// Correction 5 / A — same-day ORDER mathematics, proved against brute force
// ---------------------------------------------------------------------------

/**
 * A whole-set total-order brute force.
 *
 * This exists so a closed form cannot test itself. It enumerates EVERY total
 * order of the whole action set that respects day order — not per bucket — and
 * evaluates each control straight from its definition. It therefore also
 * proves the bucket factorisation that both production and the independent
 * oracle rely on: if the buckets did not decompose, these numbers would differ.
 */
type BruteAction = { actionKey: string; day: string; scopeKey: string; direction: string };

function permute<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items];
    const [head] = rest.splice(i, 1);
    for (const tail of permute(rest)) out.push([head as T, ...tail]);
  }
  return out;
}

function totalOrders(actions: readonly BruteAction[]): BruteAction[][] {
  const days = Array.from(new Set(actions.map((a) => a.day))).sort();
  let out: BruteAction[][] = [[]];
  for (const d of days) {
    const sameDay = actions.filter((a) => a.day === d);
    const next: BruteAction[][] = [];
    for (const prefix of out) for (const p of permute(sameDay)) next.push([...prefix, ...p]);
    out = next;
  }
  return out;
}

const bruteDayGap = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);

function bruteForce(
  actions: readonly BruteAction[],
  control: "cooldown" | "lookback" | "repeat" | "cap",
  param: number,
): { lower: number; upper: number; guaranteed: string[]; possible: string[] } {
  let lower = Number.POSITIVE_INFINITY;
  let upper = Number.NEGATIVE_INFINITY;
  let intersection: string[] | null = null;
  const union: string[] = [];
  for (const order of totalOrders(actions)) {
    const blocked: string[] = [];
    const seen = new Map<string, number>();
    order.forEach((subject, i) => {
      const before = order.slice(0, i).filter((p) => p.scopeKey === subject.scopeKey);
      let hit = false;
      if (control === "cap") {
        const bucket = `${subject.scopeKey}|${subject.day}`;
        const idx = (seen.get(bucket) ?? 0) + 1;
        seen.set(bucket, idx);
        hit = idx > param;
      } else {
        hit = before.some((p) => {
          const gap = bruteDayGap(p.day, subject.day);
          if (control === "cooldown") return gap >= 0 && gap < param;
          if (gap < 0 || gap > param) return false;
          return control === "lookback"
            ? p.direction !== subject.direction
            : p.direction === subject.direction;
        });
      }
      if (hit) blocked.push(subject.actionKey);
    });
    lower = Math.min(lower, blocked.length);
    upper = Math.max(upper, blocked.length);
    intersection = intersection === null ? [...blocked] : intersection.filter((k) => blocked.includes(k));
    for (const k of blocked) if (!union.includes(k)) union.push(k);
  }
  return {
    lower: actions.length === 0 ? 0 : lower,
    upper: actions.length === 0 ? 0 : upper,
    guaranteed: (intersection ?? []).sort(),
    possible: union.sort(),
  };
}

describe("Correction 5 / A — order extrema are counts, not identity cardinalities", () => {
  const g = (
    key: string, day: string, direction: string, account = "act_1", entity = `e_${key}`,
  ): GroupInput => ({
    key, businessId: IWA, business: "IwaStore", providerAccountId: account,
    effectiveFrom: day, direction, percent: 20,
    memberKeys: [key], memberEntityKeys: [entity], exact: true,
  });
  const oneWorld = (groups: GroupInput[]) => buildWorldSpace(groups).worlds[0]!;
  const asBrute = (groups: GroupInput[], scope: WorldScope): BruteAction[] =>
    oneWorld(groups).actions
      .map((a) => ({
        actionKey: a.actionKey, day: a.day, direction: a.direction,
        scopeKey: scopeKeyOf(a, scope) ?? "__none__",
      }))
      .filter((a) => a.scopeKey !== "__none__");

  it("blocks EXACTLY one of two same-day opposite-direction actions", () => {
    const groups = [g("inc", "2026-06-01", "increase"), g("dec", "2026-06-01", "decrease")];
    const out = lookbackInWorld(oneWorld(groups), "account", 7);
    // r5 published {evaluated:2, blockedGuaranteed:0, blockedMax:2}.
    expect(out.blockedLower).toBe(1);
    expect(out.blockedUpper).toBe(1);
    expect(out.blockedIdentitiesGuaranteed).toHaveLength(0);
    expect(out.blockedIdentitiesPossible).toHaveLength(2);
    const brute = bruteForce(asBrute(groups, "account"), "lookback", 7);
    expect({ lower: out.blockedLower, upper: out.blockedUpper }).toEqual({ lower: brute.lower, upper: brute.upper });
    expect(out.blockedIdentitiesGuaranteed).toEqual(brute.guaranteed);
    expect(out.blockedIdentitiesPossible).toEqual(brute.possible);
  });

  it("bounds three same-day actions (2 increase, 1 decrease) at [1, 2]", () => {
    const groups = [
      g("i1", "2026-06-01", "increase"), g("i2", "2026-06-01", "increase"),
      g("d1", "2026-06-01", "decrease"),
    ];
    const out = lookbackInWorld(oneWorld(groups), "account", 7);
    expect(out.blockedLower).toBe(1);
    expect(out.blockedUpper).toBe(2);
    const brute = bruteForce(asBrute(groups, "account"), "lookback", 7);
    expect([out.blockedLower, out.blockedUpper]).toEqual([brute.lower, brute.upper]);
    expect(out.blockedIdentitiesGuaranteed).toEqual(brute.guaranteed);
    expect(out.blockedIdentitiesPossible).toEqual(brute.possible);
  });

  it("counts exactly k-1 same-direction repeats for k same-day actions", () => {
    for (const k of [2, 3, 4]) {
      const groups = Array.from({ length: k }, (_, i) => g(`s${i}`, "2026-06-01", "increase"));
      const out = lookbackInWorld(oneWorld(groups), "account", 7);
      // r5 published [0, k] by counting identity presence.
      expect({ k, lower: out.repeatsLower, upper: out.repeatsUpper })
        .toEqual({ k, lower: k - 1, upper: k - 1 });
      const brute = bruteForce(asBrute(groups, "account"), "repeat", 7);
      expect([out.repeatsLower, out.repeatsUpper]).toEqual([brute.lower, brute.upper]);
      // No identity is guaranteed: any of the k could have gone first.
      expect(out.blockedIdentitiesGuaranteed).toEqual([]);
    }
  });

  it("blocks exactly k-1 of a same-day cooldown cluster, both bounds", () => {
    for (const k of [2, 3, 4]) {
      const groups = Array.from({ length: k }, (_, i) => g(`c${i}`, "2026-06-01", "increase"));
      const out = cooldownInWorld(oneWorld(groups), "account", 7);
      // r5 published [0, k-1]: the LOWER bound ignored that one must be first.
      expect({ k, lower: out.blockedLower, upper: out.blockedUpper })
        .toEqual({ k, lower: k - 1, upper: k - 1 });
      const brute = bruteForce(asBrute(groups, "account"), "cooldown", 7);
      expect([out.blockedLower, out.blockedUpper]).toEqual([brute.lower, brute.upper]);
    }
  });

  it("adds an earlier opposite/same-direction action to a same-day cluster", () => {
    const groups = [
      g("prior", "2026-05-30", "decrease"),
      g("i1", "2026-06-01", "increase"), g("i2", "2026-06-01", "increase"),
    ];
    const lb = lookbackInWorld(oneWorld(groups), "account", 7);
    const bruteLb = bruteForce(asBrute(groups, "account"), "lookback", 7);
    expect([lb.blockedLower, lb.blockedUpper]).toEqual([bruteLb.lower, bruteLb.upper]);
    expect(lb.blockedIdentitiesGuaranteed).toEqual(bruteLb.guaranteed);
    expect(lb.blockedIdentitiesPossible).toEqual(bruteLb.possible);
    const rep = bruteForce(asBrute(groups, "account"), "repeat", 7);
    expect([lb.repeatsLower, lb.repeatsUpper]).toEqual([rep.lower, rep.upper]);
  });

  it("agrees with brute force across every scope, control and parameter", () => {
    const groups: GroupInput[] = [
      g("a", "2026-06-01", "increase", "act_1", "e1"),
      g("b", "2026-06-01", "decrease", "act_1", "e1"),
      g("c", "2026-06-01", "increase", "act_2", "e2"),
      g("d", "2026-06-04", "decrease", "act_1", "e1"),
    ];
    let compared = 0;
    for (const scope of ["entity", "account", "business", "fleet"] as const) {
      const acts = asBrute(groups, scope);
      for (const w of [1, 3, 7, 14]) {
        const cd = cooldownInWorld(oneWorld(groups), scope, w);
        const b = bruteForce(acts, "cooldown", w);
        expect({ scope, w, lo: cd.blockedLower, hi: cd.blockedUpper })
          .toEqual({ scope, w, lo: b.lower, hi: b.upper });
        expect(cd.blockedIdentitiesGuaranteed).toEqual(b.guaranteed);
        expect(cd.blockedIdentitiesPossible).toEqual(b.possible);
        compared += 1;
      }
      for (const w of [7, 14, 28]) {
        const lb = lookbackInWorld(oneWorld(groups), scope, w);
        const b = bruteForce(acts, "lookback", w);
        expect({ scope, w, lo: lb.blockedLower, hi: lb.blockedUpper })
          .toEqual({ scope, w, lo: b.lower, hi: b.upper });
        expect(lb.blockedIdentitiesGuaranteed).toEqual(b.guaranteed);
        expect(lb.blockedIdentitiesPossible).toEqual(b.possible);
        const r = bruteForce(acts, "repeat", w);
        expect([lb.repeatsLower, lb.repeatsUpper]).toEqual([r.lower, r.upper]);
        compared += 2;
      }
      for (const c of [1, 2, 3]) {
        const cp = capInWorld(oneWorld(groups), scope, c);
        const b = bruteForce(acts, "cap", c);
        expect({ scope, c, lo: cp.blockedLower, hi: cp.blockedUpper })
          .toEqual({ scope, c, lo: b.lower, hi: b.upper });
        expect(cp.blockedIdentitiesGuaranteed).toEqual(b.guaranteed);
        expect(cp.blockedIdentitiesPossible).toEqual(b.possible);
        compared += 1;
      }
    }
    // Non-vacuity: the sweep must actually have compared something.
    expect(compared).toBe(4 * (4 + 3 * 2 + 3));
  });

  it("keeps an indeterminate-entity block out of entity scope while ordering the rest", () => {
    const merged: GroupInput = {
      key: "m", businessId: IWA, business: "IwaStore", providerAccountId: "act_1",
      effectiveFrom: "2026-06-01", direction: "increase", percent: 20,
      memberKeys: ["m1", "m2"], memberEntityKeys: ["e1", "e2"], exact: false,
    };
    const space = buildWorldSpace([merged, g("x", "2026-06-01", "decrease", "act_1", "e1")]);
    for (const world of space.worlds) {
      const entity = lookbackInWorld(world, "entity", 7);
      const acts = world.actions
        .map((a) => ({
          actionKey: a.actionKey, day: a.day, direction: a.direction,
          scopeKey: scopeKeyOf(a, "entity") ?? "__none__",
        }))
        .filter((a) => a.scopeKey !== "__none__");
      const b = bruteForce(acts, "lookback", 7);
      expect([entity.blockedLower, entity.blockedUpper]).toEqual([b.lower, b.upper]);
      // The merged two-entity block cannot be placed, so it is excluded once,
      // never added to both entity buckets.
      expect(entity.evaluated + entity.excluded).toBe(world.actions.length);
    }
  });

  it("declares an order space distinct from the partition-world space", () => {
    const space = buildWorldSpace([
      g("a", "2026-06-01", "increase"), g("b", "2026-06-01", "decrease"),
    ]);
    const out = lookbackInWorld(space.worlds[0]!, "account", 7);
    expect(out.orderSpaceSize).toBe(2);
    expect(space.worldCount).toBe(1);
    const bucket = out.orderBuckets[0]!;
    expect(bucket.actionCount).toBe(2);
    expect(bucket.distinctDirections).toBe(2);
    expect(bucket.admissibleOrders).toBe(2);
    expect(bucket.blockedLower + bucket.determinedBlocked).toBeGreaterThanOrEqual(1);
    expect(D084_ORDER_SEMANTICS).toContain("factorise");
  });
});

// ---------------------------------------------------------------------------
// Correction 5 / B — the verifier is independent, and rejects every class
// ---------------------------------------------------------------------------

describe("Correction 5 / B — the independent oracle", () => {
  const g = (
    key: string, day: string, direction: string, account = "act_1", entity = `e_${key}`,
  ): GroupInput => ({
    key, businessId: IWA, business: "IwaStore", providerAccountId: account,
    effectiveFrom: day, direction, percent: 20,
    memberKeys: [key], memberEntityKeys: [entity], exact: true,
  });

  const AMBIGUOUS: GroupInput[] = [
    {
      key: "amb", businessId: IWA, business: "IwaStore", providerAccountId: "act_1",
      effectiveFrom: "2026-06-01", direction: "increase", percent: 20,
      memberKeys: ["m1", "m2", "m3"], memberEntityKeys: ["e1", "e1", "e2"], exact: false,
    },
    g("b", "2026-06-01", "decrease"),
    g("c", "2026-06-05", "increase"),
  ];

  it("derives the SAME partition space by a different algorithm", () => {
    const production = buildWorldSpace(AMBIGUOUS);
    const oracle = oracleSpace(AMBIGUOUS);
    // Restricted-growth strings vs recursive insertion: same set, same digest.
    expect(oracle.worldCount).toBe(production.worldCount);
    expect(oracle.digest).toBe(production.digest);
    expect(oracle.actionLowerBound).toBe(production.actionLowerBound);
    expect(oracle.actionUpperBound).toBe(production.actionUpperBound);
    expect(oracle.indeterminateEntityActionKeys).toEqual(production.indeterminateEntityActionKeys);
    expect(oracle.worldCount).toBe(5);
  });

  it("reproduces every production cell by exhaustive order enumeration", () => {
    const production = buildWorldSpace(AMBIGUOUS);
    const oracle = oracleSpace(AMBIGUOUS);
    let cells = 0;
    for (const scope of ["entity", "account", "business", "fleet"] as const) {
      for (const w of [1, 7, 28]) {
        const cd = buildCooldownGrid(production).find((c) => c.cooldownDays === w && c.scope === scope);
        if (cd) {
          const o = oracleCell(oracle, scope, "cooldown", w);
          expect({ scope, w, ...pickBounds(cd.outcome) }).toEqual({ scope, w, ...pickBounds(o) });
          expect(cd.outcome.guaranteedBlockedKeys).toEqual(o.guaranteedBlockedKeys);
          expect(cd.outcome.possiblyBlockedKeys).toEqual(o.possiblyBlockedKeys);
          cells += 1;
        }
      }
      for (const c of [1, 2, 3, 5]) {
        const cell = buildCapGrid(production).find((x) => x.cap === c && x.scope === scope)!;
        const o = oracleCell(oracle, scope, "cap", c);
        expect({ scope, c, ...pickBounds(cell.outcome) }).toEqual({ scope, c, ...pickBounds(o) });
        cells += 1;
      }
      for (const w of [7, 14, 28, 56]) {
        const cell = buildLookbackGrid(production).find((x) => x.lookbackDays === w && x.scope === scope)!;
        const o = oracleCell(oracle, scope, "lookback", w);
        expect({ scope, w, ...pickBounds(cell.outcome) }).toEqual({ scope, w, ...pickBounds(o) });
        const r = oracleRepeatBounds(oracle, scope, w);
        expect([cell.sameDirectionRepeatsLower, cell.sameDirectionRepeatsUpper]).toEqual([r.lower, r.upper]);
        cells += 1;
      }
    }
    expect(cells).toBe(4 * (3 + 4 + 4));
  });

  it("publishes a reproducing witness for EVERY extremum", () => {
    const production = buildWorldSpace(AMBIGUOUS);
    const oracle = oracleSpace(AMBIGUOUS);
    for (const cell of [...buildCooldownGrid(production), ...buildCapGrid(production), ...buildLookbackGrid(production)]) {
      const w = cell.outcome.witnesses;
      for (const [name, witness, value] of [
        ["evaluatedLower", w.evaluatedLower, cell.outcome.evaluatedLower],
        ["evaluatedUpper", w.evaluatedUpper, cell.outcome.evaluatedUpper],
        ["blockedLower", w.blockedLower, cell.outcome.blockedLower],
        ["blockedUpper", w.blockedUpper, cell.outcome.blockedUpper],
        ["clearedLower", w.clearedLower, cell.outcome.clearedLower],
        ["clearedUpper", w.clearedUpper, cell.outcome.clearedUpper],
      ] as const) {
        expect(witness, name).not.toBeNull();
        expect(witness!.value, name).toBe(value);
        expect(oracle.worlds.some((x) => x.worldKey === witness!.worldKey), name).toBe(true);
      }
    }
  });

  it("imports no production decision arithmetic, so it cannot self-verify", () => {
    // THE STRUCTURAL LAW. r5's verifier called `buildWorldSpace`,
    // `foldWorldOutcomes` and the four control evaluators for its expected
    // answers, so a shared algorithm error agreed with itself and passed. The
    // oracle may share TYPES; it may not share arithmetic.
    const raw = readFileSync(resolve("scripts/audits/d084-independent-oracle.ts"), "utf8");
    // Prose is not code: the header explains the r5 defect by NAME, so strip
    // comments before looking for a call.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const imports = src.match(/import[\s\S]*?from\s+"[^"]+";/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    const fromWorlds = imports.filter((i) => i.includes("d084-possible-worlds"));
    expect(fromWorlds).toHaveLength(1);
    // Type-only, enforced by the `import type` form.
    expect(fromWorlds[0]!.startsWith("import type")).toBe(true);
    for (const forbidden of [
      "buildWorldSpace", "foldWorldOutcomes", "setPartitions", "groupPartitions",
      "cooldownInWorld", "capInWorld", "concentrationInWorld", "lookbackInWorld",
    ]) {
      expect(src, `the oracle must not use production's ${forbidden}`).not.toContain(forbidden);
    }
    // And it must genuinely enumerate orders rather than restate a closed form.
    expect(src).toContain("permutations");
    expect(src).toContain("restrictedGrowthStrings");
  });

  it("keeps `exact` identity semantics honest about MEMBERSHIP, not size", () => {
    // Two same-day actions in one account under cap 1: exactly one refused,
    // guaranteed set empty, possible set of two — so identities are not exact.
    const space = buildWorldSpace([g("a", "2026-06-01", "increase"), g("b", "2026-06-01", "increase")]);
    const cell = buildCapGrid(space).find((c) => c.cap === 1 && c.scope === "account")!;
    expect(cell.outcome.identitySemantics).toBe("possible_only");
    expect(cell.outcome.guaranteedBlockedKeys).toEqual([]);
    expect(cell.outcome.possiblyBlockedKeys).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The shipped artifact
// ---------------------------------------------------------------------------

describe("the shipped r3 artifact", () => {
  const artifact = loadArtifact();
  const analysis = artifact.analysis as any;

  it("is DB-free and says so everywhere it matters", () => {
    const snapshot = artifact.snapshot as any;
    expect(artifact.contract).toBe(D084_CONTRACT_ID);
    expect(snapshot.provenance.databaseAccess).toBe("none");
    expect(snapshot.provenance.queriesExecuted).toBe(0);
    expect(analysis.fleet.databaseQueriesExecuted).toBe(0);
    // No live-read residue at all.
    for (const banned of ["queryContractSha256", "statementTimeoutMs", "lockTimeoutMs", "retrievedat", "transactionreadonly"]) {
      expect(snapshot.provenance[banned], banned).toBeUndefined();
    }
  });

  it("covers the whole charter fleet, not only event-bearing entities", () => {
    expect(analysis.retention.businesses).toBe(6);
    expect(analysis.retention.accounts).toBe(7);
    expect(analysis.retention.entities).toBeGreaterThan(2000);
    // r2's grid saw 21 entities across 3 accounts.
    expect(analysis.retention.dailyRows).toBe(165_042);
  });

  it("publishes complete partitions on every grid cell", () => {
    for (const cell of analysis.evidenceGrid.cells) {
      expect(cell.clearsEvidenceFloors + cell.blocked + cell.notDeterminable).toBe(cell.denominator);
      const byBusiness = Object.values(cell.byBusiness) as Array<{ denominator: number }>;
      expect(byBusiness.reduce((s, p) => s + p.denominator, 0)).toBe(cell.denominator);
    }
  });

  it("never calls clearing an evidence floor strict eligibility", () => {
    // Clearing the tuned floors is not authority: the three structural gates
    // are untouched by any floor and block the whole population.
    const clears = analysis.evidenceGrid.cells.reduce((s: number, c: any) => s + c.clearsEvidenceFloors, 0);
    expect(clears).toBeGreaterThan(0);
    for (const cell of analysis.evidenceGrid.cells) {
      expect(cell.strictlyEligible).toBe(0);
      expect(cell.strictlyEligibleWhy).toContain("unit_exponent_unknown");
    }
    expect(analysis.fleet.strictlyEligibleProposals).toBe(0);
  });

  it("marks every cell's coverage honestly against pinned retention", () => {
    // The widest trailing window reaches before the retained floor at the
    // earliest origins, so no cell may claim full support.
    for (const cell of analysis.evidenceGrid.cells) {
      expect(["supported", "partially_supported", "unsupported"]).toContain(cell.coverage);
      if (cell.coverage !== "supported") expect(cell.coverageWhy).toBeTruthy();
    }
  });

  it("keeps strict eligibility at zero and says why", () => {
    const scenario = analysis.scenarios.find((s: any) => s.scenarioId === "3_evidence_floor_grid_three_lanes");
    expect(scenario.result.strictRetainedAuthority.eligibleUnderStructuralGates).toBe(0);
    expect(scenario.result.strictRetainedAuthority.why).toContain("structural gates");
    // Three lanes, never sharing a denominator.
    expect(scenario.result.lanesShareNoDenominator).toBe(true);
    expect(scenario.result.d083CaptureCounterfactual.authoritative).toBe(false);
  });

  it("reports real cooldown, cap, concentration and lookback movement", () => {
    expect(analysis.cooldownGrid.some((c: any) => c.outcome.blockedUpper > 0)).toBe(true);
    expect(analysis.capGrid.some((c: any) => c.outcome.blockedUpper > 0)).toBe(true);
    expect(analysis.lookbackGrid.some((c: any) => c.outcome.possiblyBlockedKeys.length > 0)).toBe(true);
    const intervals = Object.values(analysis.changeSafety.intervalDaysPerAccount).flat() as number[];
    expect(intervals.length).toBeGreaterThan(0);
  });

  it("publishes no impossible value anywhere in the safety families", () => {
    // The r4 regression: cap=1/entity carried cleared=[-6,23].
    for (const cell of [...analysis.cooldownGrid, ...analysis.capGrid, ...analysis.concentrationGrid, ...analysis.lookbackGrid]) {
      for (const [name, v] of Object.entries({
        evaluatedLower: cell.outcome.evaluatedLower, evaluatedUpper: cell.outcome.evaluatedUpper,
        blockedLower: cell.outcome.blockedLower, blockedUpper: cell.outcome.blockedUpper,
        clearedLower: cell.outcome.clearedLower, clearedUpper: cell.outcome.clearedUpper,
      })) {
        expect(Number.isInteger(v), name).toBe(true);
        expect(v as number, name).toBeGreaterThanOrEqual(0);
      }
      expect(cell.outcome.blockedUpper).toBeLessThanOrEqual(cell.outcome.evaluatedUpper);
    }
  });

  it("uses an ACTION denominator in every safety family, never a group census", () => {
    // r4 published an exact 14-14 for cooldown, concentration and lookback.
    for (const cell of [...analysis.cooldownGrid, ...analysis.capGrid, ...analysis.concentrationGrid, ...analysis.lookbackGrid]) {
      expect(cell.outcome.denominatorUnit).toBe("possible_economic_actions");
      expect(cell.outcome.actionLowerBound).toBe(analysis.worldSpace.actionLowerBound);
      expect(cell.outcome.actionUpperBound).toBe(analysis.worldSpace.actionUpperBound);
      expect(cell.outcome.worldDigest).toBe(analysis.worldSpace.digest);
    }
    expect(analysis.changeSafety.denominatorUnit).toBe("possible_economic_actions");
    expect(analysis.changeSafety.groupDiagnostics.unit).toBe("economic_event_groups");
  });

  it("derives the world space rather than assuming its size", () => {
    const w = analysis.worldSpace;
    // 2^7 x 5, derived from seven 2-member and one 3-member ambiguous group.
    const expected = Object.values(w.partitionsPerGroup).reduce((a: number, b: any) => a * b, 1);
    expect(w.worldCount).toBe(expected);
    expect(w.memberRowCount).toBe(23);
    expect(w.actionLowerBound).toBe(14);
    expect(w.actionUpperBound).toBe(23);
  });

  it("keys concentration degeneracy to acting accounts and proves invariance", () => {
    for (const cell of analysis.concentrationGrid) {
      expect(cell.degenerateFleetDaysLower).toBe(cell.degenerateFleetDaysUpper);
      expect(cell.degenerateFleetDaysUpper).toBe(cell.totalFleetDays);
      expect(cell.shareInvariantAcrossWorlds).toBe(true);
    }
  });

  it("splits the point-in-time causes instead of blaming collapsed data", () => {
    const c = analysis.collapsedConfigCoverage;
    const nd = c.evaluationsNotDeterminable;
    expect(c.evaluationsResolved + Object.values(nd).reduce((a: number, b: any) => a + b, 0)).toBe(c.evaluations);
    // r4 called every unresolved evaluation a collapsed day.
    expect(c.collapsedSkylineEvaluations).toBe(nd.not_determinable_collapsed_skyline);
    expect(c.collapsedSkylineEvaluations).toBeLessThan(c.evaluations - c.evaluationsResolved);
    expect(c.skippedNotYetKnownRows).toBeGreaterThan(0);
    for (const map of [c.byBusiness, c.byAccount]) {
      for (const p of Object.values(map) as any[]) {
        expect(p.resolved + p.notDeterminable).toBe(p.evaluations);
        expect(Object.values(p.byReason).reduce((a: number, b: any) => a + b, 0)).toBe(p.notDeterminable);
      }
    }
  });

  it("derives owner-clock coverage instead of embedding it in prose", () => {
    const o = analysis.ownerClockCoverage;
    expect(o.retainedOwnerRows).toBe(462);
    expect(o.capturedAfterObservedDay + o.capturedOnObservedDay + o.capturedBeforeObservedDay + o.nullOrInvalidCapturedAt)
      .toBe(o.retainedOwnerRows);
    expect(o.membersResolved + o.membersUnresolved).toBe(o.eventMembers);
    // The prose must be built from these fields.
    const prose = analysis.residualBlockers.find((b: any) => b.blocker === "owner_lineage_rarely_knowable_at_the_event");
    expect(prose.evidence).toContain(`${o.capturedAfterObservedDay} of ${o.retainedOwnerRows}`);
    // The OUTPUT must be built from the derived fields, never from a literal.
    // (Explanatory prose describing the r4 defect may still name it.)
    const src = readFileSync(resolve("scripts/audits/d084-commercial-target-evidence.ts"), "utf8");
    const residual = src.slice(src.indexOf('blocker: "owner_lineage_rarely_knowable_at_the_event"'));
    const evidenceLine = residual.slice(0, residual.indexOf("consequence:"));
    expect(evidenceLine).toContain("ownerClockCoverage.capturedAfterObservedDay");
    expect(evidenceLine).toContain("ownerClockCoverage.retainedOwnerRows");
    expect(evidenceLine).not.toMatch(/\b45[0-9] of 46[0-9]\b/);
  });

  it("supersedes r5 and retains the whole chain back to v1, byte for byte", () => {
    const sup = (artifact.snapshot as any).supersedes;
    expect(sup.contract).toBe("d084.commercial-target-evidence.v5");
    expect(sup.fileSha256).toBe("d7395b1c0ca4d824de3e7cf2d127d340af67466645a32510f1b290b89e7ee840");
    expect(sup.artifactHash).toBe("9086f53c794fce0edf89f317bec8c3f2fccb7a6f3c922171e2f029ab202e247b");
    expect(sup.alsoSupersedes.contract).toBe("d084.commercial-target-evidence.v4");
    expect(sup.alsoSupersedes.fileSha256).toBe("bf857fb178927b59f2f3a748f7ffeb485fb95b4a7bf62cadd3f614d976278ddd");
    expect(sup.priorChain.map((l: any) => l.contract)).toEqual([
      "d084.commercial-target-evidence.v3",
      "d084.commercial-target-evidence.v2",
      "d084.commercial-target-evidence.v1",
    ]);
    // Every retained predecessor is still exactly the file it was.
    for (const link of [sup, sup.alsoSupersedes, ...sup.priorChain]) {
      const bytes = readFileSync(resolve(link.path));
      expect(createHash("sha256").update(bytes).digest("hex"), link.path).toBe(link.fileSha256);
      expect(JSON.parse(bytes.toString("utf8")).artifactHash, link.path).toBe(link.artifactHash);
    }
  });

  it("derives zero proved owner mirrors from the pinned bytes", () => {
    // Not hardcoded: r3 claimed two, and both rested on child owner rows
    // captured after the events they justified.
    expect(analysis.eventBounds.provedGroups).toBe(0);
    expect(analysis.eventBounds.lower).toBe(14);
    expect(analysis.eventBounds.upper).toBe(23);
    for (const group of analysis.eventGroups) {
      expect(group.groupingProof).not.toBe("proved_owner_mirror_single_child");
    }
  });

  it("publishes collapsed-config coverage and the evaluations it costs", () => {
    const c = analysis.collapsedConfigCoverage;
    expect(c.configRows).toBe(11_623);
    expect(c.collapsedRows).toBe(3780);
    expect(c.collapsedByDistinctFingerprints).toEqual({ "2": 3709, "3": 70, "4": 1 });
    expect(c.evaluations).toBe(c.evaluationsResolved + Object.values(c.evaluationsNotDeterminable).reduce((a: number, b: any) => a + b, 0));
    expect(c.evaluationsNotDeterminable.not_determinable_collapsed_skyline).toBeGreaterThan(0);
    // Per-business and per-account coverage, where the loss is decision-relevant.
    expect(Object.keys(c.byBusiness).length).toBeGreaterThan(0);
    for (const p of Object.values(c.byBusiness) as any[]) {
      expect(p.resolved + p.notDeterminable).toBe(p.evaluations);
    }
  });

  it("publishes honest action bounds with ambiguity preserved", () => {
    expect(analysis.eventBounds.lower).toBeLessThan(analysis.eventBounds.upper);
    expect(analysis.eventBounds.ambiguousGroups).toBeGreaterThan(0);
    expect(analysis.eventBounds.memberRows).toBe(23);
    for (const group of analysis.eventGroups) {
      if (group.groupingProof === "ambiguous_multi_member") {
        expect(group.representativeMemberKey).toBeNull();
      }
    }
  });

  it("never claims support for a day outside pinned retention", () => {
    const last = analysis.retention.dailyLast as string;
    for (const row of analysis.eventStudy) {
      for (const member of row.members) {
        for (const w of member.windows) {
          if (w.support === "supported") {
            expect(w.coveredEntityDays).toBe(w.requestedDays);
            expect(w.retainedEligibleDays).toBe(w.requestedDays);
          }
        }
      }
    }
    expect(last <= "2026-08-21").toBe(true);
  });

  it("publishes every action as not_determinable and no eligibility", () => {
    expect(analysis.fleet.canonicalProfileActionsEligible).toBe(0);
    expect(analysis.fleet.canonicalProfileActionsNotDeterminable).toBe(18);
    for (const business of analysis.canonicalProfileAvailability) {
      for (const action of business.byAction) expect(action.eligible).toBeNull();
    }
  });

  it("keeps the authority ceiling", () => {
    expect(analysis.fleet.maximumReachableAuthority).toBe("validated_only");
    expect(analysis.fleet.automation).toBe("off");
    for (const row of analysis.perBusiness) expect(row.approvedForPolicy).toBe(false);
    for (const s of analysis.scenarios) expect(s.actionAuthority).toBe("none_review_only");
  });

  it("verifies against the pinned sources on disk", () => {
    // The independent oracle re-derives every world for every control and
    // parameter, so one verify sits right at the 15s default. Give it the same
    // budget the sibling verify-bound tests already carry.
    const result = verifyArtifact(loadArtifact());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toContain("sourceFidelity");
    expect(result.checked.length).toBeGreaterThanOrEqual(14);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Rejection 10 — re-sealed forgery must still fail
// ---------------------------------------------------------------------------

describe("a re-sealed forgery cannot pass verification", () => {
  /**
   * Mutate, then re-run analyse and recompute EVERY internal hash — the exact
   * attack the rejection reproduced against r2, where this returned ok:true.
   */
  const reseal = (mutate: (a: Record<string, any>) => void) => {
    const artifact = loadArtifact() as Record<string, any>;
    mutate(artifact);
    artifact.analysis = analyse(artifact.snapshot);
    artifact.snapshotHash = canonicalDigest(artifact.snapshot);
    artifact.analysisHash = canonicalDigest(artifact.analysis);
    delete artifact.artifactHash;
    artifact.artifactHash = canonicalDigest(
      Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash")),
    );
    return verifyArtifact(artifact);
  };

  /**
   * Recompute the three envelope hashes WITHOUT re-analysing.
   *
   * The verifier refuses before re-analysis once the frozen slices stop
   * matching the pinned files, so for source-level forgeries a full re-analysis
   * adds cost and proves nothing extra. `reseal` above still exercises the
   * complete attack on the headline case.
   */
  const resealShallow = (mutate: (a: Record<string, any>) => void) => {
    const artifact = loadArtifact() as Record<string, any>;
    mutate(artifact);
    artifact.snapshotHash = canonicalDigest(artifact.snapshot);
    artifact.analysisHash = canonicalDigest(artifact.analysis);
    delete artifact.artifactHash;
    artifact.artifactHash = canonicalDigest(
      Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash")),
    );
    return verifyArtifact(artifact);
  };

  /*
    PRE-DEPLOY AUDIT — 90s, because this case was FLAKY on the default 15s.
    Loading and verifying the 41 MB r6 artifact re-extracts and re-analyses
    every frozen row, which measures 14-17s here: three runs in four failed
    with "Test timed out in 15000ms" and the fourth passed. A control that
    fails at random is worse than no control — it teaches a reader to re-run
    until green. The budget is measured, not guessed, and the sibling case
    below already carries an explicit 90s for the same reason.
  */
  it("positive control: an untouched artifact verifies", () => {
    const result = verifyArtifact(loadArtifact());
    expect(result.ok).toBe(true);
  }, 90_000);

  it.each([
    { name: "full", reseal },
    { name: "shallow", reseal: resealShallow },
  ])(
    "negative control: $name re-sealing WITHOUT mutating still verifies",
    ({ reseal: resealForControl }) => {
      // Each control proves its attack harness is faithful. Keeping them
      // separate preserves both assertions and the existing 90 s per-control
      // bound: CI run 34048550680 measured a single verify at 46.1–46.7 s,
      // while the two combined took 94.1 s and exceeded that same bound.
      expect(resealForControl(() => {}).failures).toEqual([]);
    },
    90_000,
  );

  it.each([
    ["a frozen delivery spend", (a: any) => {
      const at = a.snapshot.daily.columns.indexOf("spend");
      a.snapshot.daily.rows[0][at] = Number(a.snapshot.daily.rows[0][at]) + 1000;
      a.snapshot.daily.digest = canonicalDigest(decodeDaily(a.snapshot.daily));
    }],
    ["a frozen config budget", (a: any) => {
      const at = a.snapshot.configStates.columns.indexOf("dailyBudgetRaw");
      a.snapshot.configStates.rows[0][at] = 999999;
      a.snapshot.configStates.digest = canonicalDigest(decodeConfig(a.snapshot.configStates));
    }],
    ["a frozen owner state", (a: any) => { a.snapshot.ownerStates[0].budgetOrigin = "campaign"; }],
    ["a frozen transition percent", (a: any) => { a.snapshot.transitions[0].percent = 1; }],
    ["a frozen target pack", (a: any) => { a.snapshot.targetPackHistory[0].target_cpa = 12.5; }],
    ["a frozen persisted census", (a: any) => { a.snapshot.persistedDecisionCensus[0].byAction[0].eligibleBefore = 99; }],
    ["a dropped delivery row", (a: any) => {
      a.snapshot.daily.rows.pop();
      a.snapshot.daily.count = a.snapshot.daily.rows.length;
      a.snapshot.daily.digest = canonicalDigest(decodeDaily(a.snapshot.daily));
    }],
    ["an added delivery row", (a: any) => {
      a.snapshot.daily.rows.push([...a.snapshot.daily.rows[0]]);
      a.snapshot.daily.count = a.snapshot.daily.rows.length;
      a.snapshot.daily.digest = canonicalDigest(decodeDaily(a.snapshot.daily));
    }],
  ])("rejects a re-sealed forgery of %s", (_label, mutate) => {
    const result = resealShallow(mutate);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("sourceFidelity");
  }, 90_000);

  it(
    "rejects the FULL re-sealed attack the rejection reproduced against r2",
    () => {
      // Edit a frozen delivery spend, re-run analyse, recompute snapshot,
      // analysis and artifact hashes. r2 returned ok:true here.
      const result = reseal((a) => {
        const at = a.snapshot.daily.columns.indexOf("spend");
        a.snapshot.daily.rows[0][at] = Number(a.snapshot.daily.rows[0][at]) + 1000;
        a.snapshot.daily.digest = canonicalDigest(decodeDaily(a.snapshot.daily));
      });
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toContain("sourceFidelity");
    },
    90_000,
  );

  it.each([
    ["a drifted source path", (a: any) => { a.snapshot.sourceManifest[0].path = "docs/audits/generated/elsewhere.json"; }],
    ["a drifted source hash", (a: any) => { a.snapshot.sourceManifest[0].observedSha256 = "a".repeat(64); }],
    ["a dropped source", (a: any) => { a.snapshot.sourceManifest.pop(); }],
    ["a drifted expected hash", (a: any) => { a.snapshot.sourceManifest[0].expectedSha256 = "b".repeat(64); }],
  ])("rejects %s in the source manifest", (_label, mutate) => {
    const result = resealShallow(mutate);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("pinnedSources");
  }, 90_000);

  it("rejects a slice digest that no longer describes its own rows", () => {
    const result = resealShallow((a) => { a.snapshot.daily.digest = "c".repeat(64); });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("digest does not describe its own rows");
  }, 90_000);

  it("rejects a re-introduced live-read provenance field", () => {
    const result = resealShallow((a) => { a.snapshot.provenance.queryContractSha256 = "d".repeat(64); });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("no live-read field");
  }, 90_000);

  it.each([
    ["a forged predecessor file hash", (a: any) => { a.snapshot.supersedes.fileSha256 = "e".repeat(64); }],
    ["a forged predecessor artifact hash", (a: any) => { a.snapshot.supersedes.artifactHash = "f".repeat(64); }],
    ["a dropped v1 lineage", (a: any) => { delete a.snapshot.supersedes.alsoSupersedes; }],
  ])("rejects %s", (_label, mutate) => {
    const result = resealShallow(mutate);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("supersedes");
  }, 90_000);

  /**
   * Correction 5 / B — every rejection class the independent verifier owns.
   *
   * r5's verifier called the production world builder, folder and control
   * evaluators for its "expected" answers, sampled `worlds.slice(0, 32)` and
   * checked only cooldown=7, and never validated a witness. Each mutation
   * below corrupts one class and must be caught by the INDEPENDENT oracle.
   */
  const firstCell = (a: any, family: "cooldownGrid" | "capGrid" | "lookbackGrid" | "concentrationGrid") =>
    a.analysis[family][0];

  it.each([
    ["evaluatedLower", (a: any) => { firstCell(a, "cooldownGrid").outcome.evaluatedLower -= 1; }],
    ["evaluatedUpper", (a: any) => { firstCell(a, "cooldownGrid").outcome.evaluatedUpper += 1; }],
    ["blockedLower", (a: any) => { firstCell(a, "cooldownGrid").outcome.blockedLower += 1; }],
    ["blockedUpper", (a: any) => { firstCell(a, "cooldownGrid").outcome.blockedUpper += 1; }],
    ["clearedLower", (a: any) => { firstCell(a, "cooldownGrid").outcome.clearedLower += 1; }],
    ["clearedUpper", (a: any) => { firstCell(a, "cooldownGrid").outcome.clearedUpper += 1; }],
    ["a cap cell — a control r5 never swept", (a: any) => { firstCell(a, "capGrid").outcome.blockedUpper += 1; }],
    ["a lookback cell — the control that carried the same-day defect", (a: any) => {
      // 14d/account publishes blocked=[1,2]; 7d/entity is [0,0] and setting it
      // to 0 would mutate nothing at all.
      const cell = a.analysis.lookbackGrid.find((c: any) => c.lookbackDays === 14 && c.scope === "account");
      cell.outcome.blockedLower = 0;
    }],
    ["the same-direction repeat bounds", (a: any) => {
      const cell = firstCell(a, "lookbackGrid");
      cell.sameDirectionRepeatsLower = 0;
      cell.sameDirectionRepeatsUpper = cell.outcome.evaluatedUpper;
    }],
    ["a concentration degeneracy count", (a: any) => { firstCell(a, "concentrationGrid").degenerateFleetDaysUpper = 0; }],
    ["the guaranteed identity intersection", (a: any) => {
      firstCell(a, "cooldownGrid").outcome.guaranteedBlockedKeys = ["forged::identity"];
    }],
    ["the possible identity union", (a: any) => {
      // 56d/fleet carries 28 possible identities; emptying 7d/entity's already
      // empty set would prove nothing.
      const cell = a.analysis.lookbackGrid.find((c: any) => c.lookbackDays === 56 && c.scope === "fleet");
      cell.outcome.possiblyBlockedKeys = [];
    }],
    ["an `exact` identity claim over differing sets", (a: any) => {
      const o = firstCell(a, "capGrid").outcome;
      o.identitySemantics = "exact";
      o.guaranteedBlockedKeys = ["a"];
      o.possiblyBlockedKeys = ["b"];
    }],
    ["a witness VALUE", (a: any) => {
      const o = firstCell(a, "cooldownGrid").outcome;
      if (o.witnesses?.blockedUpper) o.witnesses.blockedUpper.value += 1;
    }],
    ["a witness world KEY that is foreign to the space", (a: any) => {
      const o = firstCell(a, "cooldownGrid").outcome;
      if (o.witnesses?.blockedUpper) o.witnesses.blockedUpper.worldKey = "not-a-world";
    }],
    ["a DELETED witness", (a: any) => {
      const o = firstCell(a, "cooldownGrid").outcome;
      if (o.witnesses) o.witnesses.clearedLower = null;
    }],
    ["a witness bucket lineage that no longer sums to its value", (a: any) => {
      const o = firstCell(a, "cooldownGrid").outcome;
      const w = o.witnesses?.blockedUpper;
      if (w?.orderBuckets?.length) w.orderBuckets[0].blockedUpper += 1;
    }],
    ["the declared order-space semantics", (a: any) => {
      firstCell(a, "cooldownGrid").outcome.orderSpaceSemantics = "orders do not matter";
    }],
    ["the order-dependence declaration", (a: any) => {
      firstCell(a, "lookbackGrid").outcome.orderDependent = true;
    }],
    ["the partition-world digest", (a: any) => {
      firstCell(a, "cooldownGrid").outcome.worldDigest = "0".repeat(64);
    }],
    ["the published world count", (a: any) => { a.analysis.worldSpace.worldCount += 1; }],
    ["the published action bounds", (a: any) => { a.analysis.worldSpace.actionUpperBound += 1; }],
  ])("the independent verifier rejects a forged %s", (_label, mutate) => {
    const result = resealShallow(mutate);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("changeSafety");
  }, 90_000);

  it("checks worlds far beyond the 32 r5 sampled", () => {
    // r5 ran `worlds.slice(0, 32)`. Point a witness at a real world deep in the
    // space that does NOT achieve the extremum: only a verifier that actually
    // evaluates that world can tell.
    const artifact = loadArtifact() as any;
    const space = oracleSpace(toWorldGroups(artifact.analysis.eventGroups));
    expect(space.worldCount).toBe(640);
    const deep = space.worlds[500]!;
    expect(deep).toBeDefined();
    const result = resealShallow((a: any) => {
      const o = a.analysis.cooldownGrid.find((c: any) => c.scope === "account" && c.cooldownDays === 7).outcome;
      o.witnesses.blockedUpper.worldKey = deep.worldKey;
    });
    // Either the deep world reproduces the extremum (then the witness is
    // legitimate and this assertion documents that) or the verifier names it.
    const achieving = oracleCell(space, "account", "cooldown", 7).worldsAchievingBlockedUpper;
    if (!achieving.includes(deep.worldKey)) {
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toContain("does not reproduce");
    } else {
      expect(achieving).toContain(deep.worldKey);
    }
  }, 90_000);

  it("still rejects an un-resealed edit, so hash wiring is intact too", () => {
    const artifact = loadArtifact() as Record<string, any>;
    artifact.analysis.fleet.canonicalProfileActionsEligible = 6;
    const result = verifyArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("analysis");
    // PRE-DEPLOY AUDIT — 90s, the budget every heavy case in this describe
    // already carries. Measured at 15-16s, which the default 15s loses to at
    // random: this case failed with "Test timed out in 15000ms".
  }, 90_000);
});

describe("assembly is a pure function of the pinned bytes", () => {
  it("produces byte-identical output twice, with no wall clock", () => {
    const manifest = checkPinnedSources();
    const a = assembleFrozen(loadPinnedSources(), manifest);
    const b = assembleFrozen(loadPinnedSources(), manifest);
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
    expect(canonicalDigest(analyse(a))).toBe(canonicalDigest(analyse(b)));
    // PRE-DEPLOY AUDIT — 90s: two full assemblies and two analyses of the
    // pinned bytes measure ~13s, close enough to the 15s default that a
    // slower machine turns a real proof into a coin flip.
  }, 90_000);

  it("round-trips the columnar encoding without loss", () => {
    const rows = decodeDaily(encodeDaily(decodeDaily((loadArtifact().snapshot as any).daily)));
    expect(canonicalDigest(rows)).toBe((loadArtifact().snapshot as any).daily.digest);
  });

  it("declares every grid dimension and the baseline it varies against", () => {
    expect(Object.keys(D084_GRID_DIMENSIONS).sort()).toEqual(Object.keys(D084_GRID_BASELINE).sort());
    expect(D084_EVENT_WINDOWS_DAYS).toEqual([1, 3, 7, 14, 28]);
  });
});
