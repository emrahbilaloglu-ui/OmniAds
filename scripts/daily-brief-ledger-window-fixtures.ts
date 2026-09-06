import { readFileSync } from "node:fs";

type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Execute the actual ledger query across session zones, in an isolated transaction. */
export async function verifyDailyBriefLedgerWindowFixtures(query: Query): Promise<number> {
  const source = readFileSync("lib/meta/daily-brief.ts", "utf8");
  const body = source.slice(source.indexOf("async function readOvernightLedger("));
  const sql = body.match(/`(SELECT result_status,[\s\S]*?)`,\s*\[/)?.[1];
  if (!sql) throw new Error("Cannot locate the daily brief ledger query");
  const businessId = "e11a0000-0000-4000-8000-000000000001";
  const otherBusinessId = "e11a0000-0000-4000-8000-000000000002";
  const settings = await query("SELECT current_setting('TimeZone') AS zone, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today");
  const originalZone = String(settings[0].zone);
  const today = String(settings[0].today);
  await query(`CREATE TEMP TABLE meta_automation_activity_ledger (
    business_id UUID, result_status TEXT, created_at TIMESTAMPTZ
  ) ON COMMIT DROP`);
  let cases = 0;
  try {
    for (const asOf of ["2026-03-08", "2025-11-02", today]) {
      await query("TRUNCATE pg_temp.meta_automation_activity_ledger");
      await query(`WITH anchor AS (
        SELECT LEAST(now(), ($2::date + interval '1 day') AT TIME ZONE 'UTC') AS upper_bound
      )
      INSERT INTO pg_temp.meta_automation_activity_ledger
      SELECT $1::uuid, fixture.result_status, upper_bound + fixture.delta
      FROM anchor CROSS JOIN (VALUES
        ('applied', interval '-24 hours -1 second'),
        ('applied', interval '-24 hours'),
        ('applied', interval '-1 second'),
        ('failed', interval '-12 hours'),
        ('failed', interval '0 seconds'),
        ('failed', interval '1 second')
      ) AS fixture(result_status, delta)`, [businessId, asOf]);
      await query(`INSERT INTO pg_temp.meta_automation_activity_ledger
        SELECT $1::uuid, result_status, created_at FROM pg_temp.meta_automation_activity_ledger`, [otherBusinessId]);
      for (const zone of ["UTC", "Europe/Istanbul", "America/New_York", "Pacific/Kiritimati"]) {
        await query("SELECT set_config('TimeZone', $1, true)", [zone]);
        const rows = await query(sql, [businessId, asOf]);
        const counts = new Map(rows.map((row) => [row.result_status, Number(row.count)]));
        if (counts.get("applied") !== 2 || counts.get("failed") !== 1 || counts.size !== 2) {
          throw new Error(`Ledger window changed with session zone ${zone}, asOf ${asOf}: ${JSON.stringify(rows)}`);
        }
        cases += 1;
      }
    }
  } finally {
    await query("SELECT set_config('TimeZone', $1, true)", [originalZone]);
  }
  return cases;
}
