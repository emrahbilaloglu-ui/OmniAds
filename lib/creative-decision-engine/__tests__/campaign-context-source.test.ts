import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import {
  campaignContextProvenanceFor,
  readCampaignContextMap,
  resolveCampaignContextMode,
} from "../campaign-context/source";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "../campaign-context/resolver";
import {
  applyMetaCampaignLabelGuard,
  buildMetaCampaignLabelKindMap,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const INFERRED_ROW = {
  source_record_id: "00000000-0000-4000-8000-000000000101",
  provider_account_id: "act_1",
  campaign_id: "campaign-inferred",
  source_as_of_date: "2026-07-12",
  inferred_kind: "main",
  confidence_score: 0.91,
  confidence_class: "high",
  resolver_version: "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
  kind_source: "system_inferred",
  kind_basis: "behavioral",
  source_updated_at: "2026-07-12 02:00:00+00",
};

describe("automatic campaign context source", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses account-scoped system inference as the sole role source but withholds unvalidated hard authority", async () => {
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred", "campaign-missing"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")).toMatchObject({
      kind: "main",
      contextTrust: "medium",
      provenance: {
        mode: "automatic",
        source: "system_inferred",
        sourceRecordType: "engine_v3_campaign_context_daily",
        sourceRecordId: INFERRED_ROW.source_record_id,
        sourceAsOfDate: "2026-07-12",
        sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.get("campaign-missing")?.provenance).toMatchObject({
      mode: "automatic",
      source: "unknown",
      campaignId: "campaign-missing",
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      "provider_account_id IS NOT NULL",
    );
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      "biz-1",
      ["campaign-inferred", "campaign-missing"],
      "2026-07-12",
      2,
      "act_1",
    ]);
  });

  it("grants high trust only to the exact independently approved resolver version", async () => {
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
    );
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")?.contextTrust).toBe("high");
  });

  it("does not approve a stale persisted resolver when the current version is allowed", async () => {
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01",
    );
    mocks.query.mockResolvedValue([
      { ...INFERRED_ROW, resolver_version: "campaign-context-resolver.v1" },
    ]);

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-inferred")?.contextTrust).toBe("medium");
  });

  it("cannot restore manual labels through the legacy mode value", async () => {
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "legacy_labels");
    mocks.query.mockResolvedValue([INFERRED_ROW]);

    expect(resolveCampaignContextMode()).toBe("automatic");
    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
      mode: "legacy_labels",
    });
    expect(result.get("campaign-inferred")?.provenance.source).toBe(
      "system_inferred",
    );
  });

  it("keeps the emergency unknown mode fail-closed without a DB read", async () => {
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "unknown");
    expect(resolveCampaignContextMode()).toBe("unknown");

    const result = await readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["campaign-inferred"],
    });
    expect(result.size).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("fails closed when physical provider-account scope is missing", async () => {
    const result = await readCampaignContextMap({
      businessId: "biz-1",
      campaignIds: ["campaign-inferred"],
      asOf: "2026-07-12",
    });

    expect(result.size).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("represents missing campaign identity explicitly", () => {
    expect(
      campaignContextProvenanceFor({
        mode: "automatic",
        campaignId: null,
        entry: null,
      }),
    ).toEqual({
      mode: "automatic",
      source: "unknown",
      campaignId: null,
      kind: null,
      testDimension: null,
      contextTrust: null,
      sourceRecordType: null,
      sourceRecordId: null,
      sourceAsOfDate: null,
      sourceUpdatedAt: null,
      sourceHash: null,
    });
  });
});

