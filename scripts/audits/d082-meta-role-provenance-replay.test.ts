import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertRequestIsInScope,
  buildLeakageChecks,
  buildRequest,
  buildRoleProvenanceFinding,
  buildIsolationChecks,
  computeLaneA,
  computeLaneB,
  computeLaneC,
  computeLegacyCensus,
  planWindow,
  satisfiesRoleAuthority,
  scopeOriginKey,
  selectRuntimeRow,
  toRoleRow,
  verifyArtifact,
  originCutoffMs,
  instantMs,
  proposalCampaignIdentity,
  rawText,
  D082_CONTRACT_ID,
  D082_JSON_OUT,
  D082_PINNED_INPUTS,
  D082_QUERIES,
  REQUIRED_CONFIDENCE_CLASS,
  REQUIRED_KIND_SOURCE,
  RUNTIME_VALIDATOR,
  WHAT_IF_VALIDATOR,
  type D082MaterialisedRead,
} from "./d082-meta-role-provenance-replay";
import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import type { OriginPlan } from "@/scripts/audits/d080b-meta-budget-policy-simulation";

type Row = Record<string, unknown>;

// A four-origin axis is enough to exercise "before", "on" and "after".
const ORIGINS: OriginPlan[] = [
  { origin: "2026-05-01", fold: 1, supportedHorizons: [], unsupportedHorizons: [] },
  { origin: "2026-05-08", fold: 1, supportedHorizons: [], unsupportedHorizons: [] },
  { origin: "2026-05-15", fold: 2, supportedHorizons: [], unsupportedHorizons: [] },
  { origin: "2026-05-22", fold: 2, supportedHorizons: [], unsupportedHorizons: [] },
] as unknown as OriginPlan[];

const WINDOW = planWindow(ORIGINS);

