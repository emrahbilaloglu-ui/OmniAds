/**
 * A PERSISTED `campaignKind` MUST NOT SURVIVE THE READ-TIME GUARD, AND MUST NOT
 * REACH THE LANE SHAPE.
 *
 * Codex Round 6, item 8. Round 5 closed the two authority boundaries — the
 * label guard's `attachCampaignKind` and the lane route's
 * `attachCampaignKindToRecommendation` both destructure the candidate's own
 * `campaignKind` OUT and re-add only a trusted canonical map result — and
 * pinned them with unit cases. What it did NOT prove is the chain: that a kind
 * written into a snapshot ROW, hydrated back by
 * `readLatestMetaDecisionSnapshot`, and carried through the presentation layer
 * is actually gone by the time an operator sees a row.
 *
 * The consequence is concrete rather than cosmetic.
 * `metaOsActionShapeForRecommendation` in `decisions-os-presentation.ts` reads
 * `campaignKind === "mixed"` to answer `structure_review` — the "Review
 * Structure" shape — so a stale `mixed` on a rehydrated row sends the operator
 * to restructure a campaign the resolver has refused to classify. The trusted
 * control at the end proves the kind still arrives when the context earns it,
 * which is what stops this from being satisfied by a guard that deletes
 * everything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db-schema-readiness")>();
  return { ...actual, metaDecisionSnapshotTableReady: vi.fn(async () => true) };
});
vi.mock("@/lib/business-commercial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-commercial")>();
  return { ...actual, getBusinessCommercialTruthSnapshot: vi.fn() };
});
vi.mock("@/lib/meta/empirical-outcome-integration", () => ({
  attachMetaEmpiricalOutcomeSummariesFromLogs: vi.fn(
    async (input: { recommendations: unknown[] }) => input.recommendations,
  ),
}));
vi.mock("@/lib/meta/anomalies", () => ({
  readLatestMetaAnomalies: vi.fn(async () => []),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  readMetaAutomationBusinessControls: vi.fn(async () => null),
}));
/*
  The account/cutoff-scoped Meta sample. Ready, so the commercial authority is
  never the reason a row is held here — this file is about the campaign ROLE.
*/
vi.mock("@/lib/creative-decision-engine/meta-aov-calculator", () => ({
  computeMetaAttributedAov: vi.fn(async () => ({
    aovMean: 180,
    purchaseCount: 60,
    totalRevenue: 10_800,
  })),
}));

const campaignContextSource = await import(
  "@/lib/creative-decision-engine/campaign-context/source"
);
vi.mock("@/lib/creative-decision-engine/campaign-context/source", async (
  importOriginal,
) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/campaign-context/source")
  >();
  return { ...actual, readCampaignContextLabelMap: vi.fn() };
});

import * as db from "@/lib/db";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const BUSINESS = "d8a30000-0000-4000-8000-0000000000c1";
const ACCOUNT = "act_kind_chain";
const CAMPAIGN = "cmp-kind-chain";
const SNAPSHOT_DAY = "2026-09-03";

/**
 * The context states the four-fact predicate REFUSES, plus the one it accepts.
 *
 * `readCampaignContextLabelMap` is the real producer's shape:
 * `readCampaignContextGuardState` copies these fields verbatim into the guard.
 */
function contextEntry(over: Record<string, unknown> = {}) {
  return new Map([
    [
      CAMPAIGN,
      {
        kind: "main",
        contextTrust: "high",
        inferenceConfidenceClass: "high",
        resolverAuthorityValidated: true,
        provenance: {
          mode: "automatic",
          source: "system_inferred",
          campaignId: CAMPAIGN,
          kind: "main",
          contextTrust: "high",
          sourceRecordType: "engine_v3_campaign_context_daily",
          sourceRecordId: `context-${CAMPAIGN}`,
          sourceAsOfDate: SNAPSHOT_DAY,
          sourceUpdatedAt: `${SNAPSHOT_DAY}T01:00:00.000Z`,
          sourceHash: "a".repeat(64),
        },
        ...over,
      },
    ],
  ]) as never;
}

/**
 * A persisted row whose stored payload ALREADY carries a campaignKind.
 *
 * This is the shape the defect needs: the kind is not computed during this
 * read, it is read back out of `evidence` exactly as a snapshot written on a
 * previous day — under a different labelling, or by a resolver version this
 * deployment does not consider authoritative — would hand it over.
 */
