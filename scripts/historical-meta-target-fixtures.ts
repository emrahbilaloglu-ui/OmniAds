import { readMetaCommercialTargets } from "@/lib/meta/commercial-targets";

type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Run inside runDbTransaction; all target history fixtures disappear on commit. */
export async function verifyHistoricalMetaTargetFixtures(query: Query): Promise<number> {
  const business = "d8a30000-0000-4000-8000-0000000000b1";
  const otherBusiness = "d8a30000-0000-4000-8000-0000000000b2";
  let passed = 0;
  function equal(actual: unknown, expected: unknown, label: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Historical target fixture failed [${label}]: ${JSON.stringify(actual)}`);
    }
    passed += 1;
  }
  await query(`CREATE TEMP TABLE business_target_pack_history (
    id BIGSERIAL PRIMARY KEY, business_id UUID, operation TEXT,
    target_cpa NUMERIC, target_roas NUMERIC, break_even_cpa NUMERIC,
    break_even_roas NUMERIC, contribution_margin_assumption NUMERIC,
    aov_assumption NUMERIC, new_customer_weight NUMERIC, default_risk_posture TEXT,
    cost_cogs_percent NUMERIC, cost_shipping_percent NUMERIC,
    cost_fulfillment_percent NUMERIC, cost_payment_processing_percent NUMERIC,
    source_label TEXT, updated_by_user_id UUID,
    effective_at TIMESTAMPTZ, recorded_at TIMESTAMPTZ
  ) ON COMMIT DROP`);
  await query(`INSERT INTO pg_temp.business_target_pack_history
    (business_id, operation, target_roas, effective_at, recorded_at) VALUES
    ($1, 'upsert', 2.2, '2026-09-03T02:00Z', '2026-09-03T02:00Z'),
    ($1, 'upsert', 4.5, '2026-09-03T04:00Z', '2026-09-03T02:30Z'),
    ($1, 'upsert', 8, '2026-09-03T02:30Z', '2026-09-03T04:00Z'),
    ($2, 'upsert', 20, '2026-09-03T02:50Z', '2026-09-03T02:50Z'),
    ($1, 'delete', NULL, '2026-09-05T02:00Z', '2026-09-05T02:00Z')`,
  [business, otherBusiness]);

  const atSnapshot = () => readMetaCommercialTargets(business, { asOf: "2026-09-03" });
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    await query("SELECT set_config('TimeZone', $1, true)", [zone]);
    const targets = await atSnapshot();
    equal([targets.source, targets.targetRoas, targets.freshness],
      ["configured_targets", 2.2, "fresh"], `${zone}: selected snapshot excludes future effective/recorded targets`);
  }
  const targets = await atSnapshot();
  equal([targets.targetCpa, targets.aovAssumption], [null, null], "ROAS history needs no mandatory CPA or AOV");
  equal((await readMetaCommercialTargets(business, { asOf: "2026-09-04" })).targetRoas,
    4.5, "next snapshot sees the later effective target");
  equal((await readMetaCommercialTargets(business, { asOf: "2026-09-05" })).source,
    "none", "later target removal does not rewrite earlier authority");
  equal((await readMetaCommercialTargets(business, { asOf: "2026-09-02" })).source,
    "none", "successful missing history stays absent");
  equal((await readMetaCommercialTargets(otherBusiness, { asOf: "2026-09-03" })).targetRoas,
    20, "business history remains isolated");

  // A failed history query must reject; the snapshot caller then withholds the
  // action. Recovering storage must expose the same past target on the next read.
  await query("SAVEPOINT historical_target_unreadable");
  await query("ALTER TABLE pg_temp.business_target_pack_history RENAME COLUMN target_roas TO hidden_target_roas");
  let failed = false;
  try { await atSnapshot(); } catch { failed = true; }
  await query("ROLLBACK TO SAVEPOINT historical_target_unreadable");
  await query("RELEASE SAVEPOINT historical_target_unreadable");
  equal(failed, true, "unreadable history is an error, not a current-target fallback");
  equal((await atSnapshot()).targetRoas, 2.2, "history read recovers after storage failure");
  return passed;
}