const IWA = { businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", account: "act_1087566732415606" };
const GRANDMIX = { businessId: "5dbc7147-f051-4681-a4d6-20617170074f", account: "act_805150454596350" };
const SWAF_SELECTED = { businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", account: "act_822913786458311" };
const SWAF_UNSELECTED = { businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", account: "act_921275999286619" };

/** An exact, authoritative-shaped stored row, one day before the first origin. */
function roleDbRow(over: Row = {}): Row {
  return {
    source_record_id: "00000000-0000-4000-8000-000000000101",
    business_id: IWA.businessId,
    provider_account_id: IWA.account,
    campaign_id: "campaign-1",
    as_of_date: "2026-04-30",
    inferred_kind: "main",
    confidence_score: 0.91,
    confidence_class: REQUIRED_CONFIDENCE_CLASS,
    kind_source: REQUIRED_KIND_SOURCE,
    kind_basis: "behavioral",
    resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    created_at: "2026-04-30 02:00:00+00",
    updated_at: "2026-04-30 02:00:00+00",
    job_run_id: null,
    ...over,
  };
}

function roleRead(
  scope: { businessId: string; account: string },
  rows: Row[],
): D082MaterialisedRead {
  return {
    invocationKey: `roleProvenanceAccountScoped:engine_v3_campaign_context_daily#${scope.businessId}|${scope.account}`,
    planKey: "roleProvenanceAccountScoped",
    businessId: scope.businessId,
    providerAccountId: scope.account,
    source: "engine_v3_campaign_context_daily",
    lane: "strict_pit_authority",
    effectiveFrom: WINDOW.roleFrom,
    effectiveTo: WINDOW.roleTo,
    knowledgeTo: null,
    rows,
  };
}

function snapshotOf(reads: D082MaterialisedRead[]): Record<string, D082MaterialisedRead[]> {
  const out: Record<string, D082MaterialisedRead[]> = {};
  for (const r of reads) (out[r.planKey] ??= []).push(r);
  return out;
}

describe("D082 read plan is SELECT-only and scope-pinned", () => {
  it("contains no mutation statement anywhere in the query contract", () => {
    const mutation = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|GRANT|REVOKE|COPY|VACUUM|REFRESH)\b/i;
    for (const [key, statement] of Object.entries(D082_QUERIES)) {
      expect(statement.trim().toUpperCase().startsWith("SELECT") || statement.trim().toUpperCase().startsWith("WITH"), key).toBe(true);
      expect(mutation.test(statement), key).toBe(false);
    }
  });

  it("refuses a read that addresses a business outside the six", () => {
    expect(() =>
      assertRequestIsInScope(
        buildRequest({
          planKey: "roleProvenanceAccountScoped",
          statement: D082_QUERIES.roleProvenanceAccountScoped,
          params: ["not-a-charter-business", IWA.account, "2026-04-30", "2026-05-01"],
          source: "engine_v3_campaign_context_daily",
          lane: "strict_pit_authority",
          businessId: "not-a-charter-business",
          providerAccountId: IWA.account,
        }),
      ),
    ).toThrow(/not one of the six charter businesses/);
  });

  it("refuses a read that pairs a charter business with a foreign account", () => {
    expect(() =>
      assertRequestIsInScope(
        buildRequest({
          planKey: "roleProvenanceAccountScoped",
          statement: D082_QUERIES.roleProvenanceAccountScoped,
          params: [IWA.businessId, GRANDMIX.account, "2026-04-30", "2026-05-01"],
          source: "engine_v3_campaign_context_daily",
          lane: "strict_pit_authority",
          businessId: IWA.businessId,
          providerAccountId: GRANDMIX.account,
        }),
      ),
    ).toThrow(/not a pinned binding/);
  });

  it("refuses a statement that is not a member of the pinned contract", () => {
    const request = buildRequest({
      planKey: "roleProvenanceAccountScoped",
      statement: "SELECT 1",
      params: [],
      source: "engine_v3_campaign_context_daily",
      lane: "strict_pit_authority",
      businessId: IWA.businessId,
      providerAccountId: IWA.account,
    });
    expect(() => assertRequestIsInScope(request)).toThrow(/not a member of the pinned query contract/);
  });

  it("refuses a request whose statement hash was swapped after building", () => {
    const request = buildRequest({
      planKey: "roleCensus",
      statement: D082_QUERIES.roleCensus,
      params: [IWA.businessId],
      source: "engine_v3_campaign_context_daily",
      lane: "provenance",
      businessId: IWA.businessId,
    });
    expect(() =>
      assertRequestIsInScope({ ...request, statementSha256: "0".repeat(64) }),
    ).toThrow(/statement hash does not match/);
  });

  it("refuses a backwards window", () => {
    const request = buildRequest({
      planKey: "roleProvenanceAccountScoped",
      statement: D082_QUERIES.roleProvenanceAccountScoped,
      params: [IWA.businessId, IWA.account, "2026-05-01", "2026-04-01"],
      source: "engine_v3_campaign_context_daily",
      lane: "strict_pit_authority",
      businessId: IWA.businessId,
      providerAccountId: IWA.account,
      effectiveFrom: "2026-05-01",
      effectiveTo: "2026-04-01",
    });
    expect(() => assertRequestIsInScope(request)).toThrow(/window runs backwards/);
  });
});

describe("exact source and resolver identity", () => {
  it("accepts the exact positive control under the what-if validator", () => {
    const row = toRoleRow(roleDbRow(), IWA.account);
    expect(satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok).toBe(true);
  });

  it.each([
    ["manual", { kind_source: "manual" }],
    ["legacy_label", { kind_source: "legacy_label" }],
    ["user_override", { kind_source: "user_override" }],
    ["upper case", { kind_source: "SYSTEM_INFERRED" }],
    ["leading space", { kind_source: " system_inferred" }],
    ["trailing space", { kind_source: "system_inferred " }],
    ["empty", { kind_source: "" }],
    ["null", { kind_source: null }],
  ])("refuses a non-exact kind_source (%s)", (_label, over) => {
    const row = toRoleRow(roleDbRow(over), IWA.account);
    expect(satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok).toBe(false);
  });

  it.each([
    ["retired v2", { resolver_version: RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS[0] }],
    ["v1 shadow", { resolver_version: "campaign-context-resolver.v1-shadow-2026-07-06" }],
    ["leading space", { resolver_version: ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}` }],
    ["trailing space", { resolver_version: `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} ` }],
    ["upper case", { resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION.toUpperCase() }],
    ["empty", { resolver_version: "" }],
    ["null", { resolver_version: null }],
  ])("refuses a non-exact resolver_version (%s)", (_label, over) => {
    const row = toRoleRow(roleDbRow(over), IWA.account);
    expect(satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok).toBe(false);
  });

  it("refuses a confidence class that is not exactly high", () => {
    for (const cls of ["medium", "low", "unknown", "conflict", "High", " high"]) {
      const row = toRoleRow(roleDbRow({ confidence_class: cls }), IWA.account);
      expect(satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok, cls).toBe(false);
    }
  });

  it("never trims a raw provenance value on the way in", () => {
    expect(rawText(" system_inferred")).toBe(" system_inferred");
    expect(rawText(123)).toBeNull();
    const row = toRoleRow(roleDbRow({ kind_source: " system_inferred" }), IWA.account);
    expect(row.kindSource).toBe(" system_inferred");
  });
});

describe("Lane A reports the true runtime result under the real env gate", () => {
  it("resolves zero live authority while the authority env is unset, even on perfectly shaped rows", () => {
    expect(process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION).toBeUndefined();
    const snapshot = snapshotOf([roleRead(IWA, [roleDbRow(), roleDbRow({ campaign_id: "campaign-2" })])]);
    const laneA = computeLaneA(snapshot, WINDOW);

    expect(laneA.envGate.set).toBe(false);
    expect(laneA.envGate.approvedIdentityResolves).toBe(false);
    expect(laneA.authoritative).toBe(0);
    // Non-vacuous: the same rows would qualify if an operator had approved the
    // identity, so zero is the gate's doing and not an empty input.
    expect(laneA.technicallyShapedButGateClosed).toBeGreaterThan(0);
    expect(Object.keys(laneA.firstBlockerCensus).length).toBeGreaterThan(0);
    expect(RUNTIME_VALIDATOR(CAMPAIGN_CONTEXT_RESOLVER_VERSION)).toBe(false);
  });

  it("honours the freshness window the runtime reader uses", () => {
    const rows = [roleDbRow({ as_of_date: "2026-04-20" })];
    expect(selectRuntimeRow(rows.map((r) => toRoleRow(r, IWA.account)), "2026-05-01")).toBeNull();
    const fresh = [roleDbRow({ as_of_date: "2026-04-30" })];
    expect(selectRuntimeRow(fresh.map((r) => toRoleRow(r, IWA.account)), "2026-05-01")).not.toBeNull();
  });
});

describe("Lane B excludes everything that was not knowable at the origin", () => {
  const laneBFor = (over: Row) =>
    computeLaneB(snapshotOf([roleRead(IWA, [roleDbRow(over)])]), WINDOW);

  it("resolves the exact, fully knowable control", () => {
    const laneB = laneBFor({});
    expect(laneB.resolvedScopeOrigins).toBeGreaterThan(0);
    expect(laneB.resolvedScopeOriginKeys).toContain(
      scopeOriginKey(IWA.businessId, IWA.account, "campaign-1", "2026-05-01"),
    );
  });

  it("excludes an origin-day fact at the origin it is dated on", () => {
    const laneB = laneBFor({ as_of_date: "2026-05-01" });
    expect(
      laneB.resolvedScopeOriginKeys.includes(
        scopeOriginKey(IWA.businessId, IWA.account, "campaign-1", "2026-05-01"),
      ),
    ).toBe(false);
    // and becomes knowable only once the origin advances past it
    expect(
      laneB.resolvedScopeOriginKeys.some((k) => k.endsWith("|2026-05-08")) ||
        laneB.exclusionCensus.outside_freshness_window > 0,
    ).toBe(true);
  });

  it("excludes a row created after the origin", () => {
    const laneB = laneBFor({ created_at: "2026-05-02 00:00:00+00" });
    expect(laneB.exclusionCensus.created_after_origin).toBeGreaterThan(0);
    expect(
      laneB.resolvedScopeOriginKeys.includes(
        scopeOriginKey(IWA.businessId, IWA.account, "campaign-1", "2026-05-01"),
      ),
    ).toBe(false);
  });

  it("reports a row rewritten after the origin as unreconstructible, never as evidence", () => {
    const laneB = laneBFor({ updated_at: "2026-05-02 00:00:00+00" });
    expect(laneB.mutablePriorVersionUnreconstructible).toBeGreaterThan(0);
    expect(laneB.exclusionCensus.mutable_prior_version_unreconstructible).toBeGreaterThan(0);
    expect(
      laneB.resolvedScopeOriginKeys.includes(
        scopeOriginKey(IWA.businessId, IWA.account, "campaign-1", "2026-05-01"),
      ),
    ).toBe(false);
  });

  it("excludes a row whose provenance is not exact", () => {
    const laneB = laneBFor({ resolver_version: "campaign-context-resolver.v1-shadow-2026-07-06" });
    expect(laneB.exclusionCensus.provenance_not_exact).toBeGreaterThan(0);
    expect(laneB.resolvedScopeOrigins).toBe(0);
  });
});

describe("cross-scope isolation", () => {
  it("never cross-pairs the same campaign id across two businesses", () => {
    const snapshot = snapshotOf([
      roleRead(IWA, [roleDbRow({ campaign_id: "shared-campaign" })]),
      roleRead(GRANDMIX, [
        roleDbRow({
          business_id: GRANDMIX.businessId,
          provider_account_id: GRANDMIX.account,
          campaign_id: "shared-campaign",
        }),
      ]),
    ]);
    const laneB = computeLaneB(snapshot, WINDOW);
    const iwaKeys = laneB.resolvedScopeOriginKeys.filter((k) => k.startsWith(IWA.businessId));
    const gmKeys = laneB.resolvedScopeOriginKeys.filter((k) => k.startsWith(GRANDMIX.businessId));
    expect(iwaKeys.length).toBeGreaterThan(0);
    expect(gmKeys.length).toBeGreaterThan(0);
    // Same campaign id, two scopes, and never one key doing duty for both.
    expect(new Set([...iwaKeys, ...gmKeys]).size).toBe(iwaKeys.length + gmKeys.length);
    for (const key of iwaKeys) expect(key.includes(GRANDMIX.account)).toBe(false);
    for (const key of gmKeys) expect(key.includes(IWA.account)).toBe(false);
  });

  it("keeps TheSwaf's deselected account from contaminating the selected one", () => {
    const snapshot = snapshotOf([
      roleRead(SWAF_SELECTED, [
        roleDbRow({
          business_id: SWAF_SELECTED.businessId,
          provider_account_id: SWAF_SELECTED.account,
          campaign_id: "swaf-shared",
        }),
      ]),
      roleRead(SWAF_UNSELECTED, [
        roleDbRow({
          business_id: SWAF_UNSELECTED.businessId,
          provider_account_id: SWAF_UNSELECTED.account,
          campaign_id: "swaf-shared",
        }),
      ]),
    ]);
    const laneB = computeLaneB(snapshot, WINDOW);
    const selected = laneB.resolvedScopeOriginKeys.filter((k) => k.includes(SWAF_SELECTED.account));
    const unselected = laneB.resolvedScopeOriginKeys.filter((k) => k.includes(SWAF_UNSELECTED.account));
    expect(selected.length).toBeGreaterThan(0);
    expect(unselected.length).toBeGreaterThan(0);
    expect(selected.some((k) => unselected.includes(k))).toBe(false);
  });

  it("marks an empty isolation check as vacuous rather than passed-and-meaningful", () => {
    const checks = buildIsolationChecks(snapshotOf([roleRead(IWA, [])]));
    const swaf = checks.find((c) => String(c.check).includes("never share a campaign in the role read"));
    expect(swaf?.vacuous).toBe(true);
  });
});

describe("legacy null-account rows stay research-only", () => {
  const legacyRead = (rows: Row[]): D082MaterialisedRead => ({
    invocationKey: `roleProvenanceLegacyNullAccount:engine_v3_campaign_context_daily#${IWA.businessId}`,
    planKey: "roleProvenanceLegacyNullAccount",
    businessId: IWA.businessId,
    providerAccountId: null,
    source: "engine_v3_campaign_context_daily",
    lane: "legacy_identity_join_research_only",
    effectiveFrom: WINDOW.roleFrom,
    effectiveTo: WINDOW.roleTo,
    knowledgeTo: null,
    rows,
  });
  const identityRead = (rows: Row[]): D082MaterialisedRead => ({
    invocationKey: `campaignIdentityObservations:meta_campaign_daily#${IWA.businessId}|${IWA.account}`,
    planKey: "campaignIdentityObservations",
    businessId: IWA.businessId,
    providerAccountId: IWA.account,
    source: "meta_campaign_daily",
    lane: "legacy_identity_join_research_only",
    effectiveFrom: null,
    effectiveTo: null,
    knowledgeTo: WINDOW.lastOrigin,
    rows,
  });

  const legacyRow = (over: Row = {}) => {
    const row = roleDbRow({ campaign_id: "legacy-1", ...over });
    delete (row as Row).provider_account_id;
    return row;
  };

  it("resolves an identity observed uniquely before the origin", () => {
    const census = computeLegacyCensus(
      snapshotOf([
        legacyRead([legacyRow()]),
        identityRead([
          { campaign_id: "legacy-1", provider_account_id: IWA.account, first_observed_on: "2026-04-01", last_observed_on: "2026-05-20" },
        ]),
      ]),
      WINDOW,
    );
    expect(census.identityResolved).toBe(1);
    expect(census.identityAmbiguous).toBe(0);
    expect(census.truth).toBe("research_only");
    expect(census.lane).toBe("legacy_identity_join_research_only");
  });

  it("refuses an identity first observed only after the origin", () => {
    const census = computeLegacyCensus(
      snapshotOf([
        legacyRead([legacyRow()]),
        identityRead([
          { campaign_id: "legacy-1", provider_account_id: IWA.account, first_observed_on: "2026-05-20", last_observed_on: "2026-05-21" },
        ]),
      ]),
      WINDOW,
    );
    expect(census.identityResolved).toBe(0);
    expect(census.identityAbsentBeforeOrigin).toBe(1);
  });

  it("refuses an ambiguous identity observed under two accounts", () => {
    const census = computeLegacyCensus(
      snapshotOf([
        legacyRead([legacyRow()]),
        identityRead([
          { campaign_id: "legacy-1", provider_account_id: IWA.account, first_observed_on: "2026-04-01", last_observed_on: "2026-05-20" },
          { campaign_id: "legacy-1", provider_account_id: GRANDMIX.account, first_observed_on: "2026-04-02", last_observed_on: "2026-05-20" },
        ]),
      ]),
      WINDOW,
    );
    expect(census.identityResolved).toBe(0);
    expect(census.identityAmbiguous).toBe(1);
  });

  it("never feeds a resolved legacy row into the strict lane", () => {
    const snapshot = snapshotOf([
      legacyRead([legacyRow()]),
      identityRead([
        { campaign_id: "legacy-1", provider_account_id: IWA.account, first_observed_on: "2026-04-01", last_observed_on: "2026-05-20" },
      ]),
    ]);
    expect(computeLegacyCensus(snapshot, WINDOW).identityResolved).toBe(1);
    expect(computeLaneB(snapshot, WINDOW).resolvedScopeOrigins).toBe(0);
    expect(computeLaneA(snapshot, WINDOW).authoritative).toBe(0);
  });
});

describe("Lane C counterfactual", () => {
  const creativeRead = (
    scope: { businessId: string; account: string },
    rows: Row[],
  ): D082MaterialisedRead => ({
    invocationKey: `laneCCreativeDays:meta_creative_daily#${scope.businessId}|${scope.account}`,
    planKey: "laneCCreativeDays",
    businessId: scope.businessId,
    providerAccountId: scope.account,
    source: "meta_creative_daily",
    lane: "retrospective_finalized_conditional",
    effectiveFrom: WINDOW.laneCFrom,
    effectiveTo: WINDOW.laneCTo,
    knowledgeTo: null,
    rows,
  });
  const firstSpendRead = (
    scope: { businessId: string; account: string },
    rows: Row[],
  ): D082MaterialisedRead => ({
    invocationKey: `laneCCreativeFirstSpend:meta_creative_daily#${scope.businessId}|${scope.account}`,
    planKey: "laneCCreativeFirstSpend",
    businessId: scope.businessId,
    providerAccountId: scope.account,
    source: "meta_creative_daily",
    lane: "retrospective_finalized_conditional",
    effectiveFrom: null,
    effectiveTo: null,
    knowledgeTo: WINDOW.laneCTo,
    rows,
  });
  const nameRead = (
    scope: { businessId: string; account: string },
    rows: Row[],
  ): D082MaterialisedRead => ({
    invocationKey: `laneCCampaignNameDays:meta_campaign_daily#${scope.businessId}|${scope.account}`,
    planKey: "laneCCampaignNameDays",
    businessId: scope.businessId,
    providerAccountId: scope.account,
    source: "meta_campaign_daily",
    lane: "retrospective_finalized_conditional",
    effectiveFrom: WINDOW.laneCFrom,
    effectiveTo: WINDOW.laneCTo,
    knowledgeTo: null,
    rows,
  });

  const day = (i: number) => new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10);

  /**
   * A heavy evergreen campaign plus a lab that keeps launching fresh low-spend
   * creatives across several ad sets. The evergreen one reaches hard authority,
   * which is what makes the neutrality assertion below non-vacuous.
   */
  function labRows(scope: { businessId: string; account: string }, prefix: string) {
    const rows: Row[] = [];
    const first = new Map<string, string>();
    for (let c = 0; c < 4; c += 1) {
      const creativeId = `${prefix}-main-creative-${c}`;
      first.set(creativeId, day(0));
      for (let d = 0; d < 100; d += 1) {
        rows.push({
          provider_account_id: scope.account,
          campaign_id: `${prefix}-main-campaign`,
          adset_id: `${prefix}-main-adset`,
          creative_id: creativeId,
          date: day(d),
          spend: 900,
        });
      }
    }
    for (let c = 0; c < 45; c += 1) {
      const creativeId = `${prefix}-lab-creative-${c}`;
      const start = 2 * c;
      first.set(creativeId, day(start));
      for (let d = start; d < Math.min(start + 12, 100); d += 1) {
        rows.push({
          provider_account_id: scope.account,
          campaign_id: `${prefix}-lab-campaign`,
          adset_id: `${prefix}-lab-adset-${c % 5}`,
          creative_id: creativeId,
          date: day(d),
          spend: 30,
        });
      }
    }
    return {
      rows,
      first: [...first].map(([creative_id, first_spend_date]) => ({
        provider_account_id: scope.account,
        creative_id,
        first_spend_date,
      })),
    };
  }

  function laneCSnapshotFor(
    scope: { businessId: string; account: string },
    campaignName: string,
    prefix = "p",
  ) {
    const lab = labRows(scope, prefix);
    return snapshotOf([
      creativeRead(scope, lab.rows),
      firstSpendRead(scope, lab.first),
      nameRead(scope, [
        { campaign_id: `${prefix}-main-campaign`, date: day(0), campaign_name: "Evergreen Prospecting" },
        { campaign_id: `${prefix}-lab-campaign`, date: day(0), campaign_name: campaignName },
      ]),
    ]);
  }

  const ORIGIN_1 = "2026-05-01";
  const ORIGIN_2 = "2026-05-08";
  const DAY_BEFORE_ORIGIN_1 = "2026-04-30";

  /** Rows for a brand-new campaign, starting on `start` and running 6 days. */
  function injectedCampaign(scope: { businessId: string; account: string }, start: string) {
    const rows: Row[] = [];
    const first: Row[] = [];
    const startMs = Date.parse(`${start}T00:00:00Z`);
    for (let c = 0; c < 8; c += 1) {
      const creativeId = `injected-creative-${c}`;
      first.push({ provider_account_id: scope.account, creative_id: creativeId, first_spend_date: start });
      for (let d = 0; d < 6; d += 1) {
        rows.push({
          provider_account_id: scope.account,
          campaign_id: "injected-campaign",
          adset_id: `injected-adset-${c % 3}`,
          creative_id: creativeId,
          date: new Date(startMs + d * 86_400_000).toISOString().slice(0, 10),
          spend: 55,
        });
      }
    }
    return { rows, first };
  }

  function withInjection(
    base: Record<string, D082MaterialisedRead[]>,
    scope: { businessId: string; account: string },
    start: string,
  ) {
    const extra = injectedCampaign(scope, start);
    return {
      ...base,
      laneCCreativeDays: [
        creativeRead(scope, [
          ...((base.laneCCreativeDays ?? [])[0]?.rows ?? []),
          ...extra.rows,
        ]),
      ],
      laneCCreativeFirstSpend: [
        firstSpendRead(scope, [
          ...((base.laneCCreativeFirstSpend ?? [])[0]?.rows ?? []),
          ...extra.first,
        ]),
      ],
    };
  }

  const scoredAt = (result: ReturnType<typeof computeLaneC>, origin: string) =>
    result.scoredScopeOriginKeys.filter((k) => k.includes(`|${origin}~`)).sort();

  it("cannot let a creative row dated on the origin reach that origin's score", () => {
    const base = laneCSnapshotFor(IWA, "Evergreen", "t1");
    const onOrigin = computeLaneC(withInjection(base, IWA, ORIGIN_1), WINDOW);

    // The injected campaign starts exactly on origin 1, so it was not knowable
    // when origin 1 opened and must be absent from origin 1's score.
    expect(scoredAt(onOrigin, ORIGIN_1).some((k) => k.includes("injected-campaign"))).toBe(false);
    // Non-vacuous: the same injection is potent once the daily chain advances.
    expect(scoredAt(onOrigin, ORIGIN_2).some((k) => k.includes("injected-campaign"))).toBe(true);
  });

  it("shows a row dated the day before the origin at that origin (positive control)", () => {
    const base = laneCSnapshotFor(IWA, "Evergreen", "t2");
    const dayBefore = computeLaneC(withInjection(base, IWA, DAY_BEFORE_ORIGIN_1), WINDOW);
    expect(scoredAt(dayBefore, ORIGIN_1).some((k) => k.includes("injected-campaign"))).toBe(true);
  });

  it("leaves every origin-1 tuple byte-identical when the injection lands on the origin", () => {
    const base = laneCSnapshotFor(IWA, "Evergreen", "t3");
    const clean = computeLaneC(base, WINDOW);
    const onOrigin = computeLaneC(withInjection(base, IWA, ORIGIN_1), WINDOW);
    expect(scoredAt(onOrigin, ORIGIN_1)).toEqual(scoredAt(clean, ORIGIN_1));
    // and the injection really does move a later origin, so this is not vacuous
    expect(scoredAt(onOrigin, ORIGIN_2)).not.toEqual(scoredAt(clean, ORIGIN_2));
  });

  it("cannot let a campaign rename dated on the origin reach that origin's score", () => {
    const base = laneCSnapshotFor(IWA, "Main Evergreen", "t4");
    const renamedOnOrigin = {
      ...base,
      laneCCampaignNameDays: [
        nameRead(IWA, [
          ...((base.laneCCampaignNameDays ?? [])[0]?.rows ?? []),
          { campaign_id: "t4-lab-campaign", date: ORIGIN_1, campaign_name: "TEST creative lab" },
        ]),
      ],
    };
    const clean = computeLaneC(base, WINDOW);
    const renamed = computeLaneC(renamedOnOrigin, WINDOW);

    expect(scoredAt(renamed, ORIGIN_1)).toEqual(scoredAt(clean, ORIGIN_1));
    // Non-vacuous: the same rename does move a later, non-authoritative result,
    // because naming stays ordinary explanatory evidence there.
    expect(scoredAt(renamed, ORIGIN_2)).not.toEqual(scoredAt(clean, ORIGIN_2));
    // and it never moves hard authority at any origin
    expect(renamed.resolvedScopeOriginKeys).toEqual(clean.resolvedScopeOriginKeys);
  });

  it("is deterministic and never persists a recomputed row", () => {
    const snapshot = laneCSnapshotFor(IWA, "Spring Prospecting");
    const first = computeLaneC(snapshot, WINDOW);
    const second = computeLaneC(snapshot, WINDOW);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.persisted).toBe(false);
    expect(first.campaignOriginsScored).toBeGreaterThan(0);
    // No statement the extractor can execute may write anything.
    for (const [key, statement] of Object.entries(D082_QUERIES)) {
      expect(/\bINSERT\s+INTO\b/i.test(statement), key).toBe(false);
      expect(/\bUPDATE\s+\w+\s+SET\b/i.test(statement), key).toBe(false);
      expect(/ON\s+CONFLICT/i.test(statement), key).toBe(false);
    }
  });

  it("binds every recomputed row to the exact compiled identity and automatic source", () => {
    const laneC = computeLaneC(laneCSnapshotFor(IWA, "Spring Prospecting"), WINDOW);
    expect(laneC.resolverIdentityBound).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
    expect(laneC.sourceBound).toBe(REQUIRED_KIND_SOURCE);
    expect(laneC.truth).toBe("counterfactual_recompute");
    expect(laneC.lane).toBe("retrospective_finalized_conditional");
  });

  it("groups by physical account: one account's spend never normalises another's", () => {
    const base = laneCSnapshotFor(SWAF_SELECTED, "Lab", "sel");
    const other = labRows(SWAF_UNSELECTED, "unsel");
    const alone = computeLaneC(base, WINDOW);
    const together = computeLaneC(
      {
        ...base,
        laneCCreativeDays: [...(base.laneCCreativeDays ?? []), creativeRead(SWAF_UNSELECTED, other.rows)],
        laneCCreativeFirstSpend: [
          ...(base.laneCCreativeFirstSpend ?? []),
          firstSpendRead(SWAF_UNSELECTED, other.first),
        ],
      },
      WINDOW,
    );
    const selectedAlone = alone.perBinding.find((b) => b.providerAccountId === SWAF_SELECTED.account);
    const selectedTogether = together.perBinding.find((b) => b.providerAccountId === SWAF_SELECTED.account);
    expect(selectedAlone?.campaignOriginsScored).toBe(selectedTogether?.campaignOriginsScored);
    expect(selectedAlone?.wouldSatisfyAuthority).toBe(selectedTogether?.wouldSatisfyAuthority);
    // and the other account is scored in its own right, so the fixture is real
    expect(
      Number(together.perBinding.find((b) => b.providerAccountId === SWAF_UNSELECTED.account)?.campaignOriginsScored ?? 0),
    ).toBeGreaterThan(0);
  });

  it("cannot change the hard-authoritative tuple by changing only the campaign name", () => {
    const names = ["Main Evergreen", "TEST creative lab", "unnamed", "Main / Test hybrid"];
    const authoritative = names.map((name) => {
      const laneC = computeLaneC(laneCSnapshotFor(IWA, name), WINDOW);
      return JSON.stringify({
        count: laneC.wouldSatisfyAuthority,
        scopes: laneC.resolvedScopeOriginKeys,
        selfCheck: laneC.nameNeutrality.hardTuplesChangedByRemovingTheName,
      });
    });
    expect(new Set(authoritative).size).toBe(1);
    const control = computeLaneC(laneCSnapshotFor(IWA, names[0]!), WINDOW);
    // non-vacuous: the fixture really does earn hard authority to preserve
    expect(control.wouldSatisfyAuthority).toBeGreaterThan(0);
    expect(control.nameNeutrality.hardTuplesChecked).toBeGreaterThan(0);
    expect(control.nameNeutrality.hardTuplesChangedByRemovingTheName).toBe(0);
  });

  it("still lets a name move a row that never reaches hard authority", () => {
    // The complement of the invariant: naming remains ordinary evidence, so
    // the neutrality test above is a real constraint and not a tautology.
    const censuses = ["Main Evergreen", "TEST creative lab"].map((name) =>
      JSON.stringify(computeLaneC(laneCSnapshotFor(IWA, name), WINDOW).publishedClassCensus),
    );
    expect(new Set(censuses).size).toBeGreaterThan(1);
  });
});

