import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  buildMetaDecisionsWorkspaceReadModel,
  buildNativeMetaDecisionsWorkspaceReadModel,
  buildUnavailableMetaDecisionsWorkspaceReadModel,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("db_touched");
  }),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  isCampaignContextHardAuthorityEnabled: vi.fn(() => false),
}));

/**
 * THE LAW: `queue.deduplicationGrain` is "ad" IF AND ONLY IF `source.authority`
 * is "native_ad". Every other authority pairs with "creative".
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOT COUNT ANYTHING.
 *
 * The Decision page WITHHOLDS the grain, and the ground for withholding it is
 * this equivalence: the source provenance panel already prints the authority,
 * so the grain would be one fact in a second vocabulary. That ground is a claim
 * about lib/ code, and a withholding is only as honest as the claim under it.
 *
 * The proof that used to stand for it read the producer's SOURCE TEXT and
 * COUNTED: four grain writes, two "ad", two "creative", two native_ad
 * authorities. Counting is not the law. Swap two writes — set "ad" under the
 * unavailable authority and "creative" under the native one — and every count
 * is byte-for-byte identical while the equivalence is destroyed. The count
 * passed; the page's stated reason had become false; the operator would have
 * been told "the grain is the authority in other words" about a grain that
 * disagreed with the authority.
 *
 * So the pairing itself is what fails here. Each case below RUNS a producer and
 * reads BOTH fields off the model it returned, which is the only way the two
 * can be compared at all. The source read at the bottom does not count writes
 * for their own sake: it maps every write site to the function that owns it and
 * fails when a producer appears that no case above exercises, so a fifth writer
 * has to earn a behavioural case rather than inherit this one.
 *
 * If the equivalence ever legitimately ends — a producer that deduplicates ads
 * under a non-native authority, say — this file is where it is decided, and the
 * withholding in
 * components/meta/decision-center/decision-payload-coverage.test.ts must be
 * re-argued rather than inherited.
 */
