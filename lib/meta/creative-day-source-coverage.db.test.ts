/** Real PostgreSQL D101 seam. Never run against the configured production DB. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { READ_OUTCOME_SOURCE_ROWS_QUERY } from "@/lib/creative-decision-engine/jobs/decision-outcomes-job";
import { CREATIVE_OUTCOME_CLASSIFIER_VERSION } from "@/lib/creative-decision-engine/outcome-classifier";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { creativeDayCompleteWindowSql, creativeDayOutcomeSourceCoverageSql, creativeDaySourceCoverageSql } from "./creative-day-decision-admission";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const OWNER = "c2de0000-0000-4000-8000-0000000000b0";
const BUSINESS = "c2de0000-0000-4000-8000-0000000000b1";
const ACCOUNT = "act_creative_d101_seam";
const SHARED_CREATIVE_ACCOUNT = "act_creative_d101_shared";
const AS_OF = "2026-09-22";
// A recorded knowledge instant: after the last local day publication, before
// the late revisions deliberately tested below.
const EVALUATION_CUTOFF_AT = "2026-09-23T00:00:00.000Z";
const DAYS = ["2026-09-21", "2026-09-22"] as const;
const adId = (day: string) => `ad_${day}`;
const runId = (day: string) => `d101_${day}`;
const observedAt = (day: string) => `${day}T12:00:00.000Z`;
const publishedAt = (day: string) => `${day === DAYS[0] ? "2026-09-22" : "2026-09-23"}T00:00:00.000Z`;

async function insertCreative(day: string) {
  const isZeroSpendConversion = day === DAYS[0];
  const payload = {
    source_identity_version: "meta-creative-membership.v2",
    source_parent_grain_complete: true,
    source_ad_ids_complete: true,
    source_ad_ids: [adId(day)],
    source_creative_ids: ["cre_d101"],
    associated_ads_count: 1,
    source_membership_scope: "decision_bearing_ad_days",
    historical_config_provenance: "provider_receipt_day_bracketed",
    historical_config_proof: {
      knowledge_cutoff_at: "2026-09-22T12:00:00.000Z",
      last_receipt_observed_at: "2026-09-22T11:00:00.000Z",
      objective: "OUTCOME_SALES",
      optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE",
      custom_conversion_id: null,
    },
    custom_event_type: "PURCHASE",
  };
  await getDb().query(
    `INSERT INTO meta_creative_daily (
       business_id, business_ref_id, provider_account_id, date,
       campaign_id, adset_id, ad_id, creative_id, account_timezone,
       account_currency, objective, optimization_goal, spend, conversions,
       revenue, impressions, clicks, payload_json, created_at, updated_at
     ) VALUES ($1::text, $1::uuid, $2, $3::date, 'cmp_d101', 'set_d101', $4,
       'cre_d101', 'UTC', 'USD', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS',
       $5, 1, $6, $7, $8, $9::jsonb, $10::timestamptz, $10::timestamptz)`,
    [BUSINESS, ACCOUNT, day, adId(day), isZeroSpendConversion ? 0 : 20,
      isZeroSpendConversion ? 50 : 60, isZeroSpendConversion ? 0 : 1000,
      isZeroSpendConversion ? 0 : 30, JSON.stringify(payload), observedAt(day)],
  );
}

async function coverage() {
  const [row] = await getDb().query<{ source_ok: boolean; window_ok: boolean }>(
    `SELECT ${creativeDaySourceCoverageSql("d", "$2", "$3", 2)} AS source_ok,
            ${creativeDayCompleteWindowSql("d", "$2", "$3", 2)} AS window_ok
       FROM meta_creative_daily d
      WHERE d.business_id = $1 AND d.date = $2::date AND d.creative_id = 'cre_d101'`,
    [BUSINESS, AS_OF, EVALUATION_CUTOFF_AT],
  );
  return row;
}

async function setBasedCoverage(providerAccountScope: string | null = null) {
  const [row] = await getDb().query<{ source_ok: boolean; window_ok: boolean }>(
    `SELECT ${creativeDaySourceCoverageSql("d", "$2", "$5", 2, "$3", "$1")} AS source_ok,
            ${creativeDayCompleteWindowSql("d", "$2", "$5", 2, "$3", "$1")} AS window_ok
       FROM meta_creative_daily d
      WHERE d.business_id = $1 AND d.provider_account_id = $4
        AND d.date = $2::date AND d.creative_id = 'cre_d101'`,
    [BUSINESS, AS_OF, providerAccountScope, ACCOUNT, EVALUATION_CUTOFF_AT],
  );
  return row;
}

describe.skipIf(!SEAM)("creative-day D101 complete source coverage (real PostgreSQL)", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(`INSERT INTO users (id, name, email, password_hash)
      VALUES ($1::uuid, 'D101 seam', 'creative-d101@example.invalid', 'x')`, [OWNER]);
    await db.query(`INSERT INTO businesses (id, name, owner_id)
      VALUES ($1::uuid, 'D101 creative seam', $2::uuid)`, [BUSINESS, OWNER]);
    const [account] = await db.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, timezone, currency)
       VALUES ('meta', $1, 'UTC', 'USD') RETURNING id`, [ACCOUNT],
    );
    await db.query(`INSERT INTO business_provider_accounts
      (business_id, provider, provider_account_ref_id, provider_account_id, is_selected)
      VALUES ($1, 'meta', $2::uuid, $3, TRUE)`, [BUSINESS, account!.id, ACCOUNT]);
    for (const day of DAYS) {
      const zeroSpend = day === DAYS[0];
      await db.query(
        `INSERT INTO meta_ad_daily (
          business_id, provider_account_id, date, ad_id, account_timezone,
          account_currency, campaign_id, adset_id, spend, conversions,
          revenue, impressions, clicks, truth_state, validation_status,
          source_run_id, finalized_at, created_at, updated_at
        ) VALUES ($1, $2, $3::date, $4, 'UTC', 'USD', 'cmp_d101', 'set_d101',
          $5, 1, $6, $7, $8, 'finalized', 'passed', $9,
          $10::timestamptz, $10::timestamptz, $10::timestamptz)`,
        [BUSINESS, ACCOUNT, day, adId(day), zeroSpend ? 0 : 20,
          zeroSpend ? 50 : 60, zeroSpend ? 0 : 1000,
          zeroSpend ? 0 : 30, runId(day), observedAt(day)],
      );
      const [manifest] = await db.query<{ id: string }>(
        `INSERT INTO meta_authoritative_source_manifests (
           business_id, provider_account_id, day, surface, account_timezone,
           source_kind, source_window_kind, run_id, fetch_status,
           started_at, completed_at, created_at, updated_at
         ) VALUES ($1, $2, $3::date, 'account_daily', 'UTC', 'meta_insights',
           'complete_day', $4, 'completed', $5::timestamptz,
           $6::timestamptz, $6::timestamptz, $6::timestamptz) RETURNING id`,
        [BUSINESS, ACCOUNT, day, runId(day), observedAt(day), publishedAt(day)],
      );
      const [slice] = await db.query<{ id: string }>(
        `INSERT INTO meta_authoritative_slice_versions (
         business_id, provider_account_id, day, surface, manifest_id,
         candidate_version, state, truth_state, validation_status, status,
         source_run_id, staged_row_count, published_at, created_at, updated_at
       ) VALUES ($1, $2, $3::date, 'ad_daily', $4::uuid, 1,
           'finalized_verified', 'finalized', 'passed', 'published',
           $5, 1, $6::timestamptz, $6::timestamptz, $6::timestamptz) RETURNING id`,
        [BUSINESS, ACCOUNT, day, manifest!.id, runId(day), publishedAt(day)],
      );
      await db.query(
        `INSERT INTO meta_authoritative_publication_pointers (
           business_id, provider_account_id, day, surface,
           active_slice_version_id, published_by_run_id, publication_reason,
           published_at, created_at, updated_at
         ) VALUES ($1, $2, $3::date, 'ad_daily', $4::uuid, $5,
           'd101_seam', $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
        [BUSINESS, ACCOUNT, day, slice!.id, runId(day), publishedAt(day)],
      );
      await insertCreative(day);
    }
  });

  afterAll(async () => {
    if (!SEAM) return;
    const db = getDb();
    await db.query(`DELETE FROM meta_authoritative_publication_pointers WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM meta_authoritative_slice_versions WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM meta_authoritative_source_manifests WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM business_provider_accounts WHERE business_id = $1`, [BUSINESS]);
    await db.query(`DELETE FROM provider_accounts WHERE external_account_id = $1`, [ACCOUNT]);
    await db.query(`DELETE FROM businesses WHERE id = $1::uuid`, [BUSINESS]);
    await db.query(`DELETE FROM users WHERE id = $1::uuid`, [OWNER]);
  });

  it("admits a published full day including zero-spend conversion activity", async () => {
    expect(await coverage()).toEqual({ source_ok: true, window_ok: true });
    expect(await setBasedCoverage()).toEqual({ source_ok: true, window_ok: true });
  });

  it("does not infer account absence before its first observed economic Ad day", async () => {
    const [row] = await getDb().query<{ source_ok: boolean }>(
      `SELECT ${creativeDaySourceCoverageSql("d", "$2", "$3", 3, undefined, "$1")} AS source_ok
       FROM meta_creative_daily d
       WHERE d.business_id=$1 AND d.date=$2::date AND d.creative_id='cre_d101'`,
      [BUSINESS, AS_OF, EVALUATION_CUTOFF_AT],
    );
    expect(row?.source_ok).toBe(false);
  });

  it("rejects a surviving positive creative day with no economic source Ad-day", async () => {
    const db = getDb();
    await db.query(`UPDATE meta_ad_daily SET spend=0, conversions=0, revenue=0,
      impressions=0, clicks=0 WHERE business_id=$1 AND date=$2::date`, [BUSINESS, AS_OF]);
    try {
      expect(await coverage()).toEqual({ source_ok: false, window_ok: false });
      expect(await setBasedCoverage()).toEqual({ source_ok: false, window_ok: false });
    } finally {
      await db.query(`UPDATE meta_ad_daily SET spend=20, conversions=1, revenue=60,
        impressions=1000, clicks=30 WHERE business_id=$1 AND date=$2::date`, [BUSINESS, AS_OF]);
    }
  });

  it("detects an entirely unpublished later account day even when no economic Ad fact survives", async () => {
    const db = getDb();
    await db.query(`UPDATE meta_ad_daily SET spend=0, conversions=0, revenue=0,
      impressions=0, clicks=0 WHERE business_id=$1 AND date=$2::date`, [BUSINESS, AS_OF]);
    await db.query(`UPDATE meta_authoritative_publication_pointers
      SET published_at='2026-09-24T00:00:00.000Z'::timestamptz
      WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`, [BUSINESS, AS_OF]);
    try {
      expect(await coverage()).toEqual({ source_ok: false, window_ok: false });
      expect(await setBasedCoverage()).toEqual({ source_ok: false, window_ok: false });
    } finally {
      await db.query(`UPDATE meta_authoritative_publication_pointers
        SET published_at=$3::timestamptz WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`,
      [BUSINESS, AS_OF, publishedAt(AS_OF)]);
      await db.query(`UPDATE meta_ad_daily SET spend=20, conversions=1, revenue=60,
        impressions=1000, clicks=30 WHERE business_id=$1 AND date=$2::date`, [BUSINESS, AS_OF]);
    }
  });

  it("detects a source Ad-day whose creative day was entirely skipped", async () => {
    await getDb().query(`DELETE FROM meta_creative_daily WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[0]]);
    try {
      expect(await coverage()).toEqual({ source_ok: false, window_ok: false });
      expect(await setBasedCoverage()).toEqual({ source_ok: false, window_ok: false });
    }
    finally { await insertCreative(DAYS[0]); }
  });

  it("holds a shared creative when another account has an unverified day, while an explicit account scope remains usable", async () => {
    const db = getDb();
    const [account] = await db.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, timezone, currency)
       VALUES ('meta', $1, 'UTC', 'USD') RETURNING id`, [SHARED_CREATIVE_ACCOUNT],
    );
    await db.query(`INSERT INTO business_provider_accounts
      (business_id, provider, provider_account_ref_id, provider_account_id, is_selected)
      VALUES ($1, 'meta', $2::uuid, $3, TRUE)`, [BUSINESS, account!.id, SHARED_CREATIVE_ACCOUNT]);
    await db.query(`INSERT INTO meta_ad_daily (
      business_id, provider_account_id, date, ad_id, account_timezone,
      account_currency, campaign_id, adset_id, spend, conversions,
      revenue, impressions, clicks, truth_state, validation_status,
      source_run_id, finalized_at, created_at, updated_at
    ) VALUES ($1, $2, $3::date, 'ad_shared_unverified', 'UTC', 'USD',
      'cmp_shared', 'set_shared', 20, 1, 60, 1000, 30, 'finalized', 'passed',
      'run_shared_unverified', $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
      [BUSINESS, SHARED_CREATIVE_ACCOUNT, AS_OF, observedAt(AS_OF)]);
    await db.query(`INSERT INTO meta_creative_daily (
      business_id, business_ref_id, provider_account_id, date, campaign_id,
      adset_id, ad_id, creative_id, account_timezone, account_currency,
      objective, optimization_goal, spend, conversions, revenue, impressions,
      clicks, payload_json, created_at, updated_at
    ) VALUES ($1::text, $1::uuid, $2, $3::date, 'cmp_shared', 'set_shared',
      'ad_shared_unverified', 'cre_d101', 'UTC', 'USD', 'OUTCOME_SALES',
      'OFFSITE_CONVERSIONS', 20, 1, 60, 1000, 30, '{}'::jsonb,
      $4::timestamptz, $4::timestamptz)`,
      [BUSINESS, SHARED_CREATIVE_ACCOUNT, AS_OF, observedAt(AS_OF)]);
    try {
      expect(await setBasedCoverage()).toEqual({ source_ok: false, window_ok: false });
      expect(await setBasedCoverage(ACCOUNT)).toEqual({ source_ok: true, window_ok: true });
    } finally {
      await db.query(`DELETE FROM meta_creative_daily WHERE business_id=$1 AND provider_account_id=$2`, [BUSINESS, SHARED_CREATIVE_ACCOUNT]);
      await db.query(`DELETE FROM meta_ad_daily WHERE business_id=$1 AND provider_account_id=$2`, [BUSINESS, SHARED_CREATIVE_ACCOUNT]);
      await db.query(`DELETE FROM business_provider_accounts WHERE business_id=$1 AND provider_account_id=$2`, [BUSINESS, SHARED_CREATIVE_ACCOUNT]);
      await db.query(`DELETE FROM provider_accounts WHERE external_account_id=$1`, [SHARED_CREATIVE_ACCOUNT]);
    }
  });

  it("rejects a fabricated extra creative member", async () => {
    await getDb().query(`UPDATE meta_creative_daily SET payload_json =
      jsonb_set(jsonb_set(payload_json, '{source_ad_ids}', '["ad_2026-09-22","ad_ghost"]'::jsonb),
      '{associated_ads_count}', '2'::jsonb)
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1]]);
    try { expect((await coverage())?.source_ok).toBe(false); }
    finally { await getDb().query(`UPDATE meta_creative_daily SET payload_json =
      jsonb_set(jsonb_set(payload_json, '{source_ad_ids}', $3::jsonb),
      '{associated_ads_count}', '1'::jsonb)
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1], JSON.stringify([adId(DAYS[1])])]); }
  });

  it("rejects one source Ad claimed by two otherwise valid creative rows", async () => {
    await getDb().query(`INSERT INTO meta_creative_daily (
      business_id, business_ref_id, provider_account_id, date, campaign_id,
      adset_id, ad_id, creative_id, account_timezone, account_currency,
      objective, optimization_goal, spend, conversions, revenue, impressions,
      clicks, payload_json, created_at, updated_at
    ) SELECT business_id, business_ref_id, provider_account_id, date, campaign_id,
      adset_id, ad_id, 'cre_duplicate_claim', account_timezone, account_currency,
      objective, optimization_goal, 0, 0, 0, 0, 0,
      jsonb_set(payload_json, '{source_creative_ids}', '["cre_duplicate_claim"]'::jsonb),
      created_at, updated_at
      FROM meta_creative_daily WHERE business_id=$1 AND date=$2::date
        AND creative_id='cre_d101'`, [BUSINESS, DAYS[1]]);
    try { expect((await coverage())?.source_ok).toBe(false); }
    finally { await getDb().query(`DELETE FROM meta_creative_daily
      WHERE business_id=$1 AND creative_id='cre_duplicate_claim'`, [BUSINESS]); }
  });

  it("reconciles unrelated mixed-parent source groups without granting them decision authority", async () => {
    for (const [ad, campaign] of [["ad_mixed_a", "cmp_a"], ["ad_mixed_b", "cmp_b"]] as const) {
      await getDb().query(`INSERT INTO meta_ad_daily (
        business_id, provider_account_id, date, ad_id, account_timezone,
        account_currency, campaign_id, adset_id, spend, conversions,
        revenue, impressions, clicks, truth_state, validation_status,
        source_run_id, finalized_at, created_at, updated_at
      ) VALUES ($1,$2,$3::date,$4,'UTC','USD',$5,$5,5,0,0,100,1,
        'finalized','passed',$6,$7::timestamptz,$7::timestamptz,$7::timestamptz)`,
        [BUSINESS, ACCOUNT, DAYS[1], ad, campaign, runId(DAYS[1]), observedAt(DAYS[1])]);
    }
    await getDb().query(`INSERT INTO meta_creative_daily (
      business_id,business_ref_id,provider_account_id,date,creative_id,
      account_timezone,account_currency,spend,conversions,revenue,impressions,
      clicks,payload_json,created_at,updated_at
    ) VALUES ($1::text,$1::uuid,$2,$3::date,'cre_mixed','UTC','USD',
      10,0,0,200,2,$4::jsonb,$5::timestamptz,$5::timestamptz)`,
      [BUSINESS, ACCOUNT, DAYS[1], JSON.stringify({
        source_identity_version: "meta-creative-membership.v2",
        source_ad_ids_complete: true,
        source_ad_ids: ["ad_mixed_a", "ad_mixed_b"],
        source_creative_ids: ["cre_mixed"], associated_ads_count: 2,
        source_parent_grain_complete: false,
      }), observedAt(DAYS[1])]);
    await getDb().query(`UPDATE meta_authoritative_slice_versions SET staged_row_count=3
      WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`, [BUSINESS, DAYS[1]]);
    try { expect(await coverage()).toEqual({ source_ok: true, window_ok: true }); }
    finally {
      await getDb().query(`UPDATE meta_authoritative_slice_versions SET staged_row_count=1
        WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`, [BUSINESS, DAYS[1]]);
      await getDb().query(`DELETE FROM meta_creative_daily WHERE business_id=$1 AND creative_id='cre_mixed'`, [BUSINESS]);
      await getDb().query(`DELETE FROM meta_ad_daily WHERE business_id=$1 AND ad_id IN ('ad_mixed_a','ad_mixed_b')`, [BUSINESS]);
    }
  });

  it("rejects a shared creative with an unproved campaign/ad-set parent", async () => {
    await getDb().query(`UPDATE meta_creative_daily SET payload_json =
      jsonb_set(payload_json, '{source_parent_grain_complete}', 'false'::jsonb)
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1]]);
    try { expect(await coverage()).toEqual({ source_ok: true, window_ok: false }); }
    finally { await getDb().query(`UPDATE meta_creative_daily SET payload_json =
      jsonb_set(payload_json, '{source_parent_grain_complete}', 'true'::jsonb)
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1]]); }
  });

  it("rejects an Ad-day missing its own source run identity", async () => {
    await getDb().query(`UPDATE meta_ad_daily SET source_run_id=NULL
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[0]]);
    try { expect((await coverage())?.source_ok).toBe(false); }
    finally { await getDb().query(`UPDATE meta_ad_daily SET source_run_id=$3
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[0], runId(DAYS[0])]); }
  });

  it("rejects a missing D101 published source chain", async () => {
    await getDb().query(`UPDATE meta_authoritative_slice_versions SET validation_status='pending'
      WHERE business_id=$1 AND day=$2::date`, [BUSINESS, DAYS[0]]);
    try { expect((await coverage())?.source_ok).toBe(false); }
    finally { await getDb().query(`UPDATE meta_authoritative_slice_versions SET validation_status='passed'
      WHERE business_id=$1 AND day=$2::date`, [BUSINESS, DAYS[0]]); }
  });

  it("does not borrow a creative row revision made after the replay cutoff", async () => {
    await getDb().query(`UPDATE meta_creative_daily SET updated_at='2026-09-23T00:00:01Z'
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1]]);
    try { expect((await coverage())?.source_ok).toBe(false); }
    finally { await getDb().query(`UPDATE meta_creative_daily SET updated_at=$3::timestamptz
      WHERE business_id=$1 AND date=$2::date`, [BUSINESS, DAYS[1], observedAt(DAYS[1])]); }
  });

  it("parses the new-epoch outcome SQL against the migrated PostgreSQL schema", async () => {
    const rows = await getDb().query(READ_OUTCOME_SOURCE_ROWS_QUERY, [
      BUSINESS, AS_OF, [7, 14], 120, 10, CREATIVE_OUTCOME_CLASSIFIER_VERSION,
      ENGINE_VERSION, EVALUATION_CUTOFF_AT,
    ]);
    expect(rows).toEqual([]);
  });

  it("keeps outcome source unknown when a closed day is missing an expected Ad fact", async () => {
    const outcomeComplete = async () => {
      const [row] = await getDb().query<{ complete: boolean }>(
        `SELECT ${creativeDayOutcomeSourceCoverageSql("c", "$2", "$3")} AS complete
           FROM (SELECT $1::uuid AS business_ref_id, 'cre_d101'::text AS creative_id,
             '2026-09-20'::date AS decision_as_of_date, 2::integer AS outcome_window_days) c
          WHERE $2::date >= c.decision_as_of_date`,
        [BUSINESS, AS_OF, EVALUATION_CUTOFF_AT],
      );
      return row?.complete;
    };
    expect(await outcomeComplete()).toBe(true);
    await getDb().query(`UPDATE meta_authoritative_slice_versions SET staged_row_count=2
      WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`, [BUSINESS, DAYS[0]]);
    try { expect(await outcomeComplete()).toBe(false); }
    finally {
      await getDb().query(`UPDATE meta_authoritative_slice_versions SET staged_row_count=1
        WHERE business_id=$1 AND day=$2::date AND surface='ad_daily'`, [BUSINESS, DAYS[0]]);
    }
  });
});