describe("leakage negative controls run in both directions", () => {
  it("hides a future fact at the origin and reveals it once the origin advances", () => {
    const checks = buildLeakageChecks(WINDOW);
    const advancing = ["as_of_on_origin_day", "created_after_origin", "mutable_prior_version_unreconstructible"];
    for (const family of advancing) {
      const check = checks.find((c) => c.family === family);
      expect(check?.visibleAtEarlierOrigin, family).toBe(false);
      expect(check?.visibleAfterOriginAdvances, family).toBe(true);
    }
  });

  it("never reveals a retired identity or a manual origin at any origin", () => {
    const checks = buildLeakageChecks(WINDOW);
    for (const family of ["retired_resolver_identity", "manual_kind_source"]) {
      const check = checks.find((c) => c.family === family);
      expect(check?.visibleAtEarlierOrigin, family).toBe(false);
      expect(check?.visibleAfterOriginAdvances, family).toBe(false);
    }
  });

  it("puts the knowledge cutoff at the start of the origin day", () => {
    expect(originCutoffMs("2026-05-01")).toBe(Date.parse("2026-05-01T00:00:00.000Z"));
  });

  it("parses the timestamp shapes Postgres actually renders", () => {
    // An hours-only offset is what `timestamptz::text` emits, and it is not
    // ISO-8601. Reading it as null would silently make every clock unknowable.
    expect(instantMs("2026-04-30 02:00:00+00")).toBe(Date.parse("2026-04-30T02:00:00Z"));
    expect(instantMs("2026-04-30 02:00:00+03")).toBe(Date.parse("2026-04-29T23:00:00Z"));
    expect(instantMs("2026-04-30 02:00:00.123456+00")).toBe(Date.parse("2026-04-30T02:00:00.123Z"));
    expect(instantMs("2026-04-30 02:00:00-05:30")).toBe(Date.parse("2026-04-30T07:30:00Z"));
    // and a non-string never becomes a clock
    expect(instantMs(5)).toBeNull();
    expect(instantMs(null)).toBeNull();
  });
});

