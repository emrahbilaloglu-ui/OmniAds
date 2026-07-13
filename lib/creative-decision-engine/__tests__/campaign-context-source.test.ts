import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readLabels: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

vi.mock("@/lib/meta/campaign-labels", () => ({
  readMetaCampaignLabels: mocks.readLabels,
}));

import {
  campaignContextProvenanceFor,
  readCampaignContextLabelMap,
  resolveCampaignContextMode,
} from "../campaign-context/source";

const LABEL = {
  businessId: "biz-1",
  campaignId: "campaign-override",
  kind: "test" as const,
  testDimension: "creative" as const,
  source: "user" as const,
  providerAccountId: "account-1",
  campaignName: "Creative test",
  labeledBy: "user-1",
  labeledAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-12T01:00:00.000Z",
};

describe("campaign context provenance", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.query.mockReset();
    mocks.readLabels.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds stable composite-record provenance without changing legacy label semantics", async () => {
    mocks.readLabels.mockResolvedValue([LABEL]);

    const result = await readCampaignContextLabelMap({
      businessId: "biz-1",
      campaignIds: [LABEL.campaignId],
      asOf: "2026-07-12",
      mode: "legacy_labels",
    });

    expect(result.get(LABEL.campaignId)).toMatchObject({
      kind: "test",
      testDimension: "creative",
      provenance: {
        mode: "legacy_labels",
        source: "legacy_label",
        sourceRecordType: "meta_campaign_label",
        sourceRecordId: "biz-1:campaign-override",
        sourceAsOfDate: "2026-07-10",
        sourceUpdatedAt: LABEL.updatedAt,
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps automatic inference review-only by default and lets an override win", async () => {
    mocks.readLabels.mockResolvedValue([LABEL]);
    mocks.query.mockResolvedValue([
      {
        source_record_id: "00000000-0000-4000-8000-000000000101",
        campaign_id: "campaign-inferred",
        source_as_of_date: "2026-07-12",
        inferred_kind: "main",
        confidence_score: 0.91,
        confidence_class: "high",
        resolver_version: "campaign-context-v1",
        kind_source: "system_inferred",
        kind_basis: "behavioral",
        source_updated_at: "2026-07-12 02:00:00+00",
      },
    ]);

    const result = await readCampaignContextLabelMap({
      businessId: "biz-1",
      campaignIds: ["campaign-inferred", LABEL.campaignId, "campaign-missing"],
      asOf: "2026-07-12",
      mode: "automatic",
    });

    expect(result.get("campaign-inferred")).toMatchObject({
      kind: "main",
      contextTrust: "medium",
      provenance: {
        mode: "automatic",
        source: "system_inferred",
        sourceRecordId: "00000000-0000-4000-8000-000000000101",
        sourceAsOfDate: "2026-07-12",
        sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.get(LABEL.campaignId)?.provenance.source).toBe(
      "user_override",
    );
    expect(result.get("campaign-missing")?.provenance).toMatchObject({
      mode: "automatic",
      source: "unknown",
      campaignId: "campaign-missing",
      sourceRecordId: null,
    });
  });

  it("represents no-campaign and missing-source cases explicitly", () => {
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

  it("defaults to automatic, preserves legacy rollback, and gates hard authority", async () => {
    expect(resolveCampaignContextMode()).toBe("automatic");
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "legacy_labels");
    expect(resolveCampaignContextMode()).toBe("legacy_labels");
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "automatic");
    vi.stubEnv("CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED", "1");
    mocks.readLabels.mockResolvedValue([]);
    mocks.query.mockResolvedValue([
      {
        source_record_id: "00000000-0000-4000-8000-000000000202",
        campaign_id: "campaign-ready",
        source_as_of_date: "2026-07-12",
        inferred_kind: "main",
        confidence_score: 0.94,
        confidence_class: "high",
        resolver_version: "campaign-context-v1",
        kind_source: "system_inferred",
        kind_basis: "behavioral",
        source_updated_at: "2026-07-12 02:00:00+00",
      },
    ]);

    const result = await readCampaignContextLabelMap({
      businessId: "biz-1",
      campaignIds: ["campaign-ready"],
      asOf: "2026-07-12",
    });

    expect(result.get("campaign-ready")?.contextTrust).toBe("high");
  });
});