function expectGrainPairsWithAuthority(
  model: MetaDecisionsWorkspaceReadModel,
  producer: string,
) {
  const grainIsAd = model.queue.deduplicationGrain === "ad";
  const authorityIsNative = model.source.authority === "native_ad";
  expect(
    grainIsAd,
    `${producer} served authority "${model.source.authority}" with grain "${model.queue.deduplicationGrain}"; ` +
      `the Decision page withholds the grain ONLY because "ad" means native_ad and "creative" means everything else`,
  ).toBe(authorityIsNative);
}

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
  return {
    provider_account_id: "act_1",
    creative_id: creativeId,
    creative_name: `Creative ${creativeId}`,
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_id: "120000000000000001",
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

function context(): MetaDecisionCampaignContextSourceRow {
  return {
    campaignId: "cmp_1",
    kind: "main",
    source: "persisted_label",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: "user",
  };
}

function nativeSnapshot(
  adId: string,
  overrides: Partial<MetaNativeDecisionSnapshotSourceRow> = {},
): MetaNativeDecisionSnapshotSourceRow {
  return {
    snapshot_id: `00000000-0000-4000-8000-${adId.slice(-12).padStart(12, "0")}`,
    evaluation_id: `10000000-0000-4000-8000-${adId.slice(-12).padStart(12, "0")}`,
    job_run_id: "20000000-0000-4000-8000-000000000001",
    provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
    provider_account_id: "act_1",
    ad_id: adId,
    creative_id: "creative_shared",
    as_of_date: "2026-07-12",
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "act_1",
    label: "cut",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: "cut",
    confidence: 88,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "Exact Ad evidence is below the account target.",
    spend: 120,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: "cut",
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: "2026-07-12T05:00:00.000Z",
    episode_started_at: "2026-07-12",
    lineage_valid: true,
    creative_name: "Shared creative",
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_name: `Ad ${adId}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: "https://cdn.example/shared.jpg",
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-12T04:00:00.000Z",
    ...overrides,
  };
}

function nativeModel(rows: readonly MetaNativeDecisionSnapshotSourceRow[]) {
  return buildNativeMetaDecisionsWorkspaceReadModel({
    businessId: "biz_1",
    providerAccountId: "act_1",
    generation: {
      jobRunId: "20000000-0000-4000-8000-000000000001",
      asOfDate: "2026-07-12",
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      manifestHash: hashAdDecisionIdentityManifest({
        businessId: "biz_1",
        providerAccountId: "act_1",
        asOfDate: "2026-07-12",
        adIds: rows.map((row) => row.ad_id).sort(),
      }),
      expectedAdCount: rows.length,
    },
    snapshotRows: rows,
    campaignContextRows: [context()],
    eventSourceAvailable: false,
    outcomeSourceAvailable: false,
    responseSourceAvailable: false,
    generatedAt: "2026-07-12T12:00:00.000Z",
  });
}

/**
 * One entry per PRODUCER, not per write site: the pairing is a property of the
 * model a producer returns, and a producer that writes the grain in two places
 * still has to return a paired model on both of its paths.
 */
const PRODUCERS: ReadonlyArray<{
  producer: string;
  path: string;
  build: () => MetaDecisionsWorkspaceReadModel;
}> = [
  {
    producer: "buildUnavailableMetaDecisionsWorkspaceReadModel",
    path: "no snapshot could be read",
    build: () =>
      buildUnavailableMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        code: "snapshot_unavailable",
        message: "No decision snapshot was readable for this account.",
        generatedAt: "2026-07-12T12:00:00.000Z",
      }),
  },
  {
    producer: "buildMetaDecisionsWorkspaceReadModel",
    path: "legacy creative-grain snapshot",
    build: () =>
      buildMetaDecisionsWorkspaceReadModel({
        businessId: "biz_1",
        providerAccountId: "act_1",
        snapshotRows: [snapshot("creative_1")],
        identityRows: [identity("creative_1")],
        campaignContextRows: [context()],
        generatedAt: "2026-07-10T12:00:00.000Z",
      }),
  },
  {
    producer: "buildNativeMetaDecisionsWorkspaceReadModel",
    path: "authoritative native generation containing zero ads",
    build: () => nativeModel([]),
  },
  {
    producer: "buildNativeMetaDecisionsWorkspaceReadModel",
    path: "authoritative native generation containing ads",
    build: () =>
      nativeModel([
        nativeSnapshot("120000000000000001"),
        nativeSnapshot("120000000000000002", {
          adset_id: "adset_2",
          adset_name: "Retargeting",
        }),
      ]),
  },
];

describe("deduplicationGrain is withheld only while it pairs with the served authority", () => {
  for (const { producer, path, build } of PRODUCERS) {
    it(`pairs grain with authority: ${producer} — ${path}`, () => {
      const model = build();
      expectGrainPairsWithAuthority(model, `${producer} (${path})`);
    });
  }

  it("reads the same two fields off one model, so a swap cannot hide behind the totals", () => {
    /*
     * The counting proof this replaces would pass unchanged if the unavailable
     * producer served grain "ad" and the native producer served "creative": the
     * totals are symmetric. This states the two ends of that swap explicitly,
     * as VALUES read off built models, where a swap has nowhere to hide.
     */
    const models = PRODUCERS.map(({ producer, path, build }) => ({
      producer,
      path,
      model: build(),
    }));

    expect(
      models.map(({ model }) => ({
        authority: model.source.authority,
        grain: model.queue.deduplicationGrain,
      })),
    ).toEqual([
      { authority: "unavailable", grain: "creative" },
      { authority: "legacy_creative", grain: "creative" },
      { authority: "native_ad", grain: "ad" },
      { authority: "native_ad", grain: "ad" },
    ]);

    // And the law restated as a set: no authority appears with both grains, and
    // no grain appears under two authority families.
    const grainsByAuthorityFamily = new Map<string, Set<string>>();
    for (const { model } of models) {
      const family =
        model.source.authority === "native_ad" ? "native_ad" : "not_native_ad";
      const grains = grainsByAuthorityFamily.get(family) ?? new Set<string>();
      grains.add(model.queue.deduplicationGrain);
      grainsByAuthorityFamily.set(family, grains);
    }
    expect([...(grainsByAuthorityFamily.get("native_ad") ?? [])]).toEqual([
      "ad",
    ]);
    expect([...(grainsByAuthorityFamily.get("not_native_ad") ?? [])]).toEqual([
      "creative",
    ]);
  });

  it("leaves no grain write in a producer no case above runs", () => {
    /*
     * NOT a count for its own sake. Each write site is attributed to the
     * function that contains it, and the set of owning functions must be
     * exactly the set of producers the behavioural cases build. A fifth writer
     * inside a new function therefore fails here — with the name of the
     * function that has to gain a case — instead of riding on an equivalence
     * nobody re-checked.
     */
    const source = readFileSync(
      "lib/meta/decisions-workspace-read-model.ts",
      "utf8",
    );
    const owners = new Set<string>();
    const writePattern = /deduplicationGrain\s*[:=]\s*"(?:ad|creative)"/g;
    for (const match of source.matchAll(writePattern)) {
      const before = source.slice(0, match.index);
      const declarations = [
        ...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm),
      ];
      const owner = declarations.at(-1)?.[1];
      expect(
        owner,
        `a deduplicationGrain write at offset ${match.index} sits outside any named function`,
      ).toBeTruthy();
      owners.add(owner!);
    }

    expect([...owners].sort()).toEqual(
      [...new Set(PRODUCERS.map(({ producer }) => producer))].sort(),
    );
  });
});
