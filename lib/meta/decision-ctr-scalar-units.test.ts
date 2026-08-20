import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  isCampaignContextHardAuthorityEnabled: vi.fn(() => false),
}));

/**
 * THE UNIT UNDER THE CTR WITHHOLDING.
 *
 * The Decision page withholds the 28-day CTR SCALAR
 * (`MetaCanonicalDecision.metrics.ctr`, served on to `MetaOsDecisionMetrics.ctr`)
 * on the ground that the evidence window already draws "the same measure at
 * higher resolution" as a daily trail. That ground is an assumption about two
 * DIFFERENT columns written by two DIFFERENT producers, and nobody had checked
 * that they carry the same unit. If one stored a RATIO and the other a PERCENT
 * they differ by 100x, the stated reason would be false, and it would be
 * invisible today only because the scalar is not drawn — until the day someone
 * draws it beside the chart and the card contradicts itself.
 *
 * SETTLED FROM THE CODE, and pinned here so it cannot rot:
 *
 *   THE SCALAR. `engine_v3_creative_lifecycle_daily.ctr_28d`, written by the
 *   single production writer lib/creative-decision-engine/jobs/lifecycle-job.ts
 *   as SUM(clicks) / SUM(impressions) * 100 over meta_creative_daily. PERCENT.
 *   lib/meta/decisions-workspace-read-model.ts joins that exact row back by
 *   `creative_evidence_lifecycle_row_id` and hands the value through unscaled
 *   into `metrics.ctr`.
 *
 *   THE TRAIL. `meta_ad_daily.ctr`, whose single authorized writer is the
 *   authoritative insights sync (see lib/meta/ad-daily-write-ownership.test.ts)
 *   through `deriveWarehouseMetrics` in lib/api/meta.ts, as
 *   (clicks / impressions) * 100 rounded to 2 dp. PERCENT. `/api/meta/ads/series`
 *   returns the impression-weighted mean of those stored values and never
 *   rescales them.
 *
 * So the units agree, both are the ALL-CLICKS CTR, and the withholding's stated
 * reason survives on this axis. Two caveats a reader must keep, and the second
 * one qualifies the reason rather than supporting it:
 *
 *   1. The trail's per-day values are rounded to 2 dp before storage, so the
 *      weighted mean equals the 28-day ratio only up to that rounding. Pinned
 *      below as a tolerance, not waved away.
 *   2. GRAIN. The scalar is the CREATIVE's 28-day CTR (a creative-grain
 *      lifecycle row); the trail is the AD's daily CTR (meta_ad_daily, keyed by
 *      ad_id, and the queue looks it up by `decision.adId`). For an ad that is
 *      its creative's only ad they are the same population. For a creative
 *      running under several ads they are NOT, and "the same measure at higher
 *      resolution" is then loose: the scalar is not the drawn chart's own
 *      average. That does not reach an operator while the scalar is withheld,
 *      and it is exactly what must be re-argued before anyone renders it.
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

describe("the withheld 28d CTR scalar and the drawn daily trail carry the same unit", () => {
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
      "ctr: bucket.ctrWeight > 0 ? bucket.ctrWeighted / bucket.ctrWeight : null,",
    );
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
    // And the read model's own SQL takes it from the lifecycle row the engine
    // decided on, which is where the percent was written.
    expect(READ_MODEL).toContain("lifecycle.ctr_28d AS ctr_28d");
    expect(READ_MODEL).toContain("ctr: finiteNumber(input.snapshot.ctr_28d),");
    // The OS presentation carries the same number on to MetaOsDecisionMetrics
    // without touching it, so the scalar the queue would draw is this one.
    expect(
      readFileSync("lib/meta/decisions-os-presentation.ts", "utf8"),
    ).toContain("ctr: decision.metrics.ctr ?? null,");
  });

  it("makes the trail's own average equal the scalar, up to the stored rounding", () => {
    // 28 days is the window both sides claim; the shape is irrelevant, the
    // arithmetic is not.
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

  it("says out loud that the two are the same measure at DIFFERENT grains", () => {
    /*
     * The withholding says "the same measure at higher resolution". Resolution
     * is only half of it. The scalar comes from the creative-grain lifecycle row
     * the engine decided on; the trail comes from ad-grain warehouse rows keyed
     * by ad id. One creative under three ads has one scalar and three trails.
     * Whoever renders the scalar has to answer that first, and this pins both
     * halves of the mismatch so the answer cannot be assumed.
     */
    expect(READ_MODEL).toContain(
      "ON lifecycle.id = snapshot.creative_evidence_lifecycle_row_id",
    );
    const trailRead = WAREHOUSE.replace(/\s+/g, " ");
    expect(trailRead).toContain(
      "SELECT ad_id, date, impressions, clicks, link_clicks, reach, frequency, ctr FROM meta_ad_daily",
    );
    expect(trailRead).toContain("AND ad_id = ANY(${adIds}::text[])");
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
    source: "persisted_label",
    confidenceClass: "high",
    sourceUpdatedAt: "2026-07-09T10:00:00.000Z",
    resolverVersion: "user",
  };
}
