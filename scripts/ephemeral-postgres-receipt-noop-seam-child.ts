/** Real catalog/IF NOT EXISTS proof in the parent's isolated migrated database. */
import assert from "node:assert/strict";
import { getDb } from "@/lib/db";
import { assertReceiptIdentityMigrationCapacity, RECEIPT_IDENTITY_INDEX_CONTRACTS, RECEIPT_IDENTITY_INDEX_STATUS_SQL } from "@/lib/migrations";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "invalid:");
  assert.equal(process.env.ADSECUTE_EPHEMERAL_DB_SEAM, "1");
  assert.equal(url.hostname, "127.0.0.1");
  assert(!["", "5432", "15432"].includes(url.port));
  assert.equal(decodeURIComponent(url.pathname), "/adsecute_migrations_from_zero");
  const db = getDb();
  assert.equal((await db.query("SELECT current_database() AS name"))[0]?.name, "adsecute_migrations_from_zero");
  const contracts = JSON.stringify(RECEIPT_IDENTITY_INDEX_CONTRACTS);
  let heavySizeReads = 0;
  const observed = { query: async (text: string, params?: unknown[]) => {
    if (text.includes("COALESCE(pg_total_relation_size(to_regclass($1))")) heavySizeReads += 1;
    return db.query(text, params);
  } };
  const identities = () => db.query(`SELECT c.relname, c.oid::text, c.relfilenode::text
    FROM pg_class c WHERE c.oid=ANY(ARRAY(SELECT to_regclass('public.'||x.index_name)
      FROM jsonb_to_recordset($1::jsonb) AS x(index_name text))) ORDER BY c.relname`, [contracts]);
  const before = await identities();
  assert.equal(before.length, 5);
  assert.equal((await assertReceiptIdentityMigrationCapacity(observed)).engaged, false);
  assert.equal(heavySizeReads, 0);
  for (const contract of RECEIPT_IDENTITY_INDEX_CONTRACTS) {
    await db.query(contract.index_definition.replace(`INDEX ${contract.index_name}`, `INDEX CONCURRENTLY IF NOT EXISTS ${contract.index_name}`));
  }
  assert.deepEqual(await identities(), before); // No rebuilt index/changed physical identity.

  const cohort = RECEIPT_IDENTITY_INDEX_CONTRACTS.find((x) => x.index_name === "idx_meta_entity_observation_receipts_cohort_v2")!;
  const attempt = RECEIPT_IDENTITY_INDEX_CONTRACTS.find((x) => x.index_name === "meta_entity_observation_receipts_attempt_occurrence")!;
  const controls = [
    { name: "missing", contract: cohort, definition: null },
    { name: "wrong-key", contract: cohort, definition: `CREATE INDEX ${cohort.index_name} ON public.${cohort.table_name} (business_id)` },
    { name: "partial", contract: cohort, definition: cohort.index_definition + " WHERE provider_account_id IS NOT NULL" },
    { name: "included-column", contract: cohort, definition: cohort.index_definition + " INCLUDE (observed_at)" },
    { name: "nonunique-arbiter", contract: attempt, definition: attempt.index_definition.replace("CREATE UNIQUE INDEX", "CREATE INDEX") },
    { name: "wrong-null-sentinel", contract: attempt, definition: attempt.index_definition.replace("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001") },
  ];
  for (const control of controls) {
    await db.query(`DROP INDEX public.${control.contract.index_name}`);
    try {
      if (control.definition) await db.query(control.definition);
      const status = await db.query(RECEIPT_IDENTITY_INDEX_STATUS_SQL, [contracts]);
      assert.equal(status.length, 5);
      assert.equal(status.find((x) => x.index_name === control.contract.index_name)?.receipt_index_satisfied, false);
      const previous: number = heavySizeReads;
      await assertReceiptIdentityMigrationCapacity(observed);
      assert.equal(heavySizeReads, previous + 1); // Real small fixture; proves guard is called, not a production-size refusal.
    } finally {
      await db.query(`DROP INDEX IF EXISTS public.${control.contract.index_name}`);
      await db.query(control.contract.index_definition);
    }
  }
  assert.equal((await assertReceiptIdentityMigrationCapacity(observed)).engaged, false);
  assert.equal(heavySizeReads, controls.length);
  console.log(JSON.stringify({ contract: "receipt-index-noop-real-catalog-proof.v1", exactCatalogContracts: 5,
    existingIndexPhysicalIdentitiesUnchanged: true, controls: controls.map((x) => x.name),
    eachNegativeRequestedExistingHeavyGuard: true, fixturePhysicalSizeIsSmall: true, productionAccess: false }));
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