function snapshotRow(storedCampaignKind: string) {
  return {
    scope_type: "campaign",
    scope_id: CAMPAIGN,
    business_id: BUSINESS,
    snapshot_date: SNAPSHOT_DAY,
    rec_id: "rec-kind-chain",
    rec_type: "scale_for_volume",
    level: "campaign",
    decision_state: "act",
    confidence_score: 0.9,
    recommended_action: "Increase budget 10-15%.",
    reasoning: "Mature scale signal",
    engine_version: "v1",
    created_at: `${SNAPSHOT_DAY}T03:00:00.000Z`,
    decision_label: "scale",
    target_value: 10,
    evidence: {
      items: [],
      recommendation: {
        id: "rec-kind-chain",
        level: "campaign",
        campaignId: CAMPAIGN,
        campaignName: "Rehydrated campaign",
        type: "scale_for_volume",
        lens: "volume",
        priority: "high",
        confidence: "high",
        confidenceScore: 0.9,
        confidenceReason: null,
        decisionState: "act",
        decision: "Scale",
        title: "Scale Rehydrated campaign",
        why: "Above the line.",
        summary: "Strong.",
        recommendedAction: "Increase budget 10-15%.",
        expectedImpact: "More volume.",
        evidence: [],
        /*
          The structure builder only nodes rows it can see are ACTIVE
          (`isExplicitlyActiveStructureRecommendation`), which is what the lane
          route attaches from the provider configuration. Without it the
          presentation assertions below would pass on an empty payload.
        */
        entityConfiguration: {
          status: "ACTIVE",
          budgetOwner: "campaign",
          budgetMode: "campaign_budget_optimization",
          controlOwner: "campaign",
        },
        // THE STALE VALUE.
        campaignKind: storedCampaignKind,
      },
    },
  };
}

function installDb(row: Record<string, unknown>) {
  const query = async (text: string) => {
    if (
      text.includes("FROM meta_decision_snapshots_daily") &&
      text.includes("WITH latest AS")
    ) {
      return [row];
    }
    return [];
  };
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) =>
      query(
        strings.reduce(
          (text, part, index) =>
            text + part + (index < params.length ? `$${index + 1}` : ""),
          "",
        ),
      ),
    { query },
  );
  vi.mocked(db.getDb).mockReturnValue(sql as ReturnType<typeof db.getDb>);
}

/**
 * The action LABEL the operator actually reads, through the real builder the
 * decisions-workspace route calls.
 *
 * Asserting on the served label rather than on an internal shape enum keeps
 * this an integration proof: a stale `mixed` reaching the surface renders as
 * "Review Structure", which tells an operator to restructure a campaign whose
 * role the resolver refused to state.
 */
function servedActionLabel(rec: MetaRecommendation): string | null {
  const served = buildMetaOsDecisionsPresentation({
    actionNow: [rec],
    watching: [],
    nonSales: [],
    decisionReadModel: {
      source: { snapshotAsOf: null, engineVersion: null },
      queue: { sections: {} },
      structure: { entities: [] },
    },
    currency: "USD",
    generatedAt: "2026-09-03T00:00:00.000Z",
  } as never);
  const node = served.structure?.groups?.[0]?.campaign ?? null;
  return (node?.action?.label as string | undefined) ?? null;
}

/**
 * Whether the served node claims the campaign role is TRUSTED FOR ACTION.
 *
 * Deliberately not `lifecycleRole`: that field is a PRESENTATION role and
 * `presentedCampaignRole` falls back to a provisional name-based inference so a
 * reader always sees something. `campaignRoleTrustedForAction` is the authority
 * claim, and it is the one a stale kind must never be able to set.
 */
function servedRoleTrustedForAction(rec: MetaRecommendation): boolean | null {
  const served = buildMetaOsDecisionsPresentation({
    actionNow: [rec],
    watching: [],
    nonSales: [],
    decisionReadModel: {
      source: { snapshotAsOf: null, engineVersion: null },
      queue: { sections: {} },
      structure: { entities: [] },
    },
    currency: "USD",
    generatedAt: "2026-09-03T00:00:00.000Z",
  } as never);
  return (
    served.structure?.groups?.[0]?.campaign?.campaignRoleTrustedForAction ??
    null
  );
}

