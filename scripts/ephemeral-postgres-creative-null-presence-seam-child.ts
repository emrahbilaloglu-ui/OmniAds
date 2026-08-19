/**
 * The null-versus-zero producer boundary, proven against REAL storage.
 *
 * A child of ephemeral-postgres-migrations-check: it refuses every database
 * except that parent's isolated, freshly migrated PostgreSQL.
 *
 * WHY THIS NEEDS A DATABASE. The whole contract rests on a claim about the
 * SCHEMA, not about TypeScript: that `meta_ad_daily` still distinguishes "the
 * account measured zero" from "the sync never captured this", so a sidecar built
 * from the read is built on something real. In memory that claim is unfalsifiable
 * — a hand-written `MetaAdDailyRow` says whatever the test author typed. Three
 * things have to be true against real storage:
 *
 *   1. `spend`, `impressions`, `clicks`, `conversions` and `revenue` are NOT NULL
 *      columns, so a written 0 comes back as 0 and MUST be reported as measured;
 *   2. a NULL `link_clicks`/`frequency` column and an absent `payload_json` key
 *      survive `getMetaAdDailyRange` as `null` rather than being coalesced to 0
 *      somewhere in the SQL or the row mapper — if they ever were, the sidecar
 *      would be derived from a fabricated number and would silently certify it;
 *   3. the presence map that the producer chain then builds off that read
 *      reaches `MetaCreativeApiRow` saying `false` for exactly the fields the
 *      database could not supply, while the legacy numeric fields stay put.
 *
 * DATABASE_URL is pre-set by the parent to the ephemeral server. Every write
 * here goes to that ephemeral database and nowhere else; the guard below is
 * what makes that a fact rather than an intention.
 */

import { getDb } from "@/lib/db";
import { runCalibrationJob } from "@/lib/creative-decision-engine/jobs/calibration-job";
import { runLifecycleJob } from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import { groupRows } from "@/lib/meta/creatives-row-mappers";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import {
  buildCreativeUsageMap,
  buildFallbackAdRawRow,
  coerceRawCreativeRow,
  hydrateWarehouseCreativeMetrics,
} from "@/lib/meta/creatives-warehouse";
import type { RawCreativeRow } from "@/lib/meta/creatives-types";
import { readMetaCreativeDimensions } from "@/lib/meta/request-model-store";
import type { MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";
import {
  getMetaAdDailyRange,
  getMetaCreativeDailyRange,
  upsertMetaAdDailyRows,
  upsertMetaCreativeDailyRows,
} from "@/lib/meta/warehouse";

const LABEL = "creative-null-presence-seam";
const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";

const BUSINESS_ID = "d1500000-0000-4000-8000-000000000150";
const OWNER_ID = "d1500000-0000-4000-8000-0000000001aa";
const PROVIDER_ACCOUNT_ID = "act_null_presence_seam";
const DAY = "2026-08-17";
const MEASURED_ZERO_AD_ID = "ad-null-presence-measured-zero";
const UNREAD_AD_ID = "ad-null-presence-unread";
const MEASURED_ZERO_CREATIVE_ID = "cre-null-presence-measured-zero";
const UNREAD_CREATIVE_ID = "cre-null-presence-unread";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (!Object.is(actual, expected)) {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertEphemeralMigratedDatabase() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") {
    throw new Error(
      "Refusing the null-versus-zero presence proof outside the ephemeral migration seam.",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || "5432");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (
    parsed.hostname !== "127.0.0.1" ||
    port === 5432 ||
    // 15432 is the local SSH tunnel to PRODUCTION. Named explicitly so this can
    // never be pointed at it by an inherited environment.
    port === 15432 ||
    databaseName !== EPHEMERAL_DB_NAME
  ) {
    throw new Error(
      "Refusing the null-versus-zero presence proof against a non-migrations-from-zero database.",
    );
  }
  return databaseUrl;
}

async function seedReferences() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'Null presence seam', 'null-presence@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1, 'Null presence seam', $2)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, OWNER_ID],
  );
  await db.query(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Null presence seam', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id) DO NOTHING`,
    [PROVIDER_ACCOUNT_ID],
  );
}

function baseAdDailyRow(overrides: Record<string, unknown>) {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: DAY,
    campaignId: "cmp-null-presence",
    adsetId: "adset-null-presence",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    metricSchemaVersion: 1,
    ...overrides,
  } as never;
}