describe("the produced artifact", () => {
  const artifact = JSON.parse(readFileSync(D082_JSON_OUT, "utf8")) as Record<string, unknown>;

  it("verifies", () => {
    const result = verifyArtifact(artifact);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("carries a server-asserted read-only, repeatable-read proof", () => {
    const provenance = artifact.provenance as Record<string, unknown>;
    expect(provenance.transactionReadOnly).toBe("on");
    expect(provenance.transactionIsolation).toBe("repeatable read");
    expect(provenance.statementTimeout).toBe("30s");
    expect(provenance.lockTimeout).toBe("5s");
    expect(artifact.contract).toBe(D082_CONTRACT_ID);
  });

  it("is rejected when the read-only proof is forged", () => {
    const forged = { ...artifact, provenance: { ...(artifact.provenance as Row), transactionReadOnly: "off" } };
    expect(verifyArtifact(forged).ok).toBe(false);
  });

  it("is rejected when a single stored row is mutated", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const reads = (clone.snapshot as Row).reads as D082MaterialisedRead[];
    const target = reads.find((r) => r.rows.length > 0)!;
    target.rows[0] = { ...target.rows[0], campaign_id: "forged" };
    const result = verifyArtifact(clone);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/snapshot_hash_mismatch|slice_hash_mismatch/);
  });

  it("is rejected when a derived headline is edited", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (clone.laneC as Row).wouldSatisfyAuthority = 999_999;
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/laneC: derived_output_mismatch/);
  });

  it("is rejected when a ledger row count is inflated", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const ledger = (clone.provenance as Row).readLedger as Row[];
    ledger[0]!.rows = 999_999;
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/slice_count_mismatch/);
  });

  it("is rejected when a read addresses an unpinned identity", () => {
    const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const reads = (clone.snapshot as Row).reads as D082MaterialisedRead[];
    reads[0]!.businessId = "00000000-0000-0000-0000-000000000000";
    expect(verifyArtifact(clone).failures.join(" ")).toMatch(/identity_not_pinned/);
  });

  it("reconciles every published denominator", () => {
    for (const row of artifact.reconciliation as Row[]) {
      expect(row.balances, String(row.check)).toBe(true);
    }
    expect((artifact.reconciliation as Row[]).length).toBeGreaterThan(20);
  });

  /*
    PRE-DEPLOY AUDIT — FIVE, not three.

    `D082_PINNED_INPUTS` has always declared five inputs; this loop checked
    three of them. The two it skipped are the H11b bundle and its eval, and
    skipping them is how `.gitignore` came to exclude the bundle while every
    gate stayed green: nothing here ever touched the file, so nothing noticed
    that a release could not ship it. A pin the suite does not check is not a
    pin. The whole record is iterated now, so a sixth input added later is
    covered the day it is declared rather than the day someone remembers.
  */
  it("keeps every frozen predecessor artifact byte-identical", () => {
    const pinned = [
      [D082_PINNED_INPUTS.d080aArtifactPath, D082_PINNED_INPUTS.d080aArtifactSha256],
      [D082_PINNED_INPUTS.d080bArtifactPath, D082_PINNED_INPUTS.d080bArtifactSha256],
      [D082_PINNED_INPUTS.d081ArtifactPath, D082_PINNED_INPUTS.d081ArtifactSha256],
      [D082_PINNED_INPUTS.h11bBundlePath, D082_PINNED_INPUTS.h11bBundleSha256],
      [D082_PINNED_INPUTS.h11bEvalArtifactPath, D082_PINNED_INPUTS.h11bEvalArtifactSha256],
    ] as const;
    // Every declared path/SHA pair, so a new one cannot be quietly left out.
    expect(pinned.length).toBe(Object.keys(D082_PINNED_INPUTS).length / 2);
    for (const [path, expected] of pinned) {
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), path).toBe(expected);
    }
  });

  it("proves name neutrality on real data, over a non-empty set of hard tuples", () => {
    const laneC = artifact.laneC as Row;
    const neutrality = laneC.nameNeutrality as Row;
    expect(Number(neutrality.hardTuplesChecked)).toBeGreaterThan(0);
    expect(neutrality.hardTuplesChangedByRemovingTheName).toBe(0);
    expect(Number(laneC.wouldSatisfyAuthority)).toBe(Number(neutrality.hardTuplesChecked));
  });

  it("never persists a recomputed counterfactual row", () => {
    expect((artifact.laneC as Row).persisted).toBe(false);
    expect((artifact.laneC as Row).resolverIdentityBound).toBe(CAMPAIGN_CONTEXT_RESOLVER_VERSION);
  });

  it("keeps the strict and research lanes separate", () => {
    expect((artifact.laneB as Row).lane).toBe("strict_pit_authority");
    expect((artifact.legacyCensus as Row).lane).toBe("legacy_identity_join_research_only");
    expect((artifact.legacyCensus as Row).truth).toBe("research_only");
    // A research-only row may never appear in the strict lane's numerator.
    expect((artifact.laneB as Row).resolvedScopeOriginKeys).not.toContain(undefined);
  });

  it("claims no causal effect", () => {
    const limits = artifact.limits as Row;
    expect(limits.executable).toBe(false);
    for (const value of Object.values(limits.causalClaims as Row)) expect(value).toBeNull();
  });

  it("keeps the accuracy gate closed by default and states why", () => {
    const laneD = artifact.laneD as Row;
    const gate = laneD.gate as Row;
    expect(typeof gate.openAuthorityGate).toBe("boolean");
    expect((gate.checks as Row[]).some((c) => c.check === "requireIndependentUnreusedHoldout")).toBe(true);
    expect(laneD.manualLabelsAreEvaluationOnly).toBe(true);
  });

  it("recovers the pinned D080B proposal universe rather than recounting it", () => {
    const impact = artifact.proposalImpact as Row;
    expect((impact.denominators as Row).proposals).toBe(247_050);
    const joinability = impact.joinability as Row;
    expect(
      Number(joinability.proposalsWithCampaignIdentity) +
        Number(joinability.proposalsWithoutCampaignIdentity),
    ).toBe(247_050);
  });
});

