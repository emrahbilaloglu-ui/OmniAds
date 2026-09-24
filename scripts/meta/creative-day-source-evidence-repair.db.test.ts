/** Exact creative-day repair pre-images against migrated, ephemeral PostgreSQL. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import {
  loadCreativeRowsWithExactWriteClocks,
  writeCreativeDayRepairChange,
} from "./creative-day-source-evidence-repair";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const scope = {
  businessId: "cdae0000-0000-4000-8000-000000000001",
  accountId: "act_cdae_microsecond_seam",
  from: "2026-09-21",
  to: "2026-09-21",
};
const creativeId = "creative_cdae_microsecond";
const initialClock = "2026-09-24 06:41:08.124868+00";
const sameMillisecondLaterClock = "2026-09-24 06:41:08.124999+00";

async function currentRow() {
  const rows = await loadCreativeRowsWithExactWriteClocks(scope);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function writeFrom(row: Awaited<ReturnType<typeof currentRow>>) {
  const oldPayload = row.payloadJson as Record<string, unknown>;
  return writeCreativeDayRepairChange(scope, {
    day: row.date, creativeId: row.creativeId,
    oldUpdatedAt: row.updatedAt!, oldPayload,
    nextPayload: { ...oldPayload, purchase_evidence: { state: "measured", value: 0 } },
    next: {
      spend: row.spend, impressions: row.impressions, clicks: row.clicks,
      reach: row.reach, frequency: row.frequency, conversions: row.conversions,
      revenue: row.revenue, roas: row.roas, cpa: row.cpa, ctr: row.ctr,
      cpc: row.cpc ?? null, linkClicks: row.linkClicks ?? null,
    },
  });
}

describe.skipIf(!SEAM)("creative-day repair exact PostgreSQL write clock", () => {
  beforeEach(async () => {
    await getDb().query(
      `DELETE FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2`,
      [scope.businessId, scope.accountId],
    );
    await getDb().query(
      `INSERT INTO meta_creative_daily (
         business_id, provider_account_id, date, creative_id,
         account_timezone, account_currency, spend, impressions, clicks,
         reach, conversions, revenue, roas, payload_json, updated_at
       ) VALUES ($1, $2, $3::date, $4, 'UTC', 'USD', 10, 100, 5,
         80, 0, 0, 0, $5::jsonb, $6::timestamptz)`,
      [scope.businessId, scope.accountId, scope.from, creativeId,
        JSON.stringify({ source_identity_version: "meta-creative-membership.v2" }),
        initialClock],
    );
  });

  afterAll(async () => {
    await getDb().query(
      `DELETE FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2`,
      [scope.businessId, scope.accountId],
    );
  });

  it("preserves microseconds in the reviewed clock and admits the exact pre-image", async () => {
    const row = await currentRow();
    expect(row.updatedAt).toBe("2026-09-24T06:41:08.124868Z");
    expect(new Date(row.updatedAt!).toISOString()).toBe("2026-09-24T06:41:08.124Z");
    await writeFrom(row);
    const [readback] = await getDb().query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2 AND creative_id=$3`,
      [scope.businessId, scope.accountId, creativeId],
    );
    expect(readback!.payload_json).toMatchObject({
      purchase_evidence: { state: "measured", value: 0 },
    });
  });

  it("refuses a clock changed within the same millisecond", async () => {
    const row = await currentRow();
    await getDb().query(
      `UPDATE meta_creative_daily SET updated_at=$4::timestamptz
        WHERE business_id=$1 AND provider_account_id=$2 AND creative_id=$3`,
      [scope.businessId, scope.accountId, creativeId, sameMillisecondLaterClock],
    );
    await expect(writeFrom(row)).rejects.toThrow(
      `creative_day_evidence_repair_update_conflict:${creativeId}`,
    );
    const [readback] = await getDb().query<{
      updated_at_exact: string; payload_json: Record<string, unknown>;
    }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact,
              payload_json
         FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2 AND creative_id=$3`,
      [scope.businessId, scope.accountId, creativeId],
    );
    expect(readback!.updated_at_exact).toBe("2026-09-24T06:41:08.124999Z");
    expect(readback!.payload_json).not.toHaveProperty("purchase_evidence");
  });

  it("refuses a changed JSON pre-image even when the exact clock is unchanged", async () => {
    const row = await currentRow();
    await getDb().query(
      `UPDATE meta_creative_daily SET payload_json=$4::jsonb
        WHERE business_id=$1 AND provider_account_id=$2 AND creative_id=$3`,
      [scope.businessId, scope.accountId, creativeId,
        JSON.stringify({ source_identity_version: "meta-creative-membership.v2", concurrent: true })],
    );
    await expect(writeFrom(row)).rejects.toThrow(
      `creative_day_evidence_repair_update_conflict:${creativeId}`,
    );
    const [readback] = await getDb().query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM meta_creative_daily
        WHERE business_id=$1 AND provider_account_id=$2 AND creative_id=$3`,
      [scope.businessId, scope.accountId, creativeId],
    );
    expect(readback!.payload_json).toMatchObject({ concurrent: true });
    expect(readback!.payload_json).not.toHaveProperty("purchase_evidence");
  });
});