// D081 Correction 6. These cases were first written as a throwaway probe that
// scored 10 failures out of 13 against the live reader. They live here now, at
// the same mocked-DB boundary the decisions jobs, ad-decisions, account pulse,
// lane classify and snapshot surfaces actually go through, so the reader can
// never drift back to trusting a normalised provenance string.
describe("readCampaignContextMap exact source and version provenance", () => {
  const AUTHORITY_ROW = {
    source_record_id: "00000000-0000-4000-8000-000000000101",
    provider_account_id: "act_1",
    campaign_id: "cmp-1",
    source_as_of_date: "2026-09-01",
    inferred_kind: "main",
    confidence_score: 0.91,
    confidence_class: "high",
    resolver_version: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    kind_source: "system_inferred",
    kind_basis: "behavioral",
    source_updated_at: "2026-09-01 02:00:00+00",
  };

  const row = (over: Record<string, unknown> = {}) => ({ ...AUTHORITY_ROW, ...over });

  const read = () =>
    readCampaignContextMap({
      businessId: "biz-1",
      providerAccountId: "act_1",
      campaignIds: ["cmp-1"],
      asOf: "2026-09-01",
    });

  // The real mapping snapshot.ts performs from reader output to guard input.
  const toGuardMap = (
    resolved: Awaited<ReturnType<typeof readCampaignContextMap>>,
  ) => {
    const context = new Map<string, MetaCampaignContextGuardEntry>();
    for (const [campaignId, entry] of resolved) {
      context.set(campaignId, {
        kind: entry.kind,
        contextTrust: entry.contextTrust ?? "unknown",
        source: entry.provenance.source,
        inferenceConfidenceClass: entry.inferenceConfidenceClass,
        resolverAuthorityValidated: entry.resolverAuthorityValidated,
      });
    }
    return context;
  };

  const hardActionRec = (): MetaRecommendation => ({
    id: "rec-1",
    level: "campaign",
    campaignId: "cmp-1",
    campaignName: "Campaign 1",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale this campaign",
    title: "Scale Campaign 1",
    why: "Campaign 1 is above the calibrated scale line.",
    summary: "Strong campaign.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [{ label: "ROAS", value: "4.00x", tone: "positive" }],
    timeframeContext: {
      coreVerdict: "Strong",
      selectedRangeOverlay: "Selected range supports scale.",
      historicalSupport: "History supports scale.",
      seasonalityFlag: "none",
      note: null,
    },
  });

  const guardFor = async () =>
    applyMetaCampaignLabelGuard({
      recommendations: [hardActionRec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: toGuardMap(await read()),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv(
      "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION",
      CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    );
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Positive control. Without this, every assertion below would also pass on a
  // reader that simply never grants authority to anything.
  it("grants high trust only for the exact automatic origin, class and identity", async () => {
    mocks.query.mockResolvedValue([row()]);

    const entry = (await read()).get("cmp-1");

    expect(entry).toMatchObject({
      kind: "main",
      contextTrust: "high",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true,
      provenance: { mode: "automatic", source: "system_inferred" },
    });

    const guard = await guardFor();
    expect(guard.downgradedCount).toBe(0);
    expect(guard.recommendations[0]?.decisionState).toBe("act");
  });

  it.each([
    "manual",
    "legacy_label",
    "user_override",
    "SYSTEM_INFERRED",
    " system_inferred",
    "system_inferred ",
    "",
    null,
  ])("never grants high trust to non-exact persisted kind_source %j", async (kindSource) => {
    mocks.query.mockResolvedValue([row({ kind_source: kindSource })]);

    const entry = (await read()).get("cmp-1");

    expect(entry?.contextTrust).not.toBe("high");
    expect(entry?.contextTrust).toBe("medium");
    // Never a synthesized origin: a non-exact source reports as unknown.
    expect(entry?.provenance.source).toBe("unknown");
  });

  it.each([
    ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}`,
    `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} `,
    CAMPAIGN_CONTEXT_RESOLVER_VERSION.toUpperCase(),
    "",
    null,
  ])(
    "never grants high trust to non-exact persisted resolver_version %j",
    async (resolverVersion) => {
      mocks.query.mockResolvedValue([row({ resolver_version: resolverVersion })]);

      const entry = (await read()).get("cmp-1");

      expect(entry?.contextTrust).not.toBe("high");
      expect(entry?.contextTrust).toBe("medium");
      expect(entry?.resolverAuthorityValidated).toBe(false);
    },
  );

  it.each([
    { label: "kind_source", over: { kind_source: " system_inferred" } },
    { label: "kind_source", over: { kind_source: "manual" } },
    {
      label: "resolver_version",
      over: { resolver_version: `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} ` },
    },
  ])(
    "keeps the downstream guard demoted when $label is not exact",
    async ({ over }) => {
      mocks.query.mockResolvedValue([row(over)]);

      const guard = await guardFor();

      expect(guard.downgradedCount).toBe(1);
      expect(guard.recommendations[0]).toMatchObject({
        decisionState: "watch",
        automationReadiness: { autoExecuteEligible: false },
      });
    },
  );

  it("binds the raw provenance strings into the source hash", async () => {
    const variants = [
      {},
      { kind_source: " system_inferred" },
      { kind_source: "system_inferred " },
      { kind_source: "SYSTEM_INFERRED" },
      { kind_source: "" },
      { resolver_version: ` ${CAMPAIGN_CONTEXT_RESOLVER_VERSION}` },
      { resolver_version: `${CAMPAIGN_CONTEXT_RESOLVER_VERSION} ` },
    ];

    const hashes: string[] = [];
    for (const over of variants) {
      mocks.query.mockResolvedValue([row(over)]);
      const hash = (await read()).get("cmp-1")?.provenance.sourceHash;
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      hashes.push(hash as string);
    }

    // No whitespace or case variant may hash identically to the exact value,
    // or to another variant.
    expect(new Set(hashes).size).toBe(variants.length);
  });
});