const read = () =>
  readLatestMetaDecisionSnapshot({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    startDate: "2026-09-01",
    endDate: SNAPSHOT_DAY,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusinessCommercialTruthSnapshot).mockResolvedValue({
    targetPack: { targetRoas: 2.2, updatedAt: `${SNAPSHOT_DAY}T02:00:00.000Z` },
    sectionMeta: {
      targetPack: {
        freshness: { status: "fresh", updatedAt: `${SNAPSHOT_DAY}T02:00:00.000Z` },
      },
    },
  } as Awaited<ReturnType<typeof getBusinessCommercialTruthSnapshot>>);
});

describe("a stale persisted campaignKind through the snapshot read", () => {
  const REFUSED: Array<[string, Record<string, unknown>]> = [
    ["no context row at all", { __absent: true }],
    ["medium inference confidence", { inferenceConfidenceClass: "medium" }],
    ["an unvalidated resolver identity", { resolverAuthorityValidated: false }],
    ["a resolver that reported no identity", { resolverAuthorityValidated: undefined }],
    ["medium context trust", { contextTrust: "medium" }],
    [
      "an operator override as the provenance",
      { provenance: { mode: "manual", source: "user_override", campaignId: CAMPAIGN } },
    ],
  ];

  for (const stale of ["mixed", "test", "main"]) {
    it.each(REFUSED)(
      `drops a persisted "${stale}" kind under %s`,
      async (_name, over) => {
        installDb(snapshotRow(stale));
        vi.mocked(campaignContextSource.readCampaignContextLabelMap)
          .mockResolvedValue(
            "__absent" in over ? (new Map() as never) : contextEntry(over),
          );

        const result = await read();
        const served = result?.recommendations[0] as MetaRecommendation;
        expect(served, "the row itself must still be served").toBeTruthy();
        expect(served.campaignKind).toBeUndefined();
      },
    );
  }

  it("does not turn a stale mixed into the Review Structure shape", async () => {
    /*
      The consequence, at the surface an operator reads.
      `metaOsActionShapeForRecommendation` answers `structure_review` on
      `campaignKind === "mixed"`, so a remembered `mixed` would tell an operator
      to restructure a campaign whose role the resolver has refused to state.
    */
    installDb(snapshotRow("mixed"));
    vi.mocked(campaignContextSource.readCampaignContextLabelMap).mockResolvedValue(
      contextEntry({ inferenceConfidenceClass: "medium" }),
    );

    const result = await read();
    const served = result?.recommendations[0] as MetaRecommendation;
    expect(served.campaignKind).toBeUndefined();
    /*
      The node must EXIST for these to mean anything: a builder that produced
      nothing would satisfy both `not.toBe` assertions while proving zero.
    */
    expect(servedActionLabel(served)).toBeTruthy();
    expect(servedActionLabel(served)).not.toBe("Review Structure");
    // And nothing on the served node claims the role is trusted for action.
    expect(servedRoleTrustedForAction(served)).toBe(false);
  });

  it("STILL attaches a trusted canonical mixed, which is what makes the drops discriminating", async () => {
    /*
      The control. Without it every assertion above would be satisfied by a
      guard that deleted `campaignKind` unconditionally — which would break the
      Review Structure shape for every correctly labelled mixed campaign.
    */
    installDb(snapshotRow("main"));
    vi.mocked(campaignContextSource.readCampaignContextLabelMap).mockResolvedValue(
      contextEntry({
        kind: "mixed",
        provenance: {
          mode: "automatic",
          source: "system_inferred",
          campaignId: CAMPAIGN,
          kind: "mixed",
          contextTrust: "high",
          sourceRecordType: "engine_v3_campaign_context_daily",
          sourceRecordId: `context-${CAMPAIGN}`,
          sourceAsOfDate: SNAPSHOT_DAY,
          sourceUpdatedAt: `${SNAPSHOT_DAY}T01:00:00.000Z`,
          sourceHash: "a".repeat(64),
        },
      }),
    );

    const result = await read();
    const served = result?.recommendations[0] as MetaRecommendation;
    // The TRUSTED map result wins over the stale stored "main".
    expect(served.campaignKind).toBe("mixed");
    expect(servedActionLabel(served)).toBe("Review Structure");
  });
});
