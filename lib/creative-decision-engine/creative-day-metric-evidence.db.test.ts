/**
 * THE CREATIVE-DAY MEASUREMENT STAMP, PROVEN AGAINST A REAL POSTGRESQL.
 *
 * WHAT WAS WRONG. `jobs/lifecycle-job.ts` and `jobs/calibration-job.ts` read
 * the creative grain as `SUM(COALESCE(d.link_clicks, 0))` and
 * `SUM(COALESCE((payload_json->>'landing_page_views')::numeric, 0))` — and the
 * creative-day writer stores every one of those as a finite number whether or
 * not the provider reported anything. So "one measured zero day plus a day
 * nothing was observed" persisted as a confident `link_clicks_28d = 0`, an
 * omni-first alias fallback could replace the canonical count, a malformed
 * payload value could either become 0 or abort the whole job on the
 * `::numeric` cast, and "thumbstop" was video starts over impressions.
 *
 * WHAT THIS FILE PROVES, by writing rows through the SHIPPED writer
 * (`upsertMetaCreativeDailyRows`, including its same-creative-day fold) and
 * running the SHIPPED jobs and SQL against a freshly migrated database:
 *
 *   R1  zero + missing        -> NULL, at the creative-day AND the window level
 *   R2  zero + zero           -> 0 (and an idle unstamped day is not a gap)
 *   R3  aliases               -> the canonical alias only, never a sum or an
 *                                omni substitute, from raw insight to storage
 *   R4  malformed             -> NULL, and the job still succeeds
 *   R5  thumbstop / video     -> NULL, whatever the display payload says
 *   legacy                    -> an unstamped row is unmeasured, never 0
 *
 * and that the SQL value extraction agrees with its TypeScript twin on every
 * stored shape, including shapes the writer can never produce.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Registered in `scripts/ephemeral-postgres-migrations-check.ts` with its exact
 * passing count, so an all-skipped run cannot read as a pass.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { SUPPORTED_OBJECTIVES } from "@/lib/creative-decision-engine/config";
import { runCalibrationJob } from "@/lib/creative-decision-engine/jobs/calibration-job";
import {
  COMPUTE_LIFECYCLE_ROWS_QUERY,
  runLifecycleJob,
} from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import {
  META_CREATIVE_DAY_METRIC_EVIDENCE_KEY,
  META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
  buildMeasuredMetaCreativeDayMetricEvidence,
  buildMetaCreativeDayMetricEvidence,
  buildMetaCreativeDayMetricEvidenceLateralSql,
  buildMetaCreativeDayMetricEvidenceSql,
  readMetaCreativeDayStageValue,
  type MetaCreativeDayMetricStage,
} from "@/lib/meta/creative-day-metric-evidence";
import { toRawRow } from "@/lib/meta/creatives-row-mappers";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { upsertMetaCreativeDailyRows } from "@/lib/meta/warehouse";
import type { MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

/** Ids chosen not to collide with any other stage of the seam gate. */
const OWNER_ID = "c2de0000-0000-4000-8000-0000000000a0";
const LIFECYCLE_BUSINESS = "c2de0000-0000-4000-8000-0000000000a1";
const CALIBRATION_BUSINESS = "c2de0000-0000-4000-8000-0000000000a2";
const ACCOUNT_A = "act_creative_day_evidence_a";
const ACCOUNT_B = "act_creative_day_evidence_b";
const CALIBRATION_ACCOUNT = "act_creative_day_evidence_cal";
const AS_OF = "2026-08-20";

