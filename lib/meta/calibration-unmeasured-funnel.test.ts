/**
 * An ad-day with no `actions` array measured nothing, and must not become a 0%
 * funnel observation.
 *
 * `meta_ad_daily.payload_json` carries the provider's `actions` array or it
 * carries nothing. The SQL keeps "nothing" as NULL — but `toNumber(null)` was 0
 * one layer up, and `atc_rate_28d`, `thruplay_rate_28d` and
 * `engagement_rate_28d` are in `ZERO_INCLUSIVE_METRICS`, so `isNonNegativeFinite`
 * admitted that 0 as a real observation and fed it to the percentiles. Every
 * unmeasured ad-day was voting "0% add-to-cart rate" in the calibration those
 * percentiles produce.
 *
 * The distinction these cases protect is exactly the one the provider makes:
 *
 *   actions absent         -> nothing was observed        -> NOT a sample
 *   actions present, stage
 *   omitted or "0"         -> the stage happened 0 times  -> a real 0
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMetaCalibrationForBusiness } from "@/lib/meta/calibration";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn((callback: () => Promise<unknown>) => callback()),
}));

const db = await import("@/lib/db");

/** Eight adsets so the cohort clears its sample threshold. */
function rows(
  addToCart: number | null,
  postEngagement: number | null,
  /* atc_rate_28d is a mid_funnel metric; ADD_TO_CART is what selects it. */
  customEventType: string | null = "ADD_TO_CART",
) {
  return Array.from({ length: 8 }, (_, index) => ({
    account_id: "act_1",
    campaign_id: "cmp_1",
    adset_id: `adset_${index}`,
    optimization_goal: "PURCHASE",
    custom_event_type: customEventType,
    spend_28d: 100,
    revenue_28d: 400,
    conversions_28d: 4,
    impressions_28d: 1000,
    clicks_28d: 50,
    link_clicks_28d: 50,
    add_to_cart_28d: addToCart,
    initiate_checkout_28d: null,
    view_content_28d: null,
    landing_page_views_28d: null,
    thruplay_actions_28d: null,
    post_engagement_28d: postEngagement,
    leads_28d: null,
    spend_14d: 50,
    impressions_14d: 500,
    reach_14d: 400,
  }));
}

function sqlMock(metricRows: Array<Record<string, unknown>>) {
  const written: Array<Record<string, unknown>> = [];
  const route = (text: string) => {
    if (text.includes("GROUP BY adset.provider_account_id")) {
      return Promise.resolve(metricRows);
    }
    if (text.includes("WITH adset_samples")) {
      return Promise.resolve(
        Array.from({ length: 8 }, (_, index) => ({
          adset_id: `adset_${index}`,
          optimization_goal: "PURCHASE",
          custom_event_type: null,
          spend_28d: 100,
          impressions_28d: 1000,
        })),
      );
    }
    return Promise.resolve([]);
  };
  const tag = vi.fn((strings: TemplateStringsArray) =>
    route(strings.join("?")),
  ) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, params?: unknown[]) => {
    if (text.includes("jsonb_to_recordset")) {
      written.push(
        ...(JSON.parse(String(params?.[0] ?? "[]")) as Array<Record<string, unknown>>),
      );
      return Promise.resolve([]);
    }
    return route(text);
  }) as unknown as typeof tag.query;
  return { tag, written };
}

const metricNames = (written: Array<Record<string, unknown>>) =>
  new Set(written.map((row) => String(row.metric_name)));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NULL means unmeasured and never enters the sample", () => {
  it("writes no atc_rate_28d row when no ad-day carried an actions array", async () => {
    const sql = sqlMock(rows(null, null));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    // The pre-fix behaviour wrote a full percentile row here, every value 0.
    expect(metricNames(sql.written)).not.toContain("atc_rate_28d");
  });

  it("writes no engagement_rate_28d row when post_engagement was never measured", async () => {
    const sql = sqlMock(rows(null, null, "PAGE_ENGAGEMENT"));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(metricNames(sql.written)).not.toContain("engagement_rate_28d");
  });

  it("never calibrates thruplay, which has no source on this table at all", async () => {
    // No top-level thruplay_actions key and no `thruplay` action type exists in
    // any stored payload, so every ad-day is unmeasured for it.
    const sql = sqlMock(rows(25, 500));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(metricNames(sql.written)).not.toContain("thruplay_rate_28d");
    expect(metricNames(sql.written)).not.toContain("cost_per_thruplay_28d");
  });

  it("still calibrates a metric whose inputs were measured", async () => {
    // The control: without it, "writes nothing" would pass for the wrong reason.
    const sql = sqlMock(rows(25, 500));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(metricNames(sql.written)).toContain("atc_rate_28d");
  });
});