async function main() {
  assertEphemeralMigratedDatabase();
  await seedReferences();

  // ------------------------------------------------------------------ write
  // Row A: a real all-zero day. The ad ran (or was paused) and measured
  // nothing. Every NOT NULL economic column is written as 0 on purpose.
  // Row B: the same shape, but with the nullable column left NULL and the
  // funnel keys absent from payload_json — exactly what a sync that never
  // captured them leaves behind.
  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: MEASURED_ZERO_AD_ID,
        adNameCurrent: "Measured zero",
        adStatus: "PAUSED",
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        frequency: 0,
        conversions: 0,
        revenue: 0,
        roas: 0,
        linkClicks: 0,
        payloadJson: {
          add_to_cart: 0,
          landing_page_views: 0,
          initiate_checkout: 0,
        },
      }),
      baseAdDailyRow({
        adId: UNREAD_AD_ID,
        adNameCurrent: "Unread funnel",
        adStatus: "ACTIVE",
        spend: 120.5,
        impressions: 5_000,
        clicks: 90,
        // Reach is unreported too, which is what leaves `frequency` genuinely
        // NULL rather than derived.
        reach: 0,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        linkClicks: null,
        // No funnel keys at all.
        payloadJson: { ad_id: UNREAD_AD_ID },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );

  // ------------------------------------------------------------------- read
  const factRows = await getMetaAdDailyRange({
    businessId: BUSINESS_ID,
    startDate: DAY,
    endDate: DAY,
    providerAccountIds: [PROVIDER_ACCOUNT_ID],
  });
  expectEqual(factRows.length, 2, "both fact rows read back");

  const measuredZero = factRows.find((row) => row.adId === MEASURED_ZERO_AD_ID);
  const unread = factRows.find((row) => row.adId === UNREAD_AD_ID);
  if (!measuredZero || !unread) fail("read back", "an expected ad row is missing");

  // 1. The NOT NULL columns really do come back as measured zeros.
  expectEqual(measuredZero.spend, 0, "measured zero spend survives as 0");
  expectEqual(measuredZero.impressions, 0, "measured zero impressions survives as 0");
  expectEqual(measuredZero.conversions, 0, "measured zero conversions survives as 0");
  expectEqual(measuredZero.linkClicks, 0, "a written link_clicks 0 stays 0");
  expectEqual(measuredZero.addToCart, 0, "a written add_to_cart 0 stays 0");

  // 2. NULL and absence survive the SQL and the row mapper as null. This is the
  //    assertion the sidecar is built on; if any of these ever read back as 0
  //    the presence map would certify a fabricated number.
  expectEqual(unread.frequency, null, "a NULL frequency column stays null");
  expectEqual(unread.addToCart, null, "an absent add_to_cart payload key stays null");
  expectEqual(
    unread.landingPageViews,
    null,
    "an absent landing_page_views payload key stays null",
  );
  expectEqual(
    unread.initiateCheckout,
    null,
    "an absent initiate_checkout payload key stays null",
  );
  expectEqual(unread.spend, 120.5, "the economic evidence beside it is intact");

  // 2b. THE FIX, formerly a PINNED DEFECT.
  //
  // Until 2026-08-19 this block asserted the opposite, on purpose, because the
  // distinction was destroyed at the WRITE and no sidecar downstream could
  // recover it. `meta_ad_daily.link_clicks` was `BIGINT NOT NULL DEFAULT 0`,
  // `upsertMetaAdDailyRows` bound `row.linkClicks ?? 0`, and the conflict clause
  // re-coalesced with a three-argument
  // `COALESCE(EXCLUDED.link_clicks, 0, meta_ad_daily.link_clicks)` whose middle
  // literal made the third argument unreachable — so an ad-day the provider
  // never reported was stored as a hard 0 and was thereafter identical to an ad
  // measured at zero link clicks. On production this is why `link_clicks IS
  // NULL` matched 0 of 12,667 rows in the last 30 days: the column was not
  // full, it was coalesced.
  //
  // Three changes make this row possible, and all three are load-bearing:
  //   lib/migrations.ts  ALTER TABLE meta_ad_daily ALTER COLUMN link_clicks
  //                      DROP NOT NULL  (widening only; no row rewritten)
  //   warehouse.ts:bind  `row.linkClicks ?? 0`  ->  `row.linkClicks ?? null`
  //   warehouse.ts:merge three-argument COALESCE -> two-argument
  //
  // A test that only checked the null would pass on a column that lost its
  // measurements, so the measured zero above (2a) is the other half and both
  // must hold at once.
  expectEqual(
    unread.linkClicks,
    null,
    "an unsupplied link_clicks stays NULL instead of being written as a measured 0",
  );

  await proveAdDailyLinkClicksStorage();

  // ------------------------------------------------- producer chain, verbatim
  // The same sequence `getMetaCreativesWarehousePayload` runs, on rows that came
  // out of PostgreSQL rather than out of a literal.
  const apiRowByAd = new Map<string, ReturnType<typeof buildMetaCreativeApiRow>>();
  for (const factRow of [measuredZero, unread]) {
    const rawRows: RawCreativeRow[] = [
      hydrateWarehouseCreativeMetrics({
        row: buildFallbackAdRawRow({
          factRow,
          projectionJson: null,
          creativeId: null,
        }),
        factRow,
      }),
    ];
    const grouped = groupRows(rawRows, "creative", buildCreativeUsageMap(rawRows));
    apiRowByAd.set(
      factRow.adId,
      buildMetaCreativeApiRow({
        row: grouped[0],
        cachedThumbnailUrl: null,
        cardFallbackThumbnailUrl: null,
        includeDebugFields: false,
      }),
    );
  }

  const zeroRow = apiRowByAd.get(MEASURED_ZERO_AD_ID)!;
  const unreadRow = apiRowByAd.get(UNREAD_AD_ID)!;

  // 3a. A measured zero is published as available. Withholding it would hide a
  //     fact: this ad genuinely delivered nothing.
  expectEqual(zeroRow.spend, 0, "measured-zero spend reaches the API row as 0");
  expectEqual(
    zeroRow.metric_presence?.spend,
    true,
    "measured-zero spend is published as available",
  );
  expectEqual(
    zeroRow.metric_presence?.link_clicks,
    true,
    "measured-zero link_clicks is published as available",
  );
  expectEqual(
    zeroRow.metric_presence?.add_to_cart,
    true,
    "a written add_to_cart 0 is published as available",
  );

  // 3b. The unread row publishes false for exactly the fields the database
  //     could not supply — and the legacy numbers are untouched beside them,
  //     which is what makes the sidecar additive rather than a re-typing.
  expectEqual(
    unreadRow.metric_presence?.add_to_cart,
    false,
    "an absent add_to_cart is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.landing_page_views,
    false,
    "an absent landing_page_views is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.frequency,
    false,
    "a NULL frequency is published as unavailable",
  );
  // The other half: the read CAN now tell this apart from a measured zero, so
  // the sidecar says so. Three cells on the Assets table divide by this column
  // — CTR, ATC rate and CVR — and each of them is withheld through the ratio
  // keys below rather than printed as a share of a number nobody measured.
  expectEqual(
    unreadRow.metric_presence?.link_clicks,
    false,
    "an unsupplied link_clicks is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.ctr_all,
    false,
    "CTR derived from an unsupplied link_clicks is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.cpc_link,
    false,
    "CPC (link) derived from an unsupplied link_clicks is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.click_to_atc,
    false,
    "click-to-ATC over an unsupplied link_clicks is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.thumbstop,
    false,
    "a manufactured thumbstop is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.spend,
    true,
    "the measured spend on the same row stays available",
  );
  expectEqual(unreadRow.add_to_cart, 0, "the legacy add_to_cart number is unchanged");
  expectEqual(unreadRow.spend, 120.5, "the legacy spend number is unchanged");

  // 3c. A ratio with a measured-zero denominator is undefined, not zero. This
  //     row spent $120.50 and bought nothing; CPA is a lower-is-better column,
  //     and `cpa: 0` made it the account's apparent leader.
  expectEqual(unreadRow.cpa, 0, "the legacy cpa number is unchanged");
  expectEqual(
    unreadRow.metric_presence?.cpa,
    false,
    "cpa over zero purchases is published as unavailable",
  );
  expectEqual(
    unreadRow.metric_presence?.cpm,
    true,
    "cpm over measured impressions stays available",
  );

  await proveCreativeGrain();
  await proveCreativeDailyLinkClicksStorage();
  await proveCreativeGrainEngineEquivalence();

  console.log(
    `[${LABEL}] PASS: NOT NULL zeros read back measured, NULL columns (link_clicks, frequency) and absent payload keys read back null, an unsupplied link_clicks survives the writer and the ON CONFLICT merge as NULL while a measured 0 stays 0, and the API row publishes availability per field — withholding CTR, CPC (link) and click-to-ATC with it — with the legacy numbers untouched, on the ad grain AND on the default creative grain the Assets table reads.`,
  );
}

/**
 * `meta_ad_daily.link_clicks` at the STORAGE layer, which is where the
 * distinction was being destroyed.
 *
 * Everything the producer chain asserts about this column is downstream of two
 * claims that only a real PostgreSQL can settle:
 *
 *   1. THE WIDENING IS A WIDENING. `DROP NOT NULL` enlarges the accepted set and
 *      touches no row. Asserting that in prose is worthless, so it is executed:
 *      rows are written while the column is NOT NULL (the pre-change schema,
 *      restored here with SET NOT NULL so the "before" is real rather than
 *      imagined), the widening statement is then run TWICE, and the same rows
 *      are re-read and compared value-for-value and type-for-type. Re-running
 *      also proves idempotency, which is what a redeploy and a from-zero build
 *      both depend on.
 *
 *   2. THE MERGE NO LONGER DESTROYS A MEASUREMENT. The old conflict clause was
 *      `COALESCE(EXCLUDED.link_clicks, 0, meta_ad_daily.link_clicks)`. Its
 *      middle argument is the literal 0, which is never NULL, so the third
 *      argument — "keep what is stored" — was unreachable: a re-sync that
 *      supplied nothing OVERWROTE a stored measurement with a fabricated zero.
 *      That is not a code-reading exercise, it is an ON CONFLICT execution, and
 *      it is run here against the real statement.
 *
 * Nothing in this function backfills, infers or rewrites a historical value.
 */