function day(offset: number) {
  const date = new Date(`${AS_OF}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

const ZERO_STAMP = {
  link_click: 0,
  landing_page_view: 0,
  add_to_cart: 0,
  initiate_checkout: 0,
  outbound_click: 0,
} as const;

function stamp(counts: Parameters<typeof buildMeasuredMetaCreativeDayMetricEvidence>[0]) {
  return {
    [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: buildMeasuredMetaCreativeDayMetricEvidence(counts),
  };
}

/**
 * The display scalars the writer has always put in the payload. Every row
 * carries them, set to numbers that would visibly move a reader that still
 * read them.
 */
const FABRICATED_DISPLAY = {
  creative_format: "video",
  landing_page_views: 40,
  add_to_cart: 11,
  initiate_checkout: 6,
  outbound_clicks: 9,
  thumbstop: 30,
  video25: 20,
  video50: 15,
  video75: 10,
  video100: 5,
};

function creativeDay(input: {
  businessId: string;
  account?: string;
  creativeId: string;
  adId?: string;
  date: string;
  idle?: boolean;
  linkClicksColumn?: number | null;
  conversions?: number;
  payloadJson: unknown;
}): MetaCreativeDailyRow {
  const idle = input.idle === true;
  return {
    businessId: input.businessId,
    providerAccountId: input.account ?? ACCOUNT_A,
    date: input.date,
    campaignId: "cmp_creative_day_evidence",
    adsetId: "adset_creative_day_evidence",
    adId: input.adId ?? `ad_${input.creativeId}`,
    creativeId: input.creativeId,
    creativeName: input.creativeId,
    headline: null,
    primaryText: null,
    destinationUrl: null,
    thumbnailUrl: null,
    assetType: "video",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    objective: "OUTCOME_SALES",
    effectiveStatus: "ACTIVE",
    creativeVisualFormat: "video",
    spend: idle ? 0 : 20,
    impressions: idle ? 0 : 1_000,
    clicks: idle ? 0 : 30,
    reach: idle ? 0 : 800,
    frequency: idle ? null : 1.25,
    conversions: idle ? 0 : (input.conversions ?? 1),
    revenue: idle ? 0 : 60,
    roas: idle ? 0 : 3,
    cpa: idle ? null : 20,
    ctr: idle ? null : 3,
    cpc: idle ? null : 0.66,
    // The display column, deliberately positive: a reader that still read it
    // would turn every missing stamp below into a number.
    linkClicks: input.linkClicksColumn === undefined ? 50 : input.linkClicksColumn,
    sourceSnapshotId: null,
    payloadJson: input.payloadJson,
  } as MetaCreativeDailyRow;
}

/**
 * One writer call per day. The writer's dimension upsert is keyed per creative,
 * so two days of one creative in a single call would hit the same dimension row
 * twice ("ON CONFLICT DO UPDATE command cannot affect row a second time") — the
 * sync never does that, because it writes one account-day at a time. Rows of
 * the SAME creative-day still go in together, which is what exercises the
 * writer's in-memory fold.
 */
async function writeByDay(rows: MetaCreativeDailyRow[]) {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  for (const date of dates) {
    await upsertMetaCreativeDailyRows(rows.filter((row) => row.date === date));
  }
}

async function seed() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1::uuid, 'Creative-day evidence seam', 'creative-day-evidence@example.invalid', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID],
  );
  for (const [businessId, name] of [
    [LIFECYCLE_BUSINESS, "Creative-day evidence lifecycle"],
    [CALIBRATION_BUSINESS, "Creative-day evidence calibration"],
  ] as const) {
    await db.query(
      `INSERT INTO businesses (id, name, owner_id) VALUES ($1::uuid, $2, $3::uuid)
       ON CONFLICT (id) DO NOTHING`,
      [businessId, name, OWNER_ID],
    );
    await db.query(
      `INSERT INTO business_engine_v3_flags (business_id, enabled, surface_visible, shadow_only)
       VALUES ($1::uuid, TRUE, TRUE, FALSE)
       ON CONFLICT (business_id) DO UPDATE SET enabled = TRUE`,
      [businessId],
    );
  }
  for (const [businessId, account] of [
    [LIFECYCLE_BUSINESS, ACCOUNT_A],
    [LIFECYCLE_BUSINESS, ACCOUNT_B],
    [CALIBRATION_BUSINESS, CALIBRATION_ACCOUNT],
  ] as const) {
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name)
       VALUES ('meta', $1, $1)
       ON CONFLICT (provider, external_account_id) DO UPDATE SET account_name = EXCLUDED.account_name
       RETURNING id`,
      [account],
    );
    await db.query(
      `INSERT INTO business_provider_accounts (
         business_id, provider, provider_account_ref_id, provider_account_id
       ) VALUES ($1, 'meta', $2, $3)
       ON CONFLICT DO NOTHING`,
      [businessId, row!.id, account],
    );
  }
}