describe("a MEASURED zero is a measurement and does enter the sample", () => {
  it("keeps 0 add-to-carts when the provider reported the stage as zero", async () => {
    // actions present with the stage omitted is Meta's measured-zero encoding;
    // the SQL resolves that to 0, not NULL, and 0% is a real rate.
    const sql = sqlMock(rows(0, 0));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(metricNames(sql.written)).toContain("atc_rate_28d");
    const atc = sql.written.filter((row) => row.metric_name === "atc_rate_28d");
    expect(atc.length).toBeGreaterThan(0);
    for (const row of atc) expect(Number(row.p50)).toBe(0);
  });

  it("does not let one unmeasured adset drag a measured cohort to zero", async () => {
    // Mixed population: the unmeasured rows must be absent from the percentile,
    // not averaged into it as zeros.
    const mixed = [...rows(40, 800).slice(0, 4), ...rows(null, null).slice(4)];
    const sql = sqlMock(mixed);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    const atc = sql.written.filter((row) => row.metric_name === "atc_rate_28d");
    for (const row of atc) {
      expect(Number(row.sample_size)).toBe(4);
      expect(Number(row.p50)).toBeGreaterThan(0);
    }
  });
});

/*
  The WINDOW RULE, one level above the SQL.

  `readAggregatedAdsetMetricRows` groups by (goal, event) as well as by adset,
  so an adset whose goal changed inside the 28 days arrives as two rows that
  `mergeMetricRowsByAdset` folds back together. That fold used to be
  `toNumber(a) + toNumber(b)` for every field: NULL + NULL = 0 and NULL + 5 = 5,
  which re-created exactly the fabrications the SQL window had just refused.
  Each case below is one adset split across ADD_TO_CART and INITIATE_CHECKOUT
  (both mid_funnel, so both halves meet in the same cohort), eight times over so
  the cohort clears its sample threshold.
*/
type WindowHalf = { value: number | null; missingDays?: number | null };

function splitRows(left: WindowHalf, right: WindowHalf, linkClicks?: [WindowHalf, WindowHalf]) {
  const half = (
    index: number,
    customEventType: string,
    addToCart: WindowHalf,
    links: WindowHalf,
  ) => ({
    account_id: "act_1",
    campaign_id: "cmp_1",
    adset_id: `adset_${index}`,
    optimization_goal: "OFFSITE_CONVERSIONS",
    custom_event_type: customEventType,
    spend_28d: 50,
    revenue_28d: 200,
    conversions_28d: 2,
    impressions_28d: 500,
    clicks_28d: 25,
    link_clicks_28d: links.value,
    ...(links.missingDays === undefined
      ? {}
      : { link_clicks_28d_missing_days: links.missingDays }),
    add_to_cart_28d: addToCart.value,
    ...(addToCart.missingDays === undefined
      ? {}
      : { add_to_cart_28d_missing_days: addToCart.missingDays }),
    initiate_checkout_28d: null,
    view_content_28d: null,
    landing_page_views_28d: null,
    thruplay_actions_28d: null,
    post_engagement_28d: null,
    leads_28d: null,
    spend_14d: 25,
    impressions_14d: 250,
    reach_14d: 200,
  });
  const links = linkClicks ?? [
    { value: 10, missingDays: 0 },
    { value: 10, missingDays: 0 },
  ];
  return Array.from({ length: 8 }, (_, index) => [
    half(index, "ADD_TO_CART", left, links[0]),
    half(index, "INITIATE_CHECKOUT", right, links[1]),
  ]).flat();
}

async function atcRateRows(metricRows: Array<Record<string, unknown>>) {
  const sql = sqlMock(metricRows);
  vi.mocked(db.getDb).mockReturnValue(sql.tag);
  const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
  return {
    result,
    atc: sql.written.filter(
      (row) => row.metric_name === "atc_rate_28d" && row.scope_type === "account",
    ),
  };
}

