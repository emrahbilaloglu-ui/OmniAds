import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { getMetaAdDailySeries } from "@/lib/meta/warehouse";

import {
  buildMetaDecisionsWorkspaceReadModel,
  type MetaDecisionCampaignContextSourceRow,
  type MetaDecisionIdentitySourceRow,
  type MetaDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("db_touched");
  }),
}));

vi.mock("@/lib/db-schema-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db-schema-readiness")>()),
  assertDbSchemaReady: vi.fn(async () => undefined),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS: 2,
  // D074 authority gate: unset in production, so the honest mock default is
  // "not validated" — every inferred role caps at medium trust.
  isCampaignContextResolverAuthorityValidated: vi.fn(() => false),
}));

/**
 * CTR UNIT PARITY ACROSS DISTINCT OBSERVATIONS.
 *
 * The legacy creative-grain lifecycle scalar and the Ad-day warehouse trail
 * are both all-click CTR percentages. They are DIFFERENT observations: the
 * creative may be used by several ads, D107 can admit a shorter economic
 * decision window, and a later warehouse read has no decision authority.
 * A ratio/percent mismatch would still create a 100x display error, so this
 * test pins their units without claiming their values should match on a card.
 *
 * SETTLED FROM THE CODE, and pinned here so it cannot rot:
 *
 *   THE SCALAR. `engine_v3_creative_lifecycle_daily.ctr_28d`, written by the
 *   single production writer lib/creative-decision-engine/jobs/lifecycle-job.ts
 *   as SUM(clicks) / SUM(impressions) * 100 over meta_creative_daily. PERCENT.
 *   The legacy creative snapshot carries this lifecycle value as `ctr_28d`
 *   and the legacy bridge hands it through unscaled into `metrics.ctr`.
 *   Native Ad presentation instead reads its hash-bound admitted-window CTR;
 *   the creative lifecycle join is only for format and fatigue.
 *
 *   THE TRAIL. `meta_ad_daily.ctr`, whose single authorized writer is the
 *   authoritative insights sync (see lib/meta/ad-daily-write-ownership.test.ts)
 *   through `deriveWarehouseMetrics` in lib/api/meta.ts, as
 *   (clicks / impressions) * 100 rounded to 2 dp. PERCENT. `/api/meta/ads/series`
 *   returns the impression-weighted mean of those stored values and never
 *   rescales them.
 *
 * Their units agree. Two caveats remain:
 *
 *   1. The trail's per-day values are rounded to 2 dp before storage, so the
 *      weighted mean equals a same-population 28-day ratio only up to that
 *      rounding. Pinned below as a tolerance, not waved away.
 *   2. GRAIN, WINDOW AND AUTHORITY. The lifecycle scalar is creative-grain and
 *      legacy 28-day; the new card source read is ad-grain over explicit report
 *      dates. It selects finalized/passed warehouse rows, not the native
 *      decision's cutoff-admitted economic slice. The UI labels them apart.
 */

/** lib/api/meta.ts:590 — the rounding every stored daily CTR carries. */
function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

const LIFECYCLE_JOB = readFileSync(
  "lib/creative-decision-engine/jobs/lifecycle-job.ts",
  "utf8",
);
const INSIGHTS_SYNC = readFileSync("lib/api/meta.ts", "utf8");
const WAREHOUSE = readFileSync("lib/meta/warehouse.ts", "utf8");
const SERIES_ROUTE = readFileSync("app/api/meta/ads/series/route.ts", "utf8");
const READ_MODEL = readFileSync(
  "lib/meta/decisions-workspace-read-model.ts",
  "utf8",
);