async function cleanup() {
  const db = getDb();
  for (const businessId of [LIFECYCLE_BUSINESS, CALIBRATION_BUSINESS]) {
    await db.query(`DELETE FROM engine_v3_creative_lifecycle_daily WHERE business_ref_id = $1::uuid`, [businessId]);
    await db.query(`DELETE FROM engine_v3_account_calibration_daily WHERE business_ref_id = $1::uuid`, [businessId]);
    await db.query(`DELETE FROM engine_v3_job_runs WHERE business_ref_id = $1::uuid`, [businessId]);
    await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM meta_creative_dimensions WHERE business_id = $1`, [businessId]);
  }
}

/** The full writer chain for one ad-day: raw insight -> row -> persisted payload. */
function payloadFromInsight(insight: Parameters<typeof toRawRow>[0]) {
  const row = toRawRow(
    { ad_id: "ad_alias", ad_name: "Alias creative", spend: "20", impressions: "1000", ...insight },
    undefined,
    { id: ACCOUNT_A, name: "Evidence", currency: "USD" },
    new Map(),
    new Map(),
  );
  if (!row) throw new Error("toRawRow produced no row");
  return JSON.parse(
    JSON.stringify(
      buildMetaCreativeApiRow({
        row,
        cachedThumbnailUrl: null,
        cardFallbackThumbnailUrl: null,
        includeDebugFields: false,
      }),
    ),
  ) as Record<string, unknown>;
}

type LifecycleRow = {
  creative_id: string;
  link_clicks_28d: string | null;
  outbound_clicks_28d: number | null;
  landing_page_views_28d: number | null;
  add_to_cart_28d: number | null;
  initiate_checkout_28d: number | null;
  thumbstop_28d: number | null;
  video25_rate_28d: number | null;
  video50_rate_28d: number | null;
  video75_rate_28d: number | null;
  video100_rate_28d: number | null;
};

describe.skipIf(!SEAM)("creative-day measurement stamp (real PostgreSQL)", () => {
  let lifecycle = new Map<string, LifecycleRow>();
  let historical = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    await cleanup();
    await seed();

    const alias = payloadFromInsight({
      actions: [
        { action_type: "link_click", value: "10" },
        { action_type: "add_to_cart", value: "3" },
        { action_type: "omni_add_to_cart", value: "5" },
        { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: "3" },
        { action_type: "landing_page_view", value: "8" },
        { action_type: "omni_landing_page_view", value: "8" },
        { action_type: "initiate_checkout", value: "1" },
        { action_type: "omni_initiated_checkout", value: "6" },
      ],
      outbound_clicks: [
        { action_type: "outbound_click", value: "2" },
        { action_type: "omni_outbound_click", value: "9" },
      ],
      inline_link_clicks: "70",
      video_play_actions: [{ action_type: "video_view", value: "300" }],
    });
    // The display side still says what it always said; only the stamp is read.
    expect(alias.add_to_cart).toBe(5);

    await writeByDay([
      // R1: a measured-zero day and an ACTIVE day nothing was observed on.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_missing", date: day(0), payloadJson: { ...FABRICATED_DISPLAY, ...stamp(ZERO_STAMP) } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_missing", date: day(1), linkClicksColumn: 0, payloadJson: { ...FABRICATED_DISPLAY } }),
      // R2: two measured-zero days.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_zero", date: day(0), payloadJson: { ...FABRICATED_DISPLAY, ...stamp(ZERO_STAMP) } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_zero", date: day(1), payloadJson: { ...FABRICATED_DISPLAY, ...stamp(ZERO_STAMP) } }),
      // An IDLE unstamped day did nothing, so it is not a gap in the window.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_idle", date: day(0), payloadJson: { ...FABRICATED_DISPLAY, ...stamp(ZERO_STAMP) } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_zero_idle", date: day(1), idle: true, payloadJson: { ...FABRICATED_DISPLAY } }),
      // R3: the full writer chain from a raw insight carrying three spellings.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_alias", date: day(0), conversions: 2, payloadJson: alias }),
      // Legacy: never stamped, fabricated display numbers everywhere.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_legacy", date: day(0), payloadJson: { ...FABRICATED_DISPLAY } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_legacy", date: day(1), payloadJson: { ...FABRICATED_DISPLAY } }),
      // Per-day level: the same creative-day in two accounts.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, account: ACCOUNT_A, creativeId: "cre_two_accounts_partial", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 5 }) }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, account: ACCOUNT_B, creativeId: "cre_two_accounts_partial", date: day(0), payloadJson: { ...FABRICATED_DISPLAY } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, account: ACCOUNT_A, creativeId: "cre_two_accounts_full", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 5 }) }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, account: ACCOUNT_B, creativeId: "cre_two_accounts_full", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 7 }) }),
      // The writer's same-creative-day fold, inside ONE upsert call.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_writer_fold_full", adId: "ad_fold_1", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 4 }) }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_writer_fold_full", adId: "ad_fold_2", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 6 }) }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_writer_fold_partial", adId: "ad_fold_3", date: day(0), payloadJson: stamp({ ...ZERO_STAMP, link_click: 4 }) }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_writer_fold_partial", adId: "ad_fold_4", date: day(0), payloadJson: { ...FABRICATED_DISPLAY } }),
      // R4: stored after the write, below, as shapes the writer cannot produce.
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_malformed", date: day(0), payloadJson: { ...FABRICATED_DISPLAY } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_malformed", date: day(1), payloadJson: { ...FABRICATED_DISPLAY } }),
      creativeDay({ businessId: LIFECYCLE_BUSINESS, creativeId: "cre_malformed", date: day(2), payloadJson: { ...FABRICATED_DISPLAY } }),
    ]);

    const db = getDb();
    const malformedEvidence = buildMeasuredMetaCreativeDayMetricEvidence(ZERO_STAMP) as unknown as {
      stages: Record<string, unknown>;
    };
    malformedEvidence.stages.link_click = { state: "measured", value: "12abc" };
    malformedEvidence.stages.landing_page_view = { state: "measured", value: 7.5 };
    malformedEvidence.stages.add_to_cart = { state: "measured", value: -1 };
    malformedEvidence.stages.initiate_checkout = { state: "measured", value: 1e20 };
    malformedEvidence.stages.outbound_click = { state: "measured", value: { n: 1 } };
    await db.query(
      `UPDATE meta_creative_daily SET payload_json = $3::jsonb
        WHERE business_id = $1 AND creative_id = 'cre_malformed' AND date = $2::date`,
      [LIFECYCLE_BUSINESS, day(0), JSON.stringify({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: malformedEvidence })],
    );
    await db.query(
      `UPDATE meta_creative_daily SET payload_json = '"not an object"'::jsonb
        WHERE business_id = $1 AND creative_id = 'cre_malformed' AND date = $2::date`,
      [LIFECYCLE_BUSINESS, day(1)],
    );
    await db.query(
      `UPDATE meta_creative_daily SET payload_json = '{"metric_evidence": [1, 2]}'::jsonb
        WHERE business_id = $1 AND creative_id = 'cre_malformed' AND date = $2::date`,
      [LIFECYCLE_BUSINESS, day(2)],
    );

    const result = await runLifecycleJob({ businessId: LIFECYCLE_BUSINESS, asOf: AS_OF });
    expect(result.status, result.errorMessage).toBe("success");

    const rows = await db.query<LifecycleRow>(
      `SELECT creative_id, link_clicks_28d, outbound_clicks_28d, landing_page_views_28d,
              add_to_cart_28d, initiate_checkout_28d, thumbstop_28d, video25_rate_28d,
              video50_rate_28d, video75_rate_28d, video100_rate_28d
         FROM engine_v3_creative_lifecycle_daily
        WHERE business_ref_id = $1::uuid AND as_of_date = $2::date`,
      [LIFECYCLE_BUSINESS, AS_OF],
    );
    lifecycle = new Map(rows.map((row) => [row.creative_id, row]));

    const computed = await db.query<Record<string, unknown>>(COMPUTE_LIFECYCLE_ROWS_QUERY, [
      LIFECYCLE_BUSINESS,
      AS_OF,
      Array.from(SUPPORTED_OBJECTIVES),
    ]);
    historical = new Map(computed.map((row) => [String(row.creative_id), row]));
  }, 120_000);

  afterAll(async () => {
    if (SEAM) await cleanup();
  });

  const counts = (creativeId: string) => {
    const row = lifecycle.get(creativeId);
    if (!row) throw new Error(`no lifecycle row for ${creativeId}`);
    return {
      link_click: row.link_clicks_28d == null ? null : Number(row.link_clicks_28d),
      outbound_click: row.outbound_clicks_28d,
      landing_page_view: row.landing_page_views_28d,
      add_to_cart: row.add_to_cart_28d,
      initiate_checkout: row.initiate_checkout_28d,
    };
  };
  const ALL_NULL = {
    link_click: null,
    outbound_click: null,
    landing_page_view: null,
    add_to_cart: null,
    initiate_checkout: null,
  };

  it("R1: a measured-zero day plus an active unmeasured day is NULL, never 0 — per window and per day", () => {
    expect(counts("cre_zero_missing")).toEqual(ALL_NULL);
    // Per-day level: one account measured 5, the other account's row on the
    // SAME creative-day measured nothing. The day is incomplete, so the window is.
    expect(counts("cre_two_accounts_partial").link_click).toBeNull();
    // The historical click-to-purchase denominator obeys the same rule.
    expect(historical.get("cre_zero_missing")?.last14_click_to_purchase_rate).toBeNull();
    expect(historical.get("cre_zero_missing")?.all_history_click_to_purchase_rate).toBeNull();
  });

  it("R2: measured zeros stay 0, and an idle unstamped day is not a gap", () => {
    expect(counts("cre_zero_zero")).toEqual({ ...ZERO_STAMP });
    expect(counts("cre_zero_idle")).toEqual({ ...ZERO_STAMP });
    expect(counts("cre_two_accounts_full").link_click).toBe(12);
  });

  it("R3: the canonical alias is read from raw insight to storage — never omni, never a sum, never inline_link_clicks", () => {
    expect(counts("cre_alias")).toEqual({
      link_click: 10,
      outbound_click: 2,
      landing_page_view: 8,
      add_to_cart: 3,
      initiate_checkout: 1,
    });
    // 2 conversions over the 10 canonical link clicks.
    expect(Number(historical.get("cre_alias")?.last14_click_to_purchase_rate)).toBeCloseTo(0.2, 10);
  });

  it("R4: malformed stamps and payload shapes are missing, and the job did not abort", () => {
    expect(counts("cre_malformed")).toEqual(ALL_NULL);
  });

  it("legacy: an unstamped row is unmeasured, whatever its display column and payload scalars say", () => {
    expect(counts("cre_legacy")).toEqual(ALL_NULL);
    expect(historical.get("cre_legacy")?.last14_click_to_purchase_rate).toBeNull();
  });

  it("the writer's same-creative-day fold merges the stamp strictly on real storage", async () => {
    expect(counts("cre_writer_fold_full").link_click).toBe(10);
    expect(counts("cre_writer_fold_partial").link_click).toBeNull();
    const [stored] = await getDb().query<{ payload_json: unknown; link_clicks: string | null }>(
      `SELECT payload_json, link_clicks FROM meta_creative_daily
        WHERE business_id = $1 AND creative_id = 'cre_writer_fold_partial'`,
      [LIFECYCLE_BUSINESS],
    );
    // The display column still sums (50 + 50) exactly as it always did.
    expect(Number(stored?.link_clicks)).toBe(100);
    expect(readMetaCreativeDayStageValue(stored?.payload_json, "link_click")).toBeNull();
  });

  it("R5: thumbstop and every video rate are NULL for every creative", () => {
    expect(lifecycle.size).toBe(10);
    for (const row of lifecycle.values()) {
      expect([
        row.thumbstop_28d,
        row.video25_rate_28d,
        row.video50_rate_28d,
        row.video75_rate_28d,
        row.video100_rate_28d,
      ]).toEqual([null, null, null, null, null]);
    }
  });

  it("calibration takes funnel percentiles only from complete creatives and never invents a thumbstop", async () => {
    // 25 creatives measured every day: 100 link clicks, 20 add-to-carts.
    // 25 creatives whose one measured day (100 / 50) sits beside an ACTIVE
    // unmeasured day: a sum over the measured day alone would put 50% into the
    // pool. One creative carries malformed stamps only.
    const rows: MetaCreativeDailyRow[] = [];
    for (let index = 0; index < 25; index += 1) {
      const complete = `cal_complete_${String(index).padStart(2, "0")}`;
      const partial = `cal_partial_${String(index).padStart(2, "0")}`;
      for (const offset of [0, 1]) {
        rows.push(
          creativeDay({
            businessId: CALIBRATION_BUSINESS,
            account: CALIBRATION_ACCOUNT,
            creativeId: complete,
            date: day(offset),
            payloadJson: {
              ...FABRICATED_DISPLAY,
              ...stamp({ link_click: 50, landing_page_view: 40, add_to_cart: 10, initiate_checkout: 5, outbound_click: 50 }),
            },
          }),
        );
      }
      rows.push(
        creativeDay({
          businessId: CALIBRATION_BUSINESS,
          account: CALIBRATION_ACCOUNT,
          creativeId: partial,
          date: day(0),
          payloadJson: {
            ...FABRICATED_DISPLAY,
            ...stamp({ link_click: 100, landing_page_view: 90, add_to_cart: 50, initiate_checkout: 40, outbound_click: 100 }),
          },
        }),
        creativeDay({
          businessId: CALIBRATION_BUSINESS,
          account: CALIBRATION_ACCOUNT,
          creativeId: partial,
          date: day(1),
          payloadJson: { ...FABRICATED_DISPLAY },
        }),
      );
    }
    rows.push(
      creativeDay({
        businessId: CALIBRATION_BUSINESS,
        account: CALIBRATION_ACCOUNT,
        creativeId: "cal_malformed",
        date: day(0),
        payloadJson: { ...FABRICATED_DISPLAY },
      }),
    );
    await writeByDay(rows);
    await getDb().query(
      `UPDATE meta_creative_daily
          SET payload_json = jsonb_build_object('metric_evidence', jsonb_build_object(
            'version', $2::text,
            'funnelStageContractVersion', 'meta-funnel-stage.v1',
            'stages', jsonb_build_object(
              'link_click', jsonb_build_object('state', 'measured', 'value', '9e999'),
              'landing_page_view', jsonb_build_object('state', 'measured', 'value', 'NaN'),
              'add_to_cart', jsonb_build_object('state', 'measured', 'value', -3),
              'initiate_checkout', 'measured',
              'outbound_click', NULL)))
        WHERE business_id = $1 AND creative_id = 'cal_malformed'`,
      [CALIBRATION_BUSINESS, META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION],
    );

    const result = await runCalibrationJob({ businessId: CALIBRATION_BUSINESS, asOf: AS_OF });
    expect(result.status, result.errorMessage).toBe("success");

    const [overall] = await getDb().query<Record<string, unknown>>(
      `SELECT link_to_lpv_p25, link_to_lpv_p50, link_to_atc_p25, link_to_atc_p50,
              lpv_to_atc_p50, atc_to_ic_p50, ic_to_purchase_p50,
              click_to_purchase_p25, click_to_purchase_p50,
              thumbstop_p25, thumbstop_p50
         FROM engine_v3_account_calibration_daily
        WHERE business_ref_id = $1::uuid AND as_of_date = $2::date
          AND scope_type = 'account' AND scope_id = '*'
          AND campaign_kind = 'all' AND creative_format = 'overall'`,
      [CALIBRATION_BUSINESS, AS_OF],
    );
    expect(overall).toBeDefined();
    // Only the 25 complete creatives: 20 / 100, 80 / 100, 20 / 80, 10 / 20, 2 / 10.
    expect(Number(overall?.link_to_atc_p25)).toBeCloseTo(20, 8);
    expect(Number(overall?.link_to_atc_p50)).toBeCloseTo(20, 8);
    expect(Number(overall?.link_to_lpv_p25)).toBeCloseTo(80, 8);
    expect(Number(overall?.link_to_lpv_p50)).toBeCloseTo(80, 8);
    expect(Number(overall?.lpv_to_atc_p50)).toBeCloseTo(25, 8);
    expect(Number(overall?.atc_to_ic_p50)).toBeCloseTo(50, 8);
    expect(Number(overall?.ic_to_purchase_p50)).toBeCloseTo(20, 8);
    expect(Number(overall?.click_to_purchase_p50)).toBeCloseTo(2, 8);
    expect(overall?.thumbstop_p25).toBeNull();
    expect(overall?.thumbstop_p50).toBeNull();
  }, 120_000);

  it("the SQL extraction agrees with its TypeScript twin on every stored shape and never raises", async () => {
    const valid = (value: unknown, extra: Record<string, unknown> = {}) => {
      const evidence = buildMeasuredMetaCreativeDayMetricEvidence(ZERO_STAMP) as unknown as {
        stages: Record<string, unknown>;
      } & Record<string, unknown>;
      evidence.stages.link_click = { state: "measured", value };
      return JSON.stringify({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: { ...evidence, ...extra } });
    };
    const cases: Array<{ label: string; payload: string | null; expected: number | null }> = [
      { label: "measured 7", payload: valid(7), expected: 7 },
      { label: "measured 0", payload: valid(0), expected: 0 },
      { label: "max safe integer", payload: valid(9007199254740991), expected: 9007199254740991 },
      { label: "past max safe integer", payload: valid(9007199254740992), expected: null },
      { label: "exponent past the bound", payload: valid(1e20), expected: null },
      { label: "negative", payload: valid(-1), expected: null },
      { label: "fraction", payload: valid(7.5), expected: null },
      { label: "digit string", payload: valid("7"), expected: null },
      { label: "junk string", payload: valid("12abc"), expected: null },
      { label: "object value", payload: valid({ n: 7 }), expected: null },
      { label: "null value", payload: valid(null), expected: null },
      { label: "wrong version", payload: valid(7, { version: "meta-creative-day-metric-evidence.v0" }), expected: null },
      {
        label: "unmeasurable state",
        payload: JSON.stringify({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: buildMetaCreativeDayMetricEvidence({}) }),
        expected: null,
      },
      { label: "stages is a string", payload: JSON.stringify({ metric_evidence: { version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION, stages: "x" } }), expected: null },
      { label: "evidence is an array", payload: '{"metric_evidence": [1]}', expected: null },
      { label: "payload is a string", payload: '"text"', expected: null },
      { label: "payload is an array", payload: "[1, 2]", expected: null },
      { label: "payload is JSON null", payload: "null", expected: null },
      { label: "payload is SQL NULL", payload: null, expected: null },
      { label: "legacy display scalars only", payload: JSON.stringify({ link_clicks: 12, landing_page_views: 9 }), expected: null },
    ];

    const sql = buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: "fixture.payload" });
    const rows = await getDb().query<{ label: string; value: number | null; missing: boolean | null }>(
      `SELECT fixture.label,
              ${sql.valueSql("link_click")} AS value,
              ${sql.missingSql("link_click")} AS missing
         FROM jsonb_to_recordset($1::jsonb) AS input(label text, payload text)
         CROSS JOIN LATERAL (SELECT input.label, input.payload::jsonb AS payload) fixture`,
      [JSON.stringify(cases.map(({ label, payload }) => ({ label, payload })))],
    );
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    for (const testCase of cases) {
      const row = byLabel.get(testCase.label);
      expect(row, testCase.label).toBeDefined();
      const sqlValue = row!.value == null ? null : Number(row!.value);
      expect(sqlValue, `${testCase.label} (SQL)`).toBe(testCase.expected);
      expect(row!.missing, `${testCase.label} (missing is never NULL)`).toBe(testCase.expected === null);
      const tsValue = readMetaCreativeDayStageValue(
        testCase.payload === null ? null : JSON.parse(testCase.payload),
        "link_click",
      );
      expect(tsValue, `${testCase.label} (TypeScript twin)`).toBe(testCase.expected);
    }
  });

  it("the evaluated-once lateral returns exactly the builder's values over stored rows", async () => {
    const lateral = buildMetaCreativeDayMetricEvidenceLateralSql({
      payloadExpression: "d.payload_json",
      rowAlias: "d",
      lateralAlias: "creative_day_evidence",
    });
    const direct = buildMetaCreativeDayMetricEvidenceSql({ payloadExpression: "d.payload_json" });
    const stages: MetaCreativeDayMetricStage[] = [
      "link_click",
      "landing_page_view",
      "add_to_cart",
      "initiate_checkout",
      "outbound_click",
    ];
    const rows = await getDb().query<Record<string, unknown>>(
      `SELECT d.creative_id, d.date::text AS date, d.provider_account_id,
              ${stages.map((stage) => `${lateral.valueSql(stage)} AS lateral_${stage}, ${direct.valueSql(stage)} AS direct_${stage}`).join(",\n              ")},
              ${lateral.activitySql} AS active
         FROM meta_creative_daily d
         ${lateral.lateralSql}
        WHERE d.business_id = $1`,
      [LIFECYCLE_BUSINESS],
    );
    // 18 stored creative-days: the fold rows are two ad-rows each, merged into one.
    expect(rows.length).toBe(18);
    for (const row of rows) {
      for (const stage of stages) {
        expect(row[`lateral_${stage}`], `${row.creative_id} ${row.date} ${stage}`).toEqual(row[`direct_${stage}`]);
      }
      expect(typeof row.active).toBe("boolean");
    }
  });
});