describe("merging an adset's sub-windows keeps the window rule", () => {
  it("zero + zero stays a measured zero", async () => {
    const { result, atc } = await atcRateRows(
      splitRows({ value: 0, missingDays: 0 }, { value: 0, missingDays: 0 }),
    );
    // Both halves folded into one sample per adset, not two.
    expect(result.sampleRowsByCohort.mid_funnel).toBe(8);
    expect(atc).toHaveLength(1);
    expect(Number(atc[0]!.sample_size)).toBe(8);
    expect(Number(atc[0]!.p50)).toBe(0);
  });

  it("zero + an incomplete half is NULL, never a confident zero", async () => {
    const { atc } = await atcRateRows(
      splitRows({ value: 0, missingDays: 0 }, { value: null, missingDays: 2 }),
    );
    // The pre-fix fold wrote a full percentile row here, every value 0%.
    expect(atc).toHaveLength(0);
  });

  it("a measured value + an incomplete half is NULL, never the partial sum", async () => {
    const { atc } = await atcRateRows(
      splitRows({ value: 12, missingDays: 0 }, { value: null, missingDays: 1 }),
    );
    expect(atc).toHaveLength(0);
  });

  it("a measured value + an empty half (only inert days, nothing missing) keeps the value", async () => {
    // The over-correction guard: an inert sub-window is not a gap, so it must
    // not erase a complete measurement. 5 add-to-carts over 1,000 impressions.
    const { atc } = await atcRateRows(
      splitRows({ value: 5, missingDays: 0 }, { value: null, missingDays: 0 }),
    );
    expect(atc).toHaveLength(1);
    expect(Number(atc[0]!.sample_size)).toBe(8);
    expect(Number(atc[0]!.p50)).toBe(0.5);
  });

  it("fails closed when a NULL half's completeness is unknown", async () => {
    const { atc } = await atcRateRows(
      splitRows({ value: 5, missingDays: 0 }, { value: null }),
    );
    expect(atc).toHaveLength(0);
  });

  it("refuses a value that arrives beside a positive missing-day count", async () => {
    // A sum over a window that skipped delivered days is partial, whoever
    // produced the row.
    const { atc } = await atcRateRows(
      splitRows({ value: 5, missingDays: 3 }, { value: 5, missingDays: 0 }),
    );
    expect(atc).toHaveLength(0);
  });

  it("never reads a malformed count as a measured zero", async () => {
    // `Number("")` is 0 and `Number(true)` is 1: the old reader turned both
    // into confident counts. A malformed value stays missing (R4).
    for (const malformed of ["", "   ", true, "12abc", -4]) {
      const sql = sqlMock(
        rows(null, null).map((row) => ({ ...row, add_to_cart_28d: malformed })),
      );
      vi.mocked(db.getDb).mockReturnValue(sql.tag);

      await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

      expect(metricNames(sql.written)).not.toContain("atc_rate_28d");
    }
  });
});

describe("link clicks follow the same window rule as every funnel stage", () => {
  function trafficRows(linkClicks: Array<number | null>) {
    return linkClicks.map((value, index) => ({
      ...rows(null, null, null)[0]!,
      adset_id: `traffic_${index}`,
      optimization_goal: "LINK_CLICKS",
      custom_event_type: null,
      link_clicks_28d: value,
    }));
  }

  it("writes no cost_per_link_click_28d row when the link-click window is NULL", async () => {
    // `toNumber(null)` used to make this 0 and the cost guard then skipped it
    // for the wrong reason; the control below shows the right reason.
    const sql = sqlMock(trafficRows(Array.from({ length: 8 }, () => null)));
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(metricNames(sql.written)).not.toContain("cost_per_link_click_28d");
    // ctr_28d comes from meta_adset_daily clicks and is still calibrated.
    expect(metricNames(sql.written)).toContain("ctr_28d");
  });

  it("calibrates cost_per_link_click_28d only from measured windows", async () => {
    const sql = sqlMock(
      trafficRows([20, 20, 20, 20, 20, 20, 20, 20, null, null]),
    );
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    const rowsWritten = sql.written.filter(
      (row) => row.metric_name === "cost_per_link_click_28d" && row.scope_type === "account",
    );
    expect(rowsWritten).toHaveLength(1);
    expect(Number(rowsWritten[0]!.sample_size)).toBe(8);
    expect(Number(rowsWritten[0]!.p50)).toBe(5);
  });

  /*
    LINK_CLICKS and LANDING_PAGE_VIEWS are both traffic goals, so an adset that
    switched between them inside the window arrives as two rows that meet in
    the traffic cohort — the one cohort that calibrates cost per link click.
  */
  function trafficSplitRows(left: WindowHalf, right: WindowHalf) {
    return splitRows({ value: null }, { value: null }, [left, right]).map((row) => ({
      ...row,
      optimization_goal:
        row.custom_event_type === "ADD_TO_CART" ? "LINK_CLICKS" : "LANDING_PAGE_VIEWS",
      custom_event_type: null,
    }));
  }

  async function costPerLinkClickRows(metricRows: Array<Record<string, unknown>>) {
    const sql = sqlMock(metricRows);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    return {
      result,
      cplc: sql.written.filter(
        (row) => row.metric_name === "cost_per_link_click_28d" && row.scope_type === "account",
      ),
    };
  }

  it("merges link-click halves complete-only: measured + incomplete is NULL", async () => {
    const { result, cplc } = await costPerLinkClickRows(
      trafficSplitRows({ value: 10, missingDays: 0 }, { value: null, missingDays: 1 }),
    );
    expect(result.sampleRowsByCohort.traffic).toBe(8);
    // The pre-fix fold wrote 10 + toNumber(null) = 10: half the window's link
    // clicks against all of its spend.
    expect(cplc).toHaveLength(0);
  });

  it("merges link-click halves complete-only: measured + measured is the sum", async () => {
    // The control: 100 of spend over 10 + 10 link clicks.
    const { cplc } = await costPerLinkClickRows(
      trafficSplitRows({ value: 10, missingDays: 0 }, { value: 10, missingDays: 0 }),
    );
    expect(cplc).toHaveLength(1);
    expect(Number(cplc[0]!.sample_size)).toBe(8);
    expect(Number(cplc[0]!.p50)).toBe(5);
  });
});