async function proveAdDailyLinkClicksStorage() {
  const db = getDb();
  const KEPT_AD_ID = "ad-null-presence-link-clicks-kept";
  const PRE_WIDENING_AD_ID = "ad-null-presence-pre-widening";

  const columnNullability = async () => {
    const rows = await db.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'meta_ad_daily' AND column_name = 'link_clicks'`,
      [],
    );
    return rows[0] ?? null;
  };

  const storedLinkClicks = async (adId: string) => {
    const rows = await db.query<{ link_clicks: string | number | null }>(
      `SELECT link_clicks FROM meta_ad_daily
        WHERE business_id = $1 AND provider_account_id = $2 AND date = $3::date AND ad_id = $4`,
      [BUSINESS_ID, PROVIDER_ACCOUNT_ID, DAY, adId],
    );
    if (rows.length === 0) fail("stored link_clicks", `no row for ${adId}`);
    const value = rows[0]!.link_clicks;
    return value == null ? null : Number(value);
  };

  // ── 1. The migration landed ────────────────────────────────────────────────
  const afterMigration = await columnNullability();
  expectEqual(
    afterMigration?.is_nullable,
    "YES",
    "the migration widened meta_ad_daily.link_clicks to accept NULL",
  );
  // The DEFAULT is deliberately untouched. It applies only to an INSERT that
  // OMITS the column, and every writer in the repo names it, so it is
  // unreachable from the sync path — but it is asserted rather than assumed,
  // because a silently dropped default would change what an omitting INSERT
  // stores.
  expectEqual(
    afterMigration?.column_default,
    "0",
    "the column keeps DEFAULT 0 for an INSERT that omits it entirely",
  );

  // ── 2. A measurement written under the PRE-CHANGE schema ───────────────────
  // Restoring NOT NULL is what makes "before" real. It can only succeed while
  // no NULL exists, so the earlier unread row is removed first and re-created
  // after — this is an ephemeral database created by the parent harness for
  // this run and nothing outside it is touched.
  await db.query(
    `DELETE FROM meta_ad_daily WHERE business_id = $1 AND ad_id = $2`,
    [BUSINESS_ID, UNREAD_AD_ID],
  );
  await db.query(`ALTER TABLE meta_ad_daily ALTER COLUMN link_clicks SET NOT NULL`, []);
  expectEqual(
    (await columnNullability())?.is_nullable,
    "NO",
    "the pre-change schema is restored, so the 'before' rows are written under it",
  );

  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: PRE_WIDENING_AD_ID,
        adNameCurrent: "Written before the widening",
        adStatus: "ACTIVE",
        spend: 90,
        impressions: 4_000,
        clicks: 60,
        reach: 3_500,
        frequency: 1.14,
        conversions: 2,
        revenue: 180,
        roas: 2,
        linkClicks: 41,
        payloadJson: { ad_id: PRE_WIDENING_AD_ID },
      }),
      baseAdDailyRow({
        adId: MEASURED_ZERO_AD_ID,
        adNameCurrent: "Measured zero",
        adStatus: "PAUSED",
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        frequency: 0,
        conversions: 0,
        revenue: 0,
        roas: 0,
        linkClicks: 0,
        payloadJson: {
          add_to_cart: 0,
          landing_page_views: 0,
          initiate_checkout: 0,
        },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );
  expectEqual(await storedLinkClicks(PRE_WIDENING_AD_ID), 41, "the pre-widening measurement is stored");
  expectEqual(await storedLinkClicks(MEASURED_ZERO_AD_ID), 0, "the pre-widening measured zero is stored");

  // ── 3. Run the widening TWICE. No row may change. ──────────────────────────
  // The filenode is captured on both sides. `DROP NOT NULL` is a catalog-only
  // change — it drops a constraint, it does not touch a heap page — and a
  // changed filenode would mean the table was REWRITTEN, which on production's
  // 315,289 rows would be a very different operational claim than the one this
  // migration's comment makes.
  const filenode = async () => {
    const rows = await db.query<{ filenode: string }>(
      `SELECT pg_relation_filenode('meta_ad_daily')::text AS filenode`,
      [],
    );
    return rows[0]?.filenode ?? null;
  };
  const filenodeBefore = await filenode();
  await db.query(`ALTER TABLE meta_ad_daily ALTER COLUMN link_clicks DROP NOT NULL`, []);
  await db.query(`ALTER TABLE meta_ad_daily ALTER COLUMN link_clicks DROP NOT NULL`, []);
  expectEqual(
    (await columnNullability())?.is_nullable,
    "YES",
    "re-running the widening on an already-nullable column is a no-op, not an error",
  );
  expectEqual(
    await storedLinkClicks(PRE_WIDENING_AD_ID),
    41,
    "the widening left a measured 41 exactly as it was",
  );
  expectEqual(
    await storedLinkClicks(MEASURED_ZERO_AD_ID),
    0,
    "the widening did NOT reinterpret a stored 0 as an absence",
  );
  const nullCountAfterWidening = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM meta_ad_daily
      WHERE business_id = $1 AND link_clicks IS NULL`,
    [BUSINESS_ID],
  );
  expectEqual(
    Number(nullCountAfterWidening[0]?.count ?? "-1"),
    0,
    "the widening created no NULLs of its own — only a writer can",
  );
  expectEqual(
    await filenode(),
    filenodeBefore,
    "the widening did not rewrite the table — it is a catalog-only constraint drop",
  );

  // ── 4. The re-sync that supplies nothing ───────────────────────────────────
  // The exact production shape: the same natural key, written again by a run
  // whose insights response carried no link-click count. Under the old
  // three-argument COALESCE this stored 0 and the measurement was gone.
  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: KEPT_AD_ID,
        adNameCurrent: "Re-sync target",
        adStatus: "ACTIVE",
        spend: 55,
        impressions: 2_200,
        clicks: 33,
        reach: 2_000,
        frequency: 1.1,
        conversions: 1,
        revenue: 90,
        roas: 1.6,
        linkClicks: 27,
        payloadJson: { ad_id: KEPT_AD_ID },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );
  expectEqual(await storedLinkClicks(KEPT_AD_ID), 27, "the first sync stored the measurement");

  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: KEPT_AD_ID,
        adNameCurrent: "Re-sync target",
        adStatus: "ACTIVE",
        spend: 61,
        impressions: 2_400,
        clicks: 35,
        reach: 2_100,
        frequency: 1.14,
        conversions: 1,
        revenue: 95,
        roas: 1.6,
        linkClicks: null,
        payloadJson: { ad_id: KEPT_AD_ID },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );
  expectEqual(
    await storedLinkClicks(KEPT_AD_ID),
    27,
    "a re-sync that supplied nothing kept the stored measurement instead of overwriting it with 0",
  );

  // ...and a re-sync that DOES supply a measurement still wins, including when
  // that measurement is zero. Otherwise "keep what is stored" would freeze the
  // first value ever written.
  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: KEPT_AD_ID,
        adNameCurrent: "Re-sync target",
        adStatus: "ACTIVE",
        spend: 61,
        impressions: 2_400,
        clicks: 35,
        reach: 2_100,
        frequency: 1.14,
        conversions: 1,
        revenue: 95,
        roas: 1.6,
        linkClicks: 0,
        payloadJson: { ad_id: KEPT_AD_ID },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );
  expectEqual(
    await storedLinkClicks(KEPT_AD_ID),
    0,
    "a supplied measurement of zero overwrites a stored 27 — a measurement always wins",
  );

  // ── 5. Re-create the unread row the caller goes on to assert against ───────
  await upsertMetaAdDailyRows(
    [
      baseAdDailyRow({
        adId: UNREAD_AD_ID,
        adNameCurrent: "Unread funnel",
        adStatus: "ACTIVE",
        spend: 120.5,
        impressions: 5_000,
        clicks: 90,
        reach: 0,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        linkClicks: null,
        payloadJson: { ad_id: UNREAD_AD_ID },
      }),
    ],
    { writeMode: "authoritative_fact" },
  );
  expectEqual(
    await storedLinkClicks(UNREAD_AD_ID),
    null,
    "an unsupplied link_clicks reaches storage as NULL",
  );

  await db.query(
    `DELETE FROM meta_ad_daily WHERE business_id = $1 AND ad_id = ANY($2::text[])`,
    [BUSINESS_ID, [KEPT_AD_ID, PRE_WIDENING_AD_ID]],
  );

  console.log(
    `[${LABEL}] link_clicks storage: column nullable=YES default=0; ` +
      `a 41 and a 0 written under the pre-change NOT NULL schema survived the widening unchanged; ` +
      `the widening ran twice and created 0 NULLs of its own; ` +
      `re-sync with nothing supplied kept 27; re-sync supplying 0 wrote 0; unsupplied reached storage as NULL.`,
  );
}

