import { describe, expect, it, vi } from "vitest";
import {
  buildMetaDecisionsWorkspaceReadModel,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { readMetaPreCapAdCandidates } from "@/lib/meta/decisions-pre-cap-ad-candidates";
import { adOsLaneForCanonicalDecision } from "@/lib/meta/decisions-os-presentation";

vi.mock("@/lib/db", () => {
  const getDb = vi.fn();
  return {
    getDb,
    getDbWithTimeout: vi.fn(() => getDb()),
  };
});

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  isCampaignContextResolverAuthorityValidated: vi.fn(() => true),
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS: 2,
}));

/*
  The reader attaches the lane-relevant projection of EVERY pre-cap candidate
  as process-local metadata. The two row builders are verbatim copies from
  decisions-workspace-read-model.test.ts.
*/

function snapshot(
  creativeId: string,
  overrides: Partial<MetaDecisionSnapshotSourceRow> = {},
): MetaDecisionSnapshotSourceRow {
  return {
    snapshot_id: `snapshot-${creativeId}`,
    provider_account_id: "act_1",
    creative_id: creativeId,
    as_of_date: "2026-07-10",
    engine_version: "v3-test",
    scope_type: "account",
    scope_id: "*",
    label: "scale",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: null,
    confidence: 82,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 1.4,
    badges: [],
    reason: "Persisted winner evidence.",
    spend: 100,
    purchases: 8,
    roas: 2.8,
    recent7d_roas: 2.6,
    label_transform: null,
    blocked_action_type: null,
    computed_at: "2026-07-10T05:00:00.000Z",
    episode_started_at: "2026-07-08",
    ...overrides,
  };
}

function identity(
  creativeId: string,
  overrides: Partial<MetaDecisionIdentitySourceRow> = {},
): MetaDecisionIdentitySourceRow {
  const adId = `120000000${String(
    [...creativeId].reduce(
      (sum, character, index) => sum + character.charCodeAt(0) * (index + 1),
      0,
    ),
  ).padStart(9, "0")}`;
  return {
    provider_account_id: "act_1",
    creative_id: creativeId,
    creative_name: `Creative ${creativeId}`,
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_id: adId,
    ad_name: `Ad ${creativeId}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    candidate_ad_count: 1,
    currency: "USD",
    thumbnail_url: `https://cdn.example/${creativeId}.jpg`,
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-10T04:00:00.000Z",
    ...overrides,
  };
}

describe("the reader keeps the pre-cap lane population process-local", () => {
  const creatives = ["creative_a", "creative_b", "creative_c"];
  const model = buildMetaDecisionsWorkspaceReadModel({
    businessId: "biz_1",
    providerAccountId: "act_1",
    snapshotRows: creatives.map((id, index) =>
      snapshot(id, { label: index === 0 ? "cut" : "test_more", spend: 100 + index }),
    ),
    identityRows: creatives.map((id) => identity(id)),
    campaignContextRows: [],
    adCandidateLimit: 1,
  } as never);

  it("attaches every pre-cap candidate without widening the served payload", () => {
    const selected = model.queue.adCandidates?.items ?? [];
    const preCap = readMetaPreCapAdCandidates(model);
    expect(selected).toHaveLength(1);
    expect(model.queue.adCandidates?.eligiblePreCapCount).toBe(3);
    expect(preCap).toHaveLength(3);
    const descriptor = Object.getOwnPropertyDescriptor(
      model,
      Symbol.for("adsecute.meta.decisions.pre-cap-ad-candidates"),
    );
    expect(descriptor?.enumerable).toBe(false);
    // What the route serializes carries no trace of the projection.
    const wire = JSON.parse(JSON.stringify(model));
    expect(readMetaPreCapAdCandidates(wire)).toBeNull();
    expect(wire.queue.adCandidates.items).toHaveLength(1);
  });

  it("projects only lane inputs, and they classify exactly like the full decision", () => {
    const preCap = readMetaPreCapAdCandidates(model) ?? [];
    const full = model.queue.adCandidates?.items[0];
    const projected = preCap.find((item) => item.decisionId === full?.decisionId);
    expect(projected).toBeDefined();
    // Metrics, media and history never ride along.
    expect(Object.keys(projected!)).not.toContain("metrics");
    expect(Object.keys(projected!)).not.toContain("media");
    for (const eligibility of [
      { scale: true, cut: true, refresh: true },
      { scale: false, cut: false, refresh: false },
    ]) {
      for (const degraded of [false, true]) {
        expect(adOsLaneForCanonicalDecision(projected!, eligibility, degraded)).toBe(
          adOsLaneForCanonicalDecision(full!, eligibility, degraded),
        );
      }
    }
  });
});
