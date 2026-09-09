import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { computeMetaAttributedAov } from "@/lib/creative-decision-engine/meta-aov-calculator";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  AnchorProfileDataSource,
  makeAnchorFlags,
  makeAnchorTargetPack,
} from "@/lib/creative-decision-engine/__tests__/anchor-profile-fixture";
import { makeAccountCalibration } from "@/lib/creative-decision-engine/__tests__/helpers";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const BUSINESS_ID = "d0000000-0000-4000-8000-000000000596";
const USER_ID = "d0000000-0000-4000-8000-000000000597";
const ACCOUNT_ID = "act_meta_aov_currency_596";
const AS_OF = "2026-09-05";
let providerAccountRefId = "";

describe.skipIf(!SEAM)("strict Meta AOV currency binding", () => {
  beforeAll(async () => {
    const sql = getDb();
    await sql.query(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1::uuid, 'meta-aov-currency@example.test', 'Meta AOV currency', 'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID],
    );
    await sql.query(
      `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
       VALUES ($1::uuid, 'Meta AOV currency', $2::uuid, 'UTC', 'USD', FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [BUSINESS_ID, USER_ID],
    );
    const [account] = await sql.query<{ id: string }>(
      `INSERT INTO provider_accounts
         (provider, external_account_id, account_name, currency, timezone)
       VALUES ('meta', $1, $1, 'USD', 'UTC')
       ON CONFLICT (provider, external_account_id)
       DO UPDATE SET currency = EXCLUDED.currency
       RETURNING id::text AS id`,
      [ACCOUNT_ID],
    );
    providerAccountRefId = account!.id;
    await sql.query(
      `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
          position, is_selected)
       VALUES ($1::text, 'meta', $2::uuid, $3, 0, TRUE)
       ON CONFLICT (business_id, provider, provider_account_ref_id)
       DO UPDATE SET provider_account_id = EXCLUDED.provider_account_id`,
      [BUSINESS_ID, providerAccountRefId, ACCOUNT_ID],
    );
    for (let index = 0; index < 20; index += 1) {
      await sql.query(
        `INSERT INTO meta_ad_daily
           (business_id, business_ref_id, provider_account_id, provider_account_ref_id,
            date, ad_id,
            account_timezone, account_currency, conversions, revenue,
            truth_state, validation_status, finalized_at, created_at, updated_at,
            metric_schema_version)
         VALUES ($1::text, $1::uuid, $2, $3::uuid, ($4::date - $5::integer), $6, 'UTC', 'usd',
                 1, 50, 'finalized', 'passed', '2026-09-05T02:00:00Z',
                 '2026-09-05T02:00:00Z', '2026-09-05T02:00:00Z', $7)
         ON CONFLICT (business_id, provider_account_id, date, ad_id)
         DO UPDATE SET provider_account_ref_id = EXCLUDED.provider_account_ref_id,
                       account_currency = EXCLUDED.account_currency,
                       conversions = EXCLUDED.conversions,
                       revenue = EXCLUDED.revenue,
                       metric_schema_version = EXCLUDED.metric_schema_version`,
        [
          BUSINESS_ID,
          ACCOUNT_ID,
          providerAccountRefId,
          AS_OF,
          index,
          `ad-aov-${index}`,
          META_CANONICAL_METRIC_SCHEMA_VERSION,
        ],
      );
    }
  });

  afterAll(async () => {
    if (!SEAM) return;
    const sql = getDb();
    await sql.query(`DELETE FROM meta_ad_daily WHERE business_id = $1::text`, [BUSINESS_ID]);
    await sql.query(`DELETE FROM business_provider_accounts WHERE business_id = $1::text`, [BUSINESS_ID]);
    await sql.query(`DELETE FROM businesses WHERE id = $1::uuid`, [BUSINESS_ID]);
    await sql.query(`DELETE FROM users WHERE id = $1::uuid`, [USER_ID]);
    await sql.query(`DELETE FROM provider_accounts WHERE id = $1::uuid`, [providerAccountRefId]);
  });

  async function read() {
    return computeMetaAttributedAov({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      asOf: AS_OF,
      db: getDb(),
    });
  }

  it("admits one normalized source currency equal to the bound account currency", async () => {
    await getDb().query(`UPDATE provider_accounts SET currency = 'USD' WHERE id = $1::uuid`, [providerAccountRefId]);
    await expect(read()).resolves.toMatchObject({
      aovMean: 50,
      purchaseCount: 20,
      totalRevenue: 1000,
    });
  });

  it("includes finalized facts at an exact microsecond cutoff and excludes the next microsecond", async () => {
    const sql = getDb();
    await sql.query(`UPDATE provider_accounts SET currency = 'USD' WHERE id = $1::uuid`, [providerAccountRefId]);
    await sql.query(
      `UPDATE meta_ad_daily SET finalized_at = '2026-09-05T03:00:00.000900Z'
       WHERE business_id = $1::text AND ad_id = 'ad-aov-19'`, [BUSINESS_ID],
    );
    try {
      for (const [asOf, purchaseCount] of [
        ["2026-09-05T03:00:00.000899999Z", 19],
        ["2026-09-05T03:00:00.000900Z", 20],
      ] as const) {
        await expect(computeMetaAttributedAov({
          businessId: BUSINESS_ID, providerAccountId: ACCOUNT_ID, asOf, db: sql,
        })).resolves.toMatchObject({ purchaseCount, totalRevenue: purchaseCount * 50 });
      }
    } finally {
      await sql.query(
        `UPDATE meta_ad_daily SET finalized_at = '2026-09-05T02:00:00Z'
         WHERE business_id = $1::text AND ad_id = 'ad-aov-19'`, [BUSINESS_ID],
      );
    }
  });

  it.each([
    ["missing", null],
    ["mismatch", "EUR"],
  ])("refuses %s bound account currency and holds Target-ROAS hard action", async (_name, currency) => {
    await getDb().query(`UPDATE provider_accounts SET currency = $2 WHERE id = $1::uuid`, [providerAccountRefId, currency]);
    const result = await read();
    expect(result).toMatchObject({ aovMean: null, purchaseCount: 0, totalRevenue: 0 });

    const profile = await resolveAccountDecisionProfile({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      dataSource: new AnchorProfileDataSource(
        makeAnchorTargetPack({ targetRoas: 2.2, breakEvenRoas: null }),
        makeAccountCalibration({
          metaAttributedAovMean90d: result.aovMean,
          metaAttributedAovPurchaseCount90d: result.purchaseCount,
          metaAttributedRevenue90d: result.totalRevenue,
          metaAovQuality: "unavailable",
        }),
      ),
      flags: makeAnchorFlags(),
      observedShopifyAov: null,
    });
    expect(profile.hardActionEligibility.cut).toBe(false);
    expect(profile.hardActionEligibility.codes?.cut).toBe("commercial_anchor_missing");
  });
});