/**
 * THE DEFAULT PRODUCTION GRAIN, against real storage.
 *
 * Everything above exercises `meta_ad_daily`, which is the `groupBy: "ad"`
 * branch. The Assets table calls `groupBy: "creative"`, and that branch reads a
 * DIFFERENT fact table (`meta_creative_daily`) paired with a DIFFERENT
 * dimension table (`meta_creative_dimensions`) — so none of the assertions
 * above say anything about the surface an operator actually looks at.
 *
 * Two schema facts have to be true here, and only a database can show them:
 *
 *   1. `meta_creative_daily` keeps the funnel counters in `payload_json`, and an
 *      ABSENT key must survive `getMetaCreativeDailyRange` as `null` rather than
 *      being coalesced to 0 by the SQL or the row mapper. If it were ever
 *      coalesced, the sidecar would be derived from a fabricated number.
 *   2. `meta_creative_dimensions` is keyed
 *      `(business_id, provider_account_id, creative_id)` and assigns
 *      `projection_json = EXCLUDED.projection_json`, so it stores exactly ONE
 *      projection per creative regardless of how many days were written. That
 *      is why a projection cannot vouch for a day's measurement, and it is a
 *      claim about the unique index rather than about TypeScript.
 */
async function proveCreativeGrain() {
  const projectionFor = (creativeId: string, overrides: Record<string, unknown> = {}) => ({
    id: `ad-${creativeId}`,
    creative_id: creativeId,
    copy_text: "Creative grain seam",
    name: "Creative grain seam",
    account_id: PROVIDER_ACCOUNT_ID,
    currency: "USD",
    launch_date: DAY,
    tags: [],
    ai_tags: {},
    copy_variants: [],
    headline_variants: [],
    description_variants: [],
    is_catalog: false,
    preview_state: "unavailable",
    associated_ads_count: 1,
    format: "video",
    creative_type: "feed",
    // Every metric key present as an already-coalesced number, and no
    // `metric_presence` — the exact shape production stores.
    spend: 0,
    purchase_value: 0,
    roas: 0,
    cpa: 0,
    clicks: 0,
    cpc_link: 0,
    cpm: 0,
    ctr_all: 0,
    purchases: 0,
    impressions: 0,
    link_clicks: 0,
    landing_page_views: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
    thumbstop: 37,
    click_to_atc: 0,
    atc_to_purchase: 0,
    leads: 4,
    messages: 0,
    video25: 22,
    video50: 11,
    video75: 6,
    video100: 3,
    ...overrides,
  });

  const baseCreativeRow = (overrides: Partial<MetaCreativeDailyRow>) =>
    ({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      date: DAY,
      campaignId: "cmp-null-presence",
      adsetId: "adset-null-presence",
      creativeName: "Creative grain seam",
      headline: null,
      primaryText: null,
      destinationUrl: null,
      thumbnailUrl: null,
      assetType: null,
      accountTimezone: "UTC",
      accountCurrency: "USD",
      metricSchemaVersion: 1,
      ...overrides,
    }) as MetaCreativeDailyRow;

  await upsertMetaCreativeDailyRows([
    // A creative that ran and measured nothing, with the funnel keys written.
    baseCreativeRow({
      adId: `ad-${MEASURED_ZERO_CREATIVE_ID}`,
      creativeId: MEASURED_ZERO_CREATIVE_ID,
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      frequency: 0,
      conversions: 0,
      revenue: 0,
      roas: 0,
      cpa: 0,
      ctr: 0,
      cpc: 0,
      linkClicks: 0,
      payloadJson: {
        ...projectionFor(MEASURED_ZERO_CREATIVE_ID),
        add_to_cart: 0,
        landing_page_views: 0,
        initiate_checkout: 0,
      },
    }),
    // The same day, but the sync never captured the funnel keys at all.
    baseCreativeRow({
      adId: `ad-${UNREAD_CREATIVE_ID}`,
      creativeId: UNREAD_CREATIVE_ID,
      spend: 33_500,
      impressions: 120_000,
      clicks: 900,
      reach: 90_000,
      frequency: null,
      conversions: 0,
      revenue: 0,
      roas: 0,
      cpa: null,
      ctr: null,
      cpc: null,
      linkClicks: 800,
      payloadJson: { creative_id: UNREAD_CREATIVE_ID },
    }),
  ]);

  const creativeFacts = await getMetaCreativeDailyRange({
    businessId: BUSINESS_ID,
    startDate: DAY,
    endDate: DAY,
    providerAccountIds: [PROVIDER_ACCOUNT_ID],
  });
  const zeroFact = creativeFacts.find((row) => row.creativeId === MEASURED_ZERO_CREATIVE_ID);
  const unreadFact = creativeFacts.find((row) => row.creativeId === UNREAD_CREATIVE_ID);
  if (!zeroFact || !unreadFact) fail("creative read back", "an expected creative row is missing");

  // 4. The schema claim the whole creative-grain sidecar rests on.
  expectEqual(zeroFact.spend, 0, "creative measured-zero spend survives as 0");
  expectEqual(zeroFact.addToCart, 0, "a written add_to_cart payload key stays 0");
  expectEqual(
    unreadFact.addToCart,
    null,
    "an absent add_to_cart payload key stays null on meta_creative_daily",
  );
  expectEqual(
    unreadFact.landingPageViews,
    null,
    "an absent landing_page_views payload key stays null on meta_creative_daily",
  );
  expectEqual(unreadFact.frequency, null, "a NULL creative frequency column stays null");
  expectEqual(unreadFact.spend, 33_500, "the economic evidence beside it is intact");

  // 5. ONE projection per creative, whatever the day count. This is the unique
  //    index talking, and it is why a projection cannot vouch for a day.
  const dimensions = await readMetaCreativeDimensions({
    businessId: BUSINESS_ID,
    creativeIds: [MEASURED_ZERO_CREATIVE_ID, UNREAD_CREATIVE_ID],
  });
  expectEqual(dimensions.size, 2, "one dimension row per creative");
  const storedProjection = dimensions.get(UNREAD_CREATIVE_ID)?.projectionJson;
  if (!storedProjection || typeof storedProjection !== "object") {
    fail("creative projection", "no projection_json stored for the unread creative");
  }
  expectEqual(
    "metric_presence" in (storedProjection as Record<string, unknown>),
    false,
    "a production-vintage projection declares no availability",
  );

  // ------------------------------------- the creative branch, run verbatim
  const creativeApiRowById = new Map<string, ReturnType<typeof buildMetaCreativeApiRow>>();
  for (const factRow of [zeroFact, unreadFact]) {
    const projectionRow = coerceRawCreativeRow(projectionFor(factRow.creativeId));
    if (!projectionRow) fail("creative projection", "coerceRawCreativeRow refused the projection");
    const rawRows: RawCreativeRow[] = [
      hydrateWarehouseCreativeMetrics({ row: projectionRow, factRow }),
    ];
    const grouped = groupRows(rawRows, "creative", buildCreativeUsageMap(rawRows));
    creativeApiRowById.set(
      factRow.creativeId,
      buildMetaCreativeApiRow({
        row: grouped[0],
        cachedThumbnailUrl: null,
        cardFallbackThumbnailUrl: null,
        includeDebugFields: false,
      }),
    );
  }

  const zeroCreative = creativeApiRowById.get(MEASURED_ZERO_CREATIVE_ID)!;
  const unreadCreative = creativeApiRowById.get(UNREAD_CREATIVE_ID)!;

  // 6a. Measured zeros stay measured on this grain too.
  expectEqual(zeroCreative.spend, 0, "creative measured-zero spend reaches the API row as 0");
  expectEqual(
    zeroCreative.metric_presence?.spend,
    true,
    "creative measured-zero spend is published as available",
  );
  expectEqual(
    zeroCreative.metric_presence?.add_to_cart,
    true,
    "a written creative add_to_cart 0 is published as available",
  );

  // 6b. THE DEFECT THIS SECTION EXISTS FOR. The stored projection carries
  //     `add_to_cart: 0` and `landing_page_views: 0` as coalesced numbers, and
  //     the old reader treated that as evidence — so a funnel counter the sync
  //     never captured was republished as a measured zero on the one grain the
  //     Assets table reads.
  expectEqual(
    unreadCreative.metric_presence?.add_to_cart,
    false,
    "an unread creative add_to_cart is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.landing_page_views,
    false,
    "an unread creative landing_page_views is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.frequency,
    false,
    "a NULL creative frequency is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.spend,
    true,
    "the measured spend on the same creative row stays available",
  );
  expectEqual(unreadCreative.add_to_cart, 0, "the legacy creative add_to_cart number is unchanged");
  expectEqual(unreadCreative.spend, 33_500, "the legacy creative spend number is unchanged");

  // 6c. Projection-only counters. `meta_creative_daily` has no column and no
  //     payload key for these; their numbers come from the single stored
  //     projection and `groupRows` then SUMS them across the window's days.
  expectEqual(
    unreadCreative.metric_presence?.thumbstop,
    false,
    "a projection-only thumbstop is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.leads,
    false,
    "a projection-only leads count is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.video25,
    false,
    "a projection-only video quartile is published as unavailable",
  );

  // 6d. The zero-denominator rule, on this grain: $33,500 spent, nothing
  //     bought. CPA is lower-is-better, so `cpa: 0` made this the account's
  //     apparent leader.
  expectEqual(unreadCreative.cpa, 0, "the legacy creative cpa number is unchanged");
  expectEqual(
    unreadCreative.metric_presence?.cpa,
    false,
    "creative cpa over zero purchases is published as unavailable",
  );
  expectEqual(
    unreadCreative.metric_presence?.cpm,
    true,
    "creative cpm over measured impressions stays available",
  );
}

