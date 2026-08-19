/**
 * The breakdown ingestion gap, proven on a throwaway PostgreSQL.
 *
 * Two defects lived at the WRITE path and neither can be shown with a mocked
 * `sql`:
 *
 *  1. `age,gender` is a two-dimensional Meta breakdown that was stored under
 *     the single `age` identity, so every gender row collapsed onto its age
 *     bucket. Whether two dimensions can coexist for one account-day is a fact
 *     about the table's unique key — `(business_id, provider_account_id, date,
 *     breakdown_type, breakdown_key)` — and about whether replacing one slice
 *     deletes the other. Both are PostgreSQL's answer, so PostgreSQL gives it.
 *
 *  2. `reach` was created `BIGINT NOT NULL DEFAULT 0` while the fetch asked
 *     Meta for no reach at all, so an unmeasured reach was written as a
 *     measured zero. A mock would happily "store" `null` in a column that
 *     rejects it; only a real cluster proves the widening migration landed and
 *     that null survives the round trip.
 *
 * Also pinned here, because it is the dangerous half of adding a dimension: the
 * dirty-day coverage gate must count exactly the three EXPECTED types. A
 * `gender` row must never be able to stand in for a missing `country` and make
 * an incomplete day read as complete, and the absence of gender on the entire
 * retained history must never make a complete day read as incomplete.
 *
 * Run by `scripts/ephemeral-postgres-breakdown-dimension-seam.ts`, which boots a
 * throwaway cluster on a random free port (never 5432, never 15432) and migrates
 * it from zero. Outside that harness every test below SKIPS rather than run
 * against whatever `DATABASE_URL` happens to be — which, in this repo, is
 * production. A skipped run is not a pass, which is why the harness asserts the
 * tests actually executed.
 *
 * No provider client is imported anywhere in this file. Real provider writes
 * performed: zero.
 */
import { describe, expect, it } from "vitest";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const { getDb } = await import("@/lib/db");
const {
  getMetaBreakdownDailyRange,
  getMetaDirtyRecentDates,
  replaceMetaBreakdownDailySlice,
  upsertMetaBreakdownDailyRows,
} = await import("@/lib/meta/warehouse");
const { createMetaFinalizationCompletenessProof } = await import(
  "@/lib/meta/finalization-proof"
);

const BUSINESS_ID = "breakdown-dimension-seam-business";
const ACCOUNT_ID = "act_breakdown_dimension_seam";

type BreakdownRowOverrides = {
  date?: string;
  breakdownType: "age" | "gender" | "country" | "placement";
  breakdownKey: string;
  spend?: number;
  impressions?: number;
  reach?: number | null;
  frequency?: number | null;
};

function breakdownRow(overrides: BreakdownRowOverrides) {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    date: overrides.date ?? "2026-04-01",
    breakdownType: overrides.breakdownType,
    breakdownKey: overrides.breakdownKey,
    breakdownLabel: overrides.breakdownKey,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: overrides.spend ?? 1,
    impressions: overrides.impressions ?? 100,
    clicks: 1,
    reach: overrides.reach === undefined ? null : overrides.reach,
    frequency: overrides.frequency ?? null,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: null,
    ctr: null,
    cpc: null,
    sourceSnapshotId: null,
    truthState: "finalized" as const,
    truthVersion: 1,
    finalizedAt: "2026-04-02T00:00:00.000Z",
    validationStatus: "passed" as const,
    sourceRunId: "breakdown-dimension-seam-run",
  };
}