describe("proposal join key", () => {
  it("uses the entity id for a campaign and the parent for an ad set", () => {
    expect(
      proposalCampaignIdentity({ entityGrain: "campaign", entityId: "c-1", campaignId: null } as never),
    ).toBe("c-1");
    expect(
      proposalCampaignIdentity({ entityGrain: "adset", entityId: "a-1", campaignId: "c-9" } as never),
    ).toBe("c-9");
    expect(
      proposalCampaignIdentity({ entityGrain: "adset", entityId: "a-1", campaignId: null } as never),
    ).toBeNull();
  });
});

describe("role provenance finding", () => {
  it("names the absence of any account-scoped or compiled-identity row", () => {
    const finding = buildRoleProvenanceFinding([
      {
        resolver_version: "campaign-context-resolver.v1-shadow-2026-07-06",
        kind_source: "system_inferred",
        confidence_class: "high",
        account_is_null: true,
        rows: 100,
      },
    ]);
    expect(finding.accountScopedRows).toBe(0);
    expect(finding.rowsAtCompiledIdentity).toBe(0);
    expect(String(finding.finding)).toMatch(/never written a row/);
  });

  it("does not claim absence when an account-scoped compiled row exists", () => {
    const finding = buildRoleProvenanceFinding([
      {
        resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
        kind_source: "system_inferred",
        confidence_class: "high",
        account_is_null: false,
        rows: 5,
      },
    ]);
    expect(finding.accountScopedRows).toBe(5);
    expect(finding.rowsAtCompiledIdentity).toBe(5);
    expect(String(finding.finding)).not.toMatch(/never written a row/);
  });
});