/**
 * `meta_creative_daily.link_clicks` at the STORAGE layer.
 *
 * A SEPARATE TABLE WITH THE SAME DEFECT, and the one that matters most to a
 * reader: `groupBy: "creative"` is the DEFAULT Assets grain, so this column is
 * behind the cells an operator actually looks at. Everything
 * `proveAdDailyLinkClicksStorage` establishes about `meta_ad_daily` says
 * NOTHING about this table — different DDL, different writer, different ON
 * CONFLICT clause — so the same four claims are executed again here rather than
 * argued by analogy:
 *
 *   1. THE WIDENING IS A WIDENING. `DROP NOT NULL` enlarges the accepted set
 *      and rewrites no heap page. Rows are written under the restored
 *      pre-change NOT NULL schema so the "before" is real, the statement is run
 *      TWICE for idempotency, and `pg_relation_filenode` is compared across it:
 *      an unchanged filenode is what makes "catalog-only, no table rewrite" a
 *      measurement rather than a claim.
 *   2. THE WIDENING CREATES NO NULLS OF ITS OWN. Only a writer can. Stored
 *      zeros stay literal zeros and are NOT reinterpreted as absences — that
 *      inference is exactly what this whole change forbids.
 *   3. THE IN-MEMORY MERGE DOES NOT FABRICATE. `upsertMetaCreativeDailyRows`
 *      folds several ad-rows into one creative-day before it ever reaches SQL,
 *      and `(a ?? 0) + (b ?? 0)` turned "neither row supplied a count" into a
 *      measured 0 that no ON CONFLICT clause downstream could undo.
 *   4. THE CONFLICT CLAUSE KEEPS A MEASUREMENT. A re-sync supplying nothing
 *      must leave a stored count alone; a re-sync supplying a value — INCLUDING
 *      a measured 0 — must always win.
 */