describe("legacy creative CTR and supplemental Ad-day CTR share units, not authority", () => {
  it("writes the scalar as a percent of all clicks, in the one job that owns the column", () => {
    // The whole CASE expression behind `AS ctr_28d`, so the ×100 cannot be
    // deleted while some other ×100 elsewhere in the file keeps a loose grep
    // green.
    const expression = LIFECYCLE_JOB.match(
      /CASE\s*\n\s*WHEN SUM\(impressions\)[^]*?END AS ctr_28d/,
    )?.[0];
    expect(
      expression,
      "lib/creative-decision-engine/jobs/lifecycle-job.ts no longer computes ctr_28d in a CASE expression; re-settle the unit before trusting the CTR withholding",
    ).toBeTruthy();
    expect(expression).toContain("SUM(clicks)");
    expect(expression).toContain("* 100");
    // A RATIO would be the same expression without the multiplier. That is the
    // 100x error this pin exists to catch.
    expect(expression!.replace(/\s+/g, " ")).toMatch(
      /SUM\(clicks\).*NULLIF\(SUM\(impressions\).*\* 100/,
    );
  });

  it("writes every stored daily CTR as a percent of the same all-clicks measure", () => {
    // lib/api/meta.ts is the ONLY authorized writer of meta_ad_daily
    // (lib/meta/ad-daily-write-ownership.test.ts holds that separately), and
    // this is the expression it binds to the column.
    expect(INSIGHTS_SYNC.replace(/\s+/g, " ")).toContain(
      "const ctr = input.impressions > 0 ? r2((input.clicks / input.impressions) * 100) : null;",
    );
  });

  it("reads the stored trail back and serves it without rescaling", () => {
    // The warehouse read is a pass-through: Number(row.ctr), no arithmetic.
    expect(WAREHOUSE.replace(/\s+/g, " ")).toContain(
      "ctr: row.ctr == null ? null : Number(row.ctr),",
    );
    // The route weights by impressions and divides by the same weight. A ×100
    // or ÷100 anywhere in that arithmetic would silently redefine the axis.
    const routeMath = SERIES_ROUTE.replace(/\s+/g, " ");
    expect(routeMath).toContain(
      "bucket.ctrWeighted += row.ctr * row.impressions;",
    );
    expect(routeMath).toContain(
      "ctr: !bucket.ctrMissing && bucket.ctrWeight > 0 ? bucket.ctrWeighted / bucket.ctrWeight : null,",
    );
    expect(routeMath).toContain("bucket.ctrMissing = true;");
    expect(routeMath).not.toContain("bucket.ctrWeighted / bucket.ctrWeight * 100");
    expect(routeMath).not.toContain("bucket.ctrWeighted / bucket.ctrWeight / 100");
  });

  it("hands the served scalar to the payload unscaled", () => {
    // Behavioural, not textual: a served 2.41 must arrive as 2.41. A read model
    // that "normalised" the percent to a ratio would answer 0.0241 here and the
    // withholding's premise would be false from that commit on.
    const model = buildMetaDecisionsWorkspaceReadModel({
      businessId: "biz_1",
      providerAccountId: "act_1",
      snapshotRows: [snapshot("creative_1", { ctr_28d: 2.41 })],
      identityRows: [identity("creative_1")],
      campaignContextRows: [context()],
      generatedAt: "2026-07-10T12:00:00.000Z",
    });
    const decision = Object.values(model.queue.sections)
      .flatMap((section) => section.items)
      .find((item) => item.parentChain.creative?.id === "creative_1");
    expect(decision, "the legacy producer served no decision to read").toBeTruthy();
    expect(decision!.metrics.ctr).toBe(2.41);
    // The legacy bridge reads the scalar on its own snapshot. The native Ad
    // SQL must never project the creative-grain lifecycle scalar as its CTR.
    expect(READ_MODEL).toContain("ctr: finiteNumber(input.snapshot.ctr_28d),");
    expect(READ_MODEL).not.toContain("lifecycle.ctr_28d AS ctr_28d");
    expect(READ_MODEL).toContain("evaluation.creative_input_json -> 'ctr' AS decision_ctr");
    // The OS presentation carries the same number on to MetaOsDecisionMetrics
    // without touching it, so the scalar the queue would draw is this one.
    expect(
      readFileSync("lib/meta/decisions-os-presentation.ts", "utf8"),
    ).toContain("ctr: decision.metrics.ctr ?? null,");
  });

  it("keeps percentage units consistent for an identical synthetic one-ad population", () => {
    // This deliberately gives both measures the SAME synthetic 28 days to
    // isolate units and rounding. D107 need not admit those same days into a
    // real decision, so numerical equality here is not a UI equality claim.
    const days = Array.from({ length: 28 }, (_, index) => ({
      impressions: 4_000 + index * 137,
      clicks: 61 + (index % 7) * 13,
    }));
    const totalImpressions = days.reduce((sum, day) => sum + day.impressions, 0);
    const totalClicks = days.reduce((sum, day) => sum + day.clicks, 0);

    // lifecycle-job.ts: SUM(clicks) / SUM(impressions) * 100
    const scalarPercent = (totalClicks / totalImpressions) * 100;
    // lib/api/meta.ts stores r2((clicks / impressions) * 100) per ad-day;
    // the route returns the impression-weighted mean of those stored values.
    const weighted = days.reduce(
      (sum, day) => sum + r2((day.clicks / day.impressions) * 100) * day.impressions,
      0,
    );
    const trailAveragePercent = weighted / totalImpressions;

    expect(Math.abs(scalarPercent - trailAveragePercent)).toBeLessThan(0.005);

    // The inverse, stated so the size of the avoided error is on the record: if
    // either side had stored a ratio instead, the two numbers on one card would
    // differ by a factor of a hundred.
    const ifTheTrailHadStoredARatio = scalarPercent / (trailAveragePercent / 100);
    expect(ifTheTrailHadStoredARatio).toBeGreaterThan(99.9);
    expect(ifTheTrailHadStoredARatio).toBeLessThan(100.1);
  });

  it("keeps the legacy lifecycle pointer distinct from a scoped Ad-day read", async () => {
    /*
     * Exercise the actual warehouse reader with a tagged-SQL spy. A fixed
     * SELECT string missed the new source clock and said nothing about whether
     * this presentation read binds its business, account, ad and report dates
     * or requests only finalized/passed rows. The SQL is not executed by this
     * unit test; the exact-bound route and measured/missing behavior have their
     * own tests in app/api/meta/ads/series/route.test.ts.
     */
    expect(READ_MODEL).toContain(
      "ON lifecycle.id = snapshot.creative_evidence_lifecycle_row_id",
    );
    const tag = vi.fn(async (pieces: TemplateStringsArray, ...bound: unknown[]) => {
      const query = pieces.join(" ? ").replace(/\s+/g, " ");
      expect(query).toMatch(/FROM meta_ad_daily WHERE business_id = \?/);
      expect(query).toMatch(/ad_id = ANY\(\s*\?\s*::text\[\]\)/);
      expect(query).toMatch(/date >= \? AND date <= \?/);
      expect(query).toMatch(/provider_account_id = ANY\(\s*\?\s*::text\[\]\)/);
      expect(query).toMatch(/\?\s*::boolean = false OR \(truth_state = 'finalized' AND validation_status = 'passed'\)/);
      expect(bound).toEqual([
        "biz_1", ["ad_1"], "2026-07-01", "2026-07-28",
        ["act_1"], ["act_1"], true,
      ]);
      return [{
        ad_id: "ad_1", date: "2026-07-10", impressions: 100,
        clicks: 0, link_clicks: 0, reach: 90, frequency: 1.1,
        ctr: 0, source_updated_at: "2026-07-29T10:00:00Z",
      }];
    });
    vi.mocked(getDb).mockReturnValueOnce(tag as unknown as ReturnType<typeof getDb>);
    const rows = await getMetaAdDailySeries({
      businessId: "biz_1", providerAccountIds: ["act_1"],
      adIds: ["ad_1", "ad_1"], startDate: "2026-07-01",
      endDate: "2026-07-28", finalizedOnly: true,
    });
    expect(tag).toHaveBeenCalledOnce();
    expect(rows).toEqual([{
      adId: "ad_1", date: "2026-07-10", impressions: 100,
      clicks: 0, linkClicks: 0, reach: 90, frequency: 1.1,
      ctr: 0, sourceUpdatedAt: "2026-07-29T10:00:00Z",
    }]);
  });
});

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
    source: "system_inferred",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: "campaign-context-v2-account-scoped",
  };
}