async function seedAccountDay(date: string) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_account_daily (
      business_id, provider_account_id, date, account_timezone, account_currency, spend
    )
    VALUES (${BUSINESS_ID}, ${ACCOUNT_ID}, ${date}::date, 'UTC', 'USD', 10)
    ON CONFLICT (business_id, provider_account_id, date) DO NOTHING
  `;
  await sql`
    INSERT INTO meta_campaign_daily (
      business_id, provider_account_id, date, campaign_id, account_timezone, account_currency, spend
    )
    VALUES (${BUSINESS_ID}, ${ACCOUNT_ID}, ${date}::date, 'cmp-1', 'UTC', 'USD', 10)
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO meta_adset_daily (
      business_id, provider_account_id, date, campaign_id, adset_id, account_timezone, account_currency, spend
    )
    VALUES (${BUSINESS_ID}, ${ACCOUNT_ID}, ${date}::date, 'cmp-1', 'adset-1', 'UTC', 'USD', 10)
    ON CONFLICT DO NOTHING
  `;
}

/** A finalize checkpoint at one breakdown scope, with no warehouse rows at all. */
async function seedFinalizedCheckpoint(date: string, checkpointScope: string) {
  const sql = getDb();
  const [partition] = (await sql`
    INSERT INTO meta_sync_partitions (
      business_id, provider_account_id, lane, scope, partition_date, status
    )
    VALUES (${BUSINESS_ID}, ${ACCOUNT_ID}, 'extended', ${checkpointScope}, ${date}::date, 'succeeded')
    ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)
    DO UPDATE SET status = 'succeeded'
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  await sql`
    INSERT INTO meta_sync_checkpoints (
      partition_id, business_id, provider_account_id, checkpoint_scope, phase, status
    )
    VALUES (
      ${partition!.id}::uuid, ${BUSINESS_ID}, ${ACCOUNT_ID}, ${checkpointScope}, 'finalize', 'succeeded'
    )
    ON CONFLICT (partition_id, checkpoint_scope) DO UPDATE SET status = 'succeeded'
  `;
}

async function reasonsFor(date: string) {
  const rows = await getMetaDirtyRecentDates({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    startDate: date,
    endDate: date,
  });
  return rows.find((row) => row.date === date)?.reasons ?? [];
}