async function proveCreativeDailyLinkClicksStorage() {
  const db = getDb();
  const KEPT_CREATIVE_ID = "cre-null-presence-link-clicks-kept";
  const PRE_WIDENING_CREATIVE_ID = "cre-null-presence-pre-widening";
  const MERGED_CREATIVE_ID = "cre-null-presence-merged";

  const columnNullability = async () => {
    const rows = await db.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'meta_creative_daily' AND column_name = 'link_clicks'`,
      [],
    );
    return rows[0] ?? null;
  };

  const storedLinkClicks = async (creativeId: string) => {
    const rows = await db.query<{ link_clicks: string | number | null }>(
      `SELECT link_clicks FROM meta_creative_daily
        WHERE business_id = $1 AND provider_account_id = $2 AND date = $3::date AND creative_id = $4`,
      [BUSINESS_ID, PROVIDER_ACCOUNT_ID, DAY, creativeId],
    );
    if (rows.length === 0) fail("stored creative link_clicks", `no row for ${creativeId}`);
    const value = rows[0]!.link_clicks;
    return value == null ? null : Number(value);
  };

  const filenode = async () => {
    const rows = await db.query<{ filenode: string }>(
      `SELECT pg_relation_filenode('meta_creative_daily')::text AS filenode`,
      [],
    );
    return rows[0]?.filenode ?? null;
  };

  const baseRow = (overrides: Partial<MetaCreativeDailyRow>) =>
    ({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      date: DAY,
      campaignId: "cmp-null-presence",
      adsetId: "adset-null-presence",
      creativeName: "Creative link-click storage seam",
      headline: null,
      primaryText: null,
      destinationUrl: null,
      thumbnailUrl: null,
      assetType: null,
      accountTimezone: "UTC",
      accountCurrency: "USD",
      metricSchemaVersion: 1,
      spend: 50,
      impressions: 2_000,
      clicks: 30,
      reach: 1_800,
      frequency: 1.1,
      conversions: 1,
      revenue: 90,
      roas: 1.8,
      cpa: 50,
      ctr: 1.5,
      cpc: 1.85,
      payloadJson: {},
      ...overrides,
    }) as MetaCreativeDailyRow;

  // ── 1. The migration landed ────────────────────────────────────────────────
  expectEqual(
    (await columnNullability())?.is_nullable,
    "YES",
    "the migration widened meta_creative_daily.link_clicks to accept NULL",
  );
  expectEqual(
    (await columnNullability())?.column_default,
    "0",
    "meta_creative_daily.link_clicks keeps DEFAULT 0 for an INSERT that omits it",
  );

  // ── 2. Measurements written under the restored PRE-CHANGE schema ───────────
  // SET NOT NULL can only succeed while no NULL exists, so the creative-grain
  // rows written earlier in this run are cleared first. This is an ephemeral
  // database the parent harness created for this run; nothing outside it is
  // touched, and no production row is read or written anywhere in this file.
  await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS_ID]);
  await db.query(
    `ALTER TABLE meta_creative_daily ALTER COLUMN link_clicks SET NOT NULL`,
    [],
  );
  expectEqual(
    (await columnNullability())?.is_nullable,
    "NO",
    "the pre-change creative schema is restored, so the 'before' rows are written under it",
  );

  await upsertMetaCreativeDailyRows([
    baseRow({
      adId: `ad-${PRE_WIDENING_CREATIVE_ID}`,
      creativeId: PRE_WIDENING_CREATIVE_ID,
      linkClicks: 41,
    }),
    baseRow({
      adId: `ad-${KEPT_CREATIVE_ID}`,
      creativeId: KEPT_CREATIVE_ID,
      linkClicks: 27,
    }),
  ]);
  expectEqual(
    await storedLinkClicks(PRE_WIDENING_CREATIVE_ID),
    41,
    "a creative-grain measurement is stored under the pre-change schema",
  );

  // ── 3. Run the widening TWICE. No row may change, no table may be rewritten ─
  const filenodeBefore = await filenode();
  await db.query(
    `ALTER TABLE meta_creative_daily ALTER COLUMN link_clicks DROP NOT NULL`,
    [],
  );
  await db.query(
    `ALTER TABLE meta_creative_daily ALTER COLUMN link_clicks DROP NOT NULL`,
    [],
  );
  expectEqual(
    (await columnNullability())?.is_nullable,
    "YES",
    "re-running the creative widening on an already-nullable column is a no-op, not an error",
  );
  expectEqual(
    await storedLinkClicks(PRE_WIDENING_CREATIVE_ID),
    41,
    "the creative widening left a measured 41 exactly as it was",
  );
  const creativeNullsAfterWidening = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM meta_creative_daily
      WHERE business_id = $1 AND link_clicks IS NULL`,
    [BUSINESS_ID],
  );
  expectEqual(
    Number(creativeNullsAfterWidening[0]?.count ?? "-1"),
    0,
    "the creative widening created no NULLs of its own — only a writer can",
  );
  expectEqual(
    await filenode(),
    filenodeBefore,
    "the creative widening did not rewrite the table — catalog-only constraint drop",
  );

  // ── 4. The conflict clause keeps a measurement ─────────────────────────────
  await upsertMetaCreativeDailyRows([
    baseRow({
      adId: `ad-${KEPT_CREATIVE_ID}`,
      creativeId: KEPT_CREATIVE_ID,
      spend: 61,
      linkClicks: null,
    }),
  ]);
  expectEqual(
    await storedLinkClicks(KEPT_CREATIVE_ID),
    27,
    "a creative re-sync supplying nothing kept the stored 27 instead of overwriting it with 0",
  );
  await upsertMetaCreativeDailyRows([
    baseRow({
      adId: `ad-${KEPT_CREATIVE_ID}`,
      creativeId: KEPT_CREATIVE_ID,
      spend: 61,
      linkClicks: 0,
    }),
  ]);
  expectEqual(
    await storedLinkClicks(KEPT_CREATIVE_ID),
    0,
    "a supplied creative measurement of zero overwrites a stored 27 — a measurement always wins",
  );

  // ── 5. The in-memory fold, which happens BEFORE any SQL ────────────────────
  // Two ad-rows collapsing into one creative-day. Neither supplies a count, so
  // the fold must not manufacture one; `(a ?? 0) + (b ?? 0)` produced a
  // measured 0 here and nothing downstream could tell it apart from a real one.
  await upsertMetaCreativeDailyRows([
    baseRow({
      adId: `ad-${MERGED_CREATIVE_ID}-a`,
      creativeId: MERGED_CREATIVE_ID,
      linkClicks: null,
    }),
    baseRow({
      adId: `ad-${MERGED_CREATIVE_ID}-b`,
      creativeId: MERGED_CREATIVE_ID,
      linkClicks: null,
    }),
  ]);
  expectEqual(
    await storedLinkClicks(MERGED_CREATIVE_ID),
    null,
    "folding two unsupplied ad-rows into one creative-day stays unsupplied, not a measured 0",
  );

  // ...and the fold still sums when there IS something to sum, including a
  // measured zero on one side. Absence must not swallow a measurement either.
  await db.query(
    `DELETE FROM meta_creative_daily WHERE business_id = $1 AND creative_id = $2`,
    [BUSINESS_ID, MERGED_CREATIVE_ID],
  );
  await upsertMetaCreativeDailyRows([
    baseRow({
      adId: `ad-${MERGED_CREATIVE_ID}-a`,
      creativeId: MERGED_CREATIVE_ID,
      linkClicks: null,
    }),
    baseRow({
      adId: `ad-${MERGED_CREATIVE_ID}-b`,
      creativeId: MERGED_CREATIVE_ID,
      linkClicks: 12,
    }),
  ]);
  expectEqual(
    await storedLinkClicks(MERGED_CREATIVE_ID),
    12,
    "an absent side does not erase the measured side of the fold",
  );

  await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS_ID]);

  console.log(
    `[${LABEL}] meta_creative_daily.link_clicks storage: column nullable=YES default=0; ` +
      `a 41 written under the pre-change NOT NULL schema survived the widening unchanged; ` +
      `the widening ran twice, created 0 NULLs of its own and left pg_relation_filenode unchanged; ` +
      `re-sync with nothing supplied kept 27; re-sync supplying 0 wrote 0; ` +
      `two unsupplied ad-rows folded to NULL, and an absent side did not erase a measured 12.`,
  );
}

