// Child of ephemeral-postgres-migrations-check: proves D066 decision-fact
// ownership against the freshly-migrated ephemeral database.
//
// D066 requires a real PostgreSQL seam because a mocked SQL-shape test cannot
// show what actually landed in the table. Three things have to be true against
// real storage, not against a spy:
//
//   1. the authoritative lane writes the fact row, byte-for-byte, with
//      creative-media / preview / media-debug keys removed from payload_json
//      while economic evidence stays intact;
//   2. every non-authoritative lane fails closed BEFORE mutating anything, so
//      a refused write leaves the prior row untouched rather than half-applied;
//   3. creatives metadata sync performs zero meta_ad_daily writes.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { readFileSync } from "node:fs";

import { getDb } from "@/lib/db";
import {
  META_AD_DAILY_UNAUTHORIZED_WRITE_CODE,
  upsertMetaAdDailyRows,
} from "@/lib/meta/warehouse";

const LABEL = "ad-daily-ownership-seam";

function fail(label: string, detail?: string): never {
  throw new Error(
    `${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * Canonical stringify: jsonb does not preserve key order, so a byte-for-byte
 * comparison has to sort keys or it tests PostgreSQL's storage order rather
 * than the payload's content.
 */
function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, sort(nested)]),
    );
  };
  return JSON.stringify(sort(value));
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const BUSINESS_ID = "d0660000-0000-4000-8000-000000000066";
const PROVIDER_ACCOUNT_ID = "act_d066";
const DAY = "2026-08-09";
const AD_ID = "ad-d066-1";

/** Payload carrying both decision evidence and media presentation noise. */
function payloadJson() {
  return {
    ad_id: AD_ID,
    spend: 42.15,
    purchases: 3,
    // Media presentation keys: must not survive into decision-fact storage.
    thumbnail_url: "https://example.invalid/thumb.jpg",
    image_url: "https://example.invalid/image.jpg",
    video_url: "https://example.invalid/video.mp4",
    preview_url: "https://example.invalid/preview",
    nested: {
      keep_me: "economic",
      thumbnail_url: "https://example.invalid/nested-thumb.jpg",
      deeper: [{ thumbnail_url: "x", roas: 2.36 }],
    },
  };
}

function adDailyRow(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: DAY,
    adId: AD_ID,
    adName: "D066 Ad",
    adNameCurrent: "D066 Ad",
    campaignId: "cmp-d066",
    adsetId: "adset-d066",
    creativeId: "cr-d066",
    accountTimezone: "UTC",
    accountCurrency: "TRY",
    spend: 42.15,
    impressions: 2930,
    clicks: 88,
    reach: 2510,
    frequency: 1.17,
    conversions: 3,
    revenue: 99.45,
    roas: 2.36,
    cpa: 14.05,
    ctr: 3,
    cpc: 0.48,
    metricSchemaVersion: 1,
    payloadJson: payloadJson(),
    ...overrides,
  } as never;
}

async function seedReferences() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ('d0660000-0000-4000-8000-0000000000aa', 'D066', 'd066@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1, 'D066 Ownership', 'd0660000-0000-4000-8000-0000000000aa')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID],
  );
  await db.query(
    `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'D066 Account', 'TRY', 'UTC')
     ON CONFLICT (provider, external_account_id) DO NOTHING`,
    [PROVIDER_ACCOUNT_ID],
  );
}

async function readAdDay() {
  const db = getDb();
  const rows = (await db.query(
    `SELECT ad_id, spend, conversions, revenue, roas, payload_json, updated_at
     FROM meta_ad_daily
     WHERE business_id = $1 AND provider_account_id = $2 AND date = $3::date`,
    [BUSINESS_ID, PROVIDER_ACCOUNT_ID, DAY],
  )) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function countAdDays() {
  return (await readAdDay()).length;
}

async function main() {
  await seedReferences();

  // ---------------------------------------------------------------- lane 1
  // Every non-authoritative lane fails closed before mutating anything.
  const refusedModes: unknown[] = [
    undefined,
    null,
    {},
    { writeMode: "creative_enrichment" },
    { writeMode: "authoritative" },
    { writeMode: "AUTHORITATIVE_FACT" },
    { writeMode: "" },
  ];
  for (const options of refusedModes) {
    let threw = false;
    try {
      await upsertMetaAdDailyRows([adDailyRow()], options as never);
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(META_AD_DAILY_UNAUTHORIZED_WRITE_CODE)) {
        fail("refusal code", `unexpected error for ${JSON.stringify(options)}: ${message}`);
      }
    }
    if (!threw) fail("refusal", `mode ${JSON.stringify(options)} was accepted`);
  }
  expectEqual(await countAdDays(), 0, "refused writes must persist nothing");

  // ---------------------------------------------------------------- lane 2
  // The authoritative lane writes the fact row.
  await upsertMetaAdDailyRows([adDailyRow()], {
    writeMode: "authoritative_fact",
  });
  const written = await readAdDay();
  expectEqual(written.length, 1, "authoritative write persists exactly one row");

  const persisted = written[0]!;
  expectEqual(Number(persisted.spend), 42.15, "spend retained");
  expectEqual(Number(persisted.conversions), 3, "conversions retained");
  expectEqual(Number(persisted.revenue), 99.45, "revenue retained");
  expectEqual(Number(persisted.roas), 2.36, "roas retained");

  // payload_json: media presentation keys removed recursively, decision
  // evidence intact. Compared byte-for-byte against the exact expected object.
  const payload = persisted.payload_json as Record<string, unknown>;
  expectEqual(
    payload,
    {
      ad_id: AD_ID,
      spend: 42.15,
      purchases: 3,
      nested: {
        keep_me: "economic",
        deeper: [{ roas: 2.36 }],
      },
    },
    "payload_json stripped of media keys, decision evidence intact",
  );

  // ---------------------------------------------------------------- lane 3
  // A refused write after a successful one leaves the stored row untouched:
  // failing closed must not be a partial mutation.
  const before = JSON.stringify(await readAdDay());
  let secondRefusalThrew = false;
  try {
    await upsertMetaAdDailyRows(
      [adDailyRow({ spend: 999999, payloadJson: { tampered: true } })],
      { writeMode: "creative_enrichment" } as never,
    );
  } catch {
    secondRefusalThrew = true;
  }
  if (!secondRefusalThrew) fail("post-write refusal", "unauthorized write was accepted");
  expectEqual(
    JSON.stringify(await readAdDay()),
    before,
    "refused write leaves the existing fact row byte-for-byte unchanged",
  );

  // ---------------------------------------------------------------- lane 4
  // Creatives metadata sync performs zero meta_ad_daily writes. Proven from
  // the shipped source rather than by running a live provider sync.
  const creatives = readFileSync("lib/meta/creatives-warehouse.ts", "utf8");
  if (creatives.includes("upsertMetaAdDailyRows(")) {
    fail(
      "creatives sync ownership",
      "lib/meta/creatives-warehouse.ts still calls upsertMetaAdDailyRows",
    );
  }
  for (const required of [
    "upsertMetaCreativeDailyRows(",
    "upsertMetaCreativeMediaRows(",
  ]) {
    if (!creatives.includes(required)) {
      fail("creatives sync storage", `dedicated writer ${required} is missing`);
    }
  }

  console.log(
    `[${LABEL}] PASS: authoritative lane writes facts with media keys stripped, every other lane fails closed before mutation, creatives sync owns zero Ad-days.`,
  );
}

main()
  .then(async () => {
    const db = getDb();
    await db.query(`DELETE FROM meta_ad_daily WHERE business_id = $1`, [
      BUSINESS_ID,
    ]);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