// There is deliberately NO cleanup hook here. The harness hands this file a
// cluster that was created seconds earlier and is destroyed seconds later, so a
// reset would be pointless — and a mutating statement in a suite-level hook is
// exactly the thing that must not exist in a file whose default `DATABASE_URL`,
// outside the harness, is production.
describe.skipIf(!SEAM)("breakdown dimensions and reach, against real PostgreSQL", () => {
  it("stores age and gender as independent rows for the same account-day", async () => {
    // The fold, stated as storage: before this change one raw row produced ONE
    // warehouse row keyed by age, and the gender fact had nowhere to live. Both
    // keys below are deliberately the SAME string — the only thing separating
    // them is `breakdown_type`, so if the unique key did not carry the type
    // these two would collide and the second would overwrite the first.
    await upsertMetaBreakdownDailyRows([
      breakdownRow({ breakdownType: "age", breakdownKey: "unknown", spend: 7 }),
      breakdownRow({ breakdownType: "gender", breakdownKey: "unknown", spend: 3 }),
    ]);

    const rows = await getMetaBreakdownDailyRange({
      businessId: BUSINESS_ID,
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      providerAccountIds: [ACCOUNT_ID],
    });
    const byType = new Map(rows.map((row) => [row.breakdownType, row]));
    expect(byType.get("age")?.spend).toBe(7);
    expect(byType.get("gender")?.spend).toBe(3);
  });

  it("round-trips an unmeasured reach as null, and a measured zero as zero", async () => {
    // `reach` was `BIGINT NOT NULL DEFAULT 0`; this insert fails outright if the
    // widening migration did not run, which is the point of asserting it here
    // rather than in a mock that would accept anything.
    await upsertMetaBreakdownDailyRows([
      breakdownRow({
        date: "2026-04-05",
        breakdownType: "age",
        breakdownKey: "25-34",
        reach: null,
      }),
      breakdownRow({
        date: "2026-04-05",
        breakdownType: "age",
        breakdownKey: "45-54",
        reach: 0,
      }),
      breakdownRow({
        date: "2026-04-05",
        breakdownType: "age",
        breakdownKey: "35-44",
        reach: 80,
        frequency: 1.25,
      }),
    ]);

    const rows = await getMetaBreakdownDailyRange({
      businessId: BUSINESS_ID,
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: [ACCOUNT_ID],
    });
    const byKey = new Map(rows.map((row) => [row.breakdownKey, row]));

    // Never measured. NOT zero — the two are different claims and the column
    // can finally tell them apart.
    expect(byKey.get("25-34")?.reach).toBeNull();
    // Measured, and the answer was zero. Stays zero.
    expect(byKey.get("45-54")?.reach).toBe(0);
    expect(byKey.get("35-44")?.reach).toBe(80);

    const [raw] = (await getDb()`
      SELECT reach FROM meta_breakdown_daily
      WHERE business_id = ${BUSINESS_ID} AND date = '2026-04-05'::date AND breakdown_key = '25-34'
    `) as Array<{ reach: number | null }>;
    expect(raw?.reach).toBeNull();
  });

  it("replacing the gender slice does not touch the age slice", async () => {
    // `replaceMetaBreakdownDailySlice` DELETEs the slice before inserting. If it
    // were scoped by day alone rather than by day AND type, writing gender would
    // silently destroy the age rows written moments earlier in the same sync.
    const proof = createMetaFinalizationCompletenessProof({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      date: "2026-04-07",
      scope: "breakdown",
      sourceRunId: "breakdown-dimension-seam-run",
      complete: true,
      validationStatus: "passed",
    });

    await replaceMetaBreakdownDailySlice({
      slice: {
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        date: "2026-04-07",
        breakdownType: "age",
      },
      rows: [
        breakdownRow({ date: "2026-04-07", breakdownType: "age", breakdownKey: "25-34", spend: 4 }),
      ],
      proof,
    });
    await replaceMetaBreakdownDailySlice({
      slice: {
        businessId: BUSINESS_ID,
        providerAccountId: ACCOUNT_ID,
        date: "2026-04-07",
        breakdownType: "gender",
      },
      rows: [
        breakdownRow({ date: "2026-04-07", breakdownType: "gender", breakdownKey: "female", spend: 3 }),
        breakdownRow({ date: "2026-04-07", breakdownType: "gender", breakdownKey: "male", spend: 1 }),
      ],
      proof,
    });

    const rows = await getMetaBreakdownDailyRange({
      businessId: BUSINESS_ID,
      startDate: "2026-04-07",
      endDate: "2026-04-07",
      providerAccountIds: [ACCOUNT_ID],
    });
    expect(rows.filter((row) => row.breakdownType === "age")).toHaveLength(1);
    expect(rows.filter((row) => row.breakdownType === "gender")).toHaveLength(2);
    // The age spend is exactly what the age slice wrote — the gender write did
    // not merge into it and did not delete it.
    expect(rows.find((row) => row.breakdownType === "age")?.spend).toBe(4);
  });

  it("does not let a gender row stand in for a missing country", async () => {
    // The masking regression. `COUNT(DISTINCT breakdown_type) >= 3` over an
    // unfiltered set would see age + gender + placement, count three, and
    // declare the day covered while `country` is entirely absent.
    const date = "2026-04-10";
    await seedAccountDay(date);
    await upsertMetaBreakdownDailyRows([
      breakdownRow({ date, breakdownType: "age", breakdownKey: "25-34" }),
      breakdownRow({ date, breakdownType: "gender", breakdownKey: "female" }),
      breakdownRow({ date, breakdownType: "placement", breakdownKey: "facebook|feed|mobile" }),
    ]);

    expect(await reasonsFor(date)).toContain("missing_breakdown");
  });

  it("does not require gender on a day that carries the three expected types", async () => {
    // The mirror-image regression, and the shape of the ENTIRE retained
    // history: no day written before this change holds a gender row. Requiring
    // gender would have marked every one of them dirty and re-queued the whole
    // window.
    const date = "2026-04-11";
    await seedAccountDay(date);
    await upsertMetaBreakdownDailyRows([
      breakdownRow({ date, breakdownType: "age", breakdownKey: "25-34" }),
      breakdownRow({ date, breakdownType: "country", breakdownKey: "US" }),
      breakdownRow({ date, breakdownType: "placement", breakdownKey: "facebook|feed|mobile" }),
    ]);

    expect(await reasonsFor(date)).not.toContain("missing_breakdown");
  });

  it("counts coverage from finalized checkpoints through the fanned-out scope map", async () => {
    // Coverage can also come from checkpoints with no warehouse rows at all —
    // that UNION arm is where the `CASE ... THEN 'age'` used to live. Executed
    // against PostgreSQL so the VALUES join that replaced it is proven to parse
    // and to still resolve `breakdown:age,gender` to a real `age` coverage row.
    const date = "2026-04-12";
    await seedAccountDay(date);
    await seedFinalizedCheckpoint(date, "breakdown:age,gender");

    // age (and gender) alone is not three types.
    expect(await reasonsFor(date)).toContain("missing_breakdown");

    await seedFinalizedCheckpoint(date, "breakdown:country");
    await seedFinalizedCheckpoint(
      date,
      "breakdown:publisher_platform,platform_position,impression_device",
    );

    expect(await reasonsFor(date)).not.toContain("missing_breakdown");
  });
});