/**
 * ENGINE EQUIVALENCE ON THE CREATIVE GRAIN, end to end, against real storage.
 *
 * The vitest equivalence seam in
 * `lib/creative-decision-engine/__tests__/jobs/ad-calibration-job.test.ts`
 * covers the AD grain: the per-row read that used to throw on NULL, and the
 * batch computed from it. It says nothing about `meta_creative_daily`, which is
 * a different table read by different SQL — the cumulative and historical
 * aggregates in `creative-decision-engine/data-source.ts`, the windows in
 * `jobs/lifecycle-job.ts`, and the funnel denominators in
 * `jobs/calibration-job.ts`. Those are the aggregates where PostgreSQL's
 * "SUM ignores nulls" rule bites, and only a real database can settle it.
 *
 * So this runs the REAL `runCalibrationJob` twice over the SAME seeded
 * creative-days, changing exactly one thing between the runs: `link_clicks`
 * goes from a stored 0 to NULL. The calibration it returns carries the funnel
 * percentiles that are DIVIDED BY this column — link-to-LPV, link-to-ATC and
 * click-to-purchase — so if `SUM(link_clicks)` had been left uncoalesced, the
 * second run would produce nulls where the first produced numbers, and the
 * comparison below would fail.
 *
 * The assertion is deep equality on the whole calibration payload, minus the
 * fields that are wall-clock or per-run by construction. Nothing is spot
 * checked, so a moved percentile or a changed sample count fails here.
 *
 * This proves (A): the engine's numbers are unchanged. It deliberately does not
 * supply a real link-click count from anywhere — that would be (B), and it
 * would move exactly these numbers.
 */
async function proveCreativeGrainEngineEquivalence() {
  const db = getDb();
  const ASOF = DAY;
  // Above FUNNEL_METRIC_SAMPLE_FLOOR (20) so the funnel percentiles are
  // actually computed rather than withheld as 'insufficient' — a withheld
  // funnel would make the comparison below vacuous.
  // 50, not 30: the funnel percentiles are gated on
  // COUNT(link_to_atc_rate) >= FUNNEL_METRIC_SAMPLE_FLOOR (20), and only the
  // MEASURED half of the pool contributes a non-null rate. 25 measured
  // creatives clears that floor; 15 would not, and the percentiles would come
  // back null on both sides for a reason that has nothing to do with the
  // change under test.
  const CREATIVE_COUNT = 50;

  await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS_ID]);
  await db.query(
    `INSERT INTO business_engine_v3_flags (business_id, enabled, surface_visible, shadow_only)
     VALUES ($1, TRUE, TRUE, FALSE)
     ON CONFLICT (business_id) DO UPDATE SET enabled = TRUE`,
    [BUSINESS_ID],
  );

  // A spread wide enough for percentiles to be non-degenerate. Every row
  // carries a positive link_clicks so the funnel rates are real numbers in the
  // ZERO world -- a fixture whose rates were already null could not detect a
  // NULL leaking through.
  // HALF the pool carries a positive link-click measurement that is IDENTICAL in
  // both worlds; the other half is the population under test, moving from a
  // stored 0 to NULL. That mix is what makes the comparison meaningful: the
  // measured half keeps the funnel percentiles real numbers, so a NULL leaking
  // out of an uncoalesced SUM would visibly move them, while an all-zero pool
  // would produce null rates on both sides and prove nothing.
  const rows = Array.from({ length: CREATIVE_COUNT }, (_, index) => {
    const measured = index % 2 === 0;
    const linkClicks = measured ? 40 + index * 11 : 0;
    return {
      measured,
      creativeId: `cre-eq-${String(index).padStart(2, "0")}`,
      linkClicks,
      spend: 25 + index * 7,
      impressions: 1_500 + index * 250,
      clicks: linkClicks + 5,
      conversions: 1 + (index % 4),
      revenue: 60 + index * 19,
    };
  });

  await upsertMetaCreativeDailyRows(
    rows.map((row) =>
      ({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        date: ASOF,
        campaignId: "cmp-eq-grain",
        adsetId: "adset-eq-grain",
        adId: `ad-${row.creativeId}`,
        creativeId: row.creativeId,
        creativeName: `Equivalence ${row.creativeId}`,
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: null,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        metricSchemaVersion: 1,
        objective: "OUTCOME_SALES",
        effectiveStatus: "ACTIVE",
        creativeVisualFormat: "video",
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        reach: row.impressions,
        frequency: 1.1,
        conversions: row.conversions,
        revenue: row.revenue,
        roas: row.revenue / row.spend,
        cpa: row.spend / row.conversions,
        ctr: (row.clicks / row.impressions) * 100,
        cpc: row.spend / row.clicks,
        linkClicks: row.linkClicks,
        payloadJson: {
          creative_format: "video",
          landing_page_views: row.linkClicks * 0.8,
          add_to_cart: row.linkClicks * 0.2,
          initiate_checkout: row.linkClicks * 0.1,
          thumbstop: 0.3,
        },
      }) as never,
    ),
  );

  // ── World ZERO ─────────────────────────────────────────────────────────────
  // Every link_clicks becomes a stored 0, which is exactly what production has
  // in all 192,464 of its zero rows today.
  const unmeasuredIds = rows.filter((row) => !row.measured).map((row) => row.creativeId);
  const zeroed = await db.query<{ count: string }>(
    `UPDATE meta_creative_daily SET link_clicks = 0
      WHERE business_id = $1 AND creative_id = ANY($2::text[]) RETURNING 1 AS count`,
    [BUSINESS_ID, unmeasuredIds],
  );
  expectEqual(
    zeroed.length,
    unmeasuredIds.length,
    "the unmeasured half of the pool is stored with link_clicks = 0",
  );
  const zeroWorld = await runCalibrationJob({ businessId: BUSINESS_ID, asOf: ASOF });
  if (zeroWorld.status !== "success") {
    fail("zero-world calibration", `status=${zeroWorld.status} ${zeroWorld.errorMessage ?? ""}`);
  }
  if (!zeroWorld.calibration) fail("zero-world calibration", "no calibration returned");
  const zeroRowsQuery = await db.query<Record<string, unknown>>(
    `SELECT scope_type, scope_id, campaign_kind, creative_format,
            eligible_creative_count, mature_creative_count, zero_conversion_count,
            roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
            ctr_p25, ctr_p50, cpm_p50, cpm_p75, thumbstop_p25, thumbstop_p50,
            link_to_lpv_p25, link_to_lpv_p50,
            link_to_atc_p25, link_to_atc_p50,
            lpv_to_atc_p25, lpv_to_atc_p50,
            atc_to_ic_p25, atc_to_ic_p50,
            ic_to_purchase_p25, ic_to_purchase_p50,
            click_to_purchase_p25, click_to_purchase_p50,
            funnel_sample_count, funnel_quality_status, quality_status
       FROM engine_v3_account_calibration_daily
      WHERE business_id = $1 AND as_of_date = $2::date
      ORDER BY scope_type, scope_id, campaign_kind, creative_format`,
    [BUSINESS_ID, ASOF],
  );
  const zeroRows = zeroRowsQuery;

  // ── World NULL ─────────────────────────────────────────────────────────────
  // The ONLY mutation between the two runs.
  const nulled = await db.query<{ count: string }>(
    `UPDATE meta_creative_daily SET link_clicks = NULL
      WHERE business_id = $1 AND creative_id = ANY($2::text[]) RETURNING 1 AS count`,
    [BUSINESS_ID, unmeasuredIds],
  );
  expectEqual(
    nulled.length,
    unmeasuredIds.length,
    "exactly the previously-zero half is now stored unsupplied",
  );
  const stillZero = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM meta_creative_daily
      WHERE business_id = $1 AND link_clicks = 0`,
    [BUSINESS_ID],
  );
  expectEqual(Number(stillZero[0]?.count ?? "-1"), 0, "no stored zero link_clicks remains");
  const measuredIntact = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM meta_creative_daily
      WHERE business_id = $1 AND link_clicks > 0`,
    [BUSINESS_ID],
  );
  expectEqual(
    Number(measuredIntact[0]?.count ?? "-1"),
    CREATIVE_COUNT - unmeasuredIds.length,
    "the measured half is untouched, so any moved percentile is attributable to the flipped half",
  );

  const nullWorld = await runCalibrationJob({ businessId: BUSINESS_ID, asOf: ASOF });
  if (nullWorld.status !== "success") {
    fail("null-world calibration", `status=${nullWorld.status} ${nullWorld.errorMessage ?? ""}`);
  }
  if (!nullWorld.calibration) fail("null-world calibration", "no calibration returned");

  // COMPARE THE PERSISTED ROWS, not the returned object.
  //
  // `AccountCalibration` carries the ROAS and spend percentiles but NOT the
  // funnel ones, and the funnel percentiles are the only fields in this whole
  // job that are DIVIDED BY link_clicks — link_to_lpv, link_to_atc and
  // click_to_purchase. Comparing the returned object would therefore pass no
  // matter what happened to the column. The written rows carry all of them.
  const readCalibrationRows = async () =>
    db.query<Record<string, unknown>>(
      `SELECT scope_type, scope_id, campaign_kind, creative_format,
              eligible_creative_count, mature_creative_count, zero_conversion_count,
              roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
              ctr_p25, ctr_p50, cpm_p50, cpm_p75, thumbstop_p25, thumbstop_p50,
              link_to_lpv_p25, link_to_lpv_p50,
              link_to_atc_p25, link_to_atc_p50,
              lpv_to_atc_p25, lpv_to_atc_p50,
              atc_to_ic_p25, atc_to_ic_p50,
              ic_to_purchase_p25, ic_to_purchase_p50,
              click_to_purchase_p25, click_to_purchase_p50,
              funnel_sample_count, funnel_quality_status, quality_status
         FROM engine_v3_account_calibration_daily
        WHERE business_id = $1 AND as_of_date = $2::date
        ORDER BY scope_type, scope_id, campaign_kind, creative_format`,
      [BUSINESS_ID, ASOF],
    );

  const nullRows = await readCalibrationRows();

  // The fixture must actually produce a link-click-denominated number in the
  // ZERO world, or this proves nothing. Captured before the second run
  // overwrote the rows, so it is read from the stored zero-world snapshot.
  const overallZero = zeroRows.find(
    (row) => row.scope_type === "account" && row.creative_format === "overall",
  );
  const linkToAtc = overallZero?.link_to_atc_p50;
  if (linkToAtc == null || !Number.isFinite(Number(linkToAtc))) {
    fail(
      "creative-grain equivalence fixture",
      `link-to-ATC p50 must be a real number in the zero world, got ${JSON.stringify(linkToAtc)}`,
    );
  }
  expectEqual(
    overallZero?.funnel_quality_status,
    "ready",
    "the zero-world funnel calibration is computed, not withheld as insufficient",
  );

  expectEqual(nullRows.length, zeroRows.length, "both worlds wrote the same number of calibration rows");
  const zeroJson = JSON.stringify(zeroRows);
  const nullJson = JSON.stringify(nullRows);
  if (zeroJson !== nullJson) {
    fail(
      "creative-grain engine equivalence",
      `calibration rows changed when a stored 0 became an unsupplied NULL.\n  zero: ${zeroJson}\n  null: ${nullJson}`,
    );
  }

  // The returned payload is compared too, minus the fields that are wall-clock
  // or per-run by construction.
  const comparable = (calibration: Record<string, unknown>) => {
    const copy: Record<string, unknown> = { ...calibration };
    delete copy.computedAt;
    return copy;
  };
  expectEqual(
    JSON.stringify(comparable(nullWorld.calibration as unknown as Record<string, unknown>)),
    JSON.stringify(comparable(zeroWorld.calibration as unknown as Record<string, unknown>)),
    "the returned AccountCalibration is identical across the two worlds",
  );

  // ── The one place the coalesce is OBSERVABLE ──────────────────────────────
  //
  // The calibration equivalence above is a genuine end-to-end guard, but it is
  // NOT load-bearing for `SUM(COALESCE(link_clicks, 0))` on its own: every
  // funnel rate in that job is guarded by `CASE WHEN total_link_clicks > 0`,
  // and that guard treats NULL and 0 alike, so the job is structurally
  // insensitive to the distinction. Verified by reverting the coalesce and
  // watching the comparison still pass.
  //
  // The lifecycle job is where it bites, because it does not consume the sum —
  // it STORES it. `link_clicks_28d` is a persisted engine artifact, and without
  // the coalesce an all-unsupplied creative writes NULL there where it writes 0
  // today. That is a real change to a value the engine hands to its own
  // downstream reader (`data-source.ts` selects `l.link_clicks_28d AS
  // link_clicks`), so it is asserted directly rather than inferred.
  const lifecycle = await runLifecycleJob({ businessId: BUSINESS_ID, asOf: ASOF });
  if (lifecycle.status !== "success") {
    fail("lifecycle job", `status=${lifecycle.status} ${lifecycle.errorMessage ?? ""}`);
  }
  const unmeasuredId = unmeasuredIds[0]!;
  const measuredId = rows.find((row) => row.measured)!.creativeId;
  const lifecycleRows = await db.query<{ creative_id: string; link_clicks_28d: string | number | null }>(
    `SELECT creative_id, link_clicks_28d
       FROM engine_v3_creative_lifecycle_daily
      WHERE business_id = $1 AND as_of_date = $2::date
        AND creative_id = ANY($3::text[])`,
    [BUSINESS_ID, ASOF, [unmeasuredId, measuredId]],
  );
  const unmeasuredLifecycle = lifecycleRows.find((row) => row.creative_id === unmeasuredId);
  const measuredLifecycle = lifecycleRows.find((row) => row.creative_id === measuredId);
  if (!unmeasuredLifecycle || !measuredLifecycle) {
    fail("lifecycle link_clicks_28d", "expected lifecycle rows for both creatives");
  }
  expectEqual(
    unmeasuredLifecycle.link_clicks_28d == null
      ? null
      : Number(unmeasuredLifecycle.link_clicks_28d),
    0,
    "an all-unsupplied creative still stores link_clicks_28d = 0, exactly as it did when the column held zeros",
  );
  expectEqual(
    Number(measuredLifecycle.link_clicks_28d),
    rows.find((row) => row.creativeId === measuredId)!.linkClicks,
    "a measured creative's link_clicks_28d is untouched by the coalesce",
  );

  await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS_ID]);

  console.log(
    `[${LABEL}] creative-grain engine equivalence: runCalibrationJob over ${CREATIVE_COUNT} creative-days ` +
      `produced an identical calibration payload when every link_clicks moved from a stored 0 to NULL ` +
      `across ${zeroRows.length} persisted calibration rows including every link-click-denominated funnel ` +
      `percentile (link-to-ATC p50 = ${linkToAtc}, funnel_quality_status=ready, so the comparison is not vacuous); ` +
      `and runLifecycleJob stored link_clicks_28d = 0 for an all-unsupplied creative rather than NULL.`,
  );
}

main()
  .then(async () => {
    const db = getDb();
    await db.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [BUSINESS_ID]);
    await db.query(`DELETE FROM meta_creative_daily WHERE business_id = $1`, [BUSINESS_ID]);
    await db.query(`DELETE FROM meta_creative_dimensions WHERE business_id = $1`, [BUSINESS_ID]);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
