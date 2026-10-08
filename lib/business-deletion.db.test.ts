import { randomUUID, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, runDbTransaction } from "@/lib/db";
import { BusinessDeletionError, deleteBusinessWithData } from "@/lib/business-deletion";

// Only the migrated, disposable cluster may execute these destructive fixtures.
const seam = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
if (seam) {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || ["5432", "15432", ""].includes(url.port)) throw new Error("Unsafe deletion test database");
}

async function fixture() {
  const sql = getDb();
  const [user] = await sql`INSERT INTO users (name, email, password_hash)
    VALUES ('Deletion fixture', ${`${randomUUID()}@example.invalid`}, 'fixture') RETURNING id`;
  const ids: string[] = [];
  const [account] = await sql`INSERT INTO provider_accounts (provider, external_account_id)
    VALUES ('meta', ${`act_delete_${randomUUID()}`}) RETURNING id, external_account_id`;
  for (const name of ["Remove this business", "Preserve this business"]) {
    const [business] = await sql`INSERT INTO businesses (name, owner_id) VALUES (${name}, ${user!.id}) RETURNING id`;
    const id = String(business!.id);
    ids.push(id);
    await sql`INSERT INTO memberships (user_id, business_id, role, status) VALUES (${user!.id}, ${id}, 'admin', 'active')`;
    await sql`INSERT INTO business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)
      VALUES (${id}, 'meta', ${account!.id}, ${account!.external_account_id})`;
    const [connection] = await sql`INSERT INTO provider_connections (business_id, provider, status)
      VALUES (${id}, 'meta', 'connected') RETURNING id`;
    await sql`INSERT INTO integration_credentials (provider_connection_id, access_token)
      VALUES (${connection!.id}, 'disposable-fixture')`;
    await sql`INSERT INTO meta_entity_observation_runs (business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, endpoint, observed_at, captured_at, completeness, run_hash)
      VALUES (${id}, ${id}, ${account!.id}, ${account!.external_account_id}, 'ad', 'ads', now(), now(), 'complete', ${randomBytes(32).toString("hex")})`;
    await sql`INSERT INTO business_cost_models (business_id) VALUES (${id})`;
  }
  await sql`INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
    VALUES (${user!.id}, ${randomUUID()}, ${ids[0]}, now() + interval '1 day')`;
  return { businessId: ids[0]!, otherId: ids[1]!, userId: String(user!.id), accountId: String(account!.id) };
}

async function remains(id: string, table = "businesses", column = "id") {
  return (await getDb().query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [id])).length === 1;
}

// This recovery table is created by an optional normalization tool, so the
// canonical migrations alone cannot reproduce its presence on older databases.
async function normalizationArchive(businessId: string) {
  await getDb()`CREATE TABLE db_normalization_orphan_core_legacy (
    id BIGSERIAL PRIMARY KEY,
    source_table TEXT NOT NULL,
    business_id TEXT,
    provider TEXT,
    payload_hash TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    reason TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_table, payload_hash)
  )`;
  await getDb()`INSERT INTO db_normalization_orphan_core_legacy
    (source_table, business_id, provider, payload_hash, payload_json, reason)
    VALUES ('provider_connections', ${businessId}, 'meta', 'fixture-hash',
      '{"fixture":"recovery-original"}'::jsonb, 'business_missing_during_normalization')`;
  return getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`;
}

describe.skipIf(!seam)("business deletion on the full migrated PostgreSQL schema", () => {
  beforeEach(() => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
  });

  it("reproduces the old teardown's foreign-key failure and proves its rollback", async () => {
    const { businessId } = await fixture();
    await expect(runDbTransaction(async () => {
      await getDb()`DELETE FROM memberships WHERE business_id = ${businessId}`;
      await getDb()`DELETE FROM business_provider_accounts WHERE business_id = ${businessId}`;
    })).rejects.toMatchObject({ code: "23503", constraint: "meta_entity_observation_runs_binding_fk" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("deletes provenance children first, credentials and facts, preserving shared accounts and the other tenant", async () => {
    const { businessId, otherId, userId, accountId } = await fixture();
    await deleteBusinessWithData(businessId);
    for (const table of ["memberships", "business_provider_accounts", "provider_connections", "meta_entity_observation_runs", "business_cost_models"]) {
      expect(await remains(businessId, table, "business_id"), table).toBe(false);
      expect(await remains(otherId, table, "business_id"), table).toBe(true);
    }
    expect(await remains(businessId)).toBe(false);
    expect(await remains(otherId)).toBe(true);
    expect(await remains(userId, "users")).toBe(true);
    expect(await remains(accountId, "provider_accounts")).toBe(true);
    const [session] = await getDb()`SELECT active_business_id FROM sessions WHERE user_id = ${userId}`;
    expect(session!.active_business_id).toBeNull();
    const credentials = await getDb()`SELECT credentials.id FROM integration_credentials credentials
      JOIN provider_connections connection ON connection.id = credentials.provider_connection_id
      WHERE connection.business_id = ${otherId}`;
    expect(credentials).toHaveLength(1);
  });

  it("refuses protected native evidence without disabling its DELETE guard or losing access", async () => {
    const { businessId } = await fixture();
    await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id, payload_sha256, storage_encoding_version, payload_json, byte_length)
      VALUES (${businessId}, sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'native-campaign-context-jsonb.v1', '{}'::jsonb, 2)`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "protected_history" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
    await expect(getDb()`DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id = ${businessId}`).rejects.toThrow();
  });

  it("rejects an unreviewed new ownership table before any destructive query", async () => {
    const { businessId } = await fixture();
    await getDb()`CREATE TABLE business_delete_unknown_fixture (business_id text)`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "schema_not_ready" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
    } finally { await getDb()`DROP TABLE business_delete_unknown_fixture`; }
  });

  it("removes an unrelated business while preserving the legacy recovery archive byte for byte", async () => {
    const { businessId, otherId } = await fixture();
    const archiveBefore = await normalizationArchive(randomUUID());
    try {
      await getDb()`CREATE FUNCTION business_delete_archive_fixture_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Recovery archive DELETE is forbidden'; END $$`;
      await getDb()`CREATE TRIGGER business_delete_archive_fixture_guard
        BEFORE DELETE ON db_normalization_orphan_core_legacy FOR EACH STATEMENT
        EXECUTE FUNCTION business_delete_archive_fixture_guard()`;
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(await remains(otherId, "memberships", "business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`).toEqual(archiveBefore);
    } finally {
      await getDb()`DROP TABLE db_normalization_orphan_core_legacy`;
      await getDb()`DROP FUNCTION IF EXISTS business_delete_archive_fixture_guard()`;
    }
  });

  it("refuses target-owned normalization recovery history before changing business access or facts", async () => {
    const { businessId } = await fixture();
    const archiveBefore = await normalizationArchive(businessId);
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({
        code: "protected_history", tables: ["db_normalization_orphan_core_legacy"],
      });
      expect(await remains(businessId)).toBe(true);
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await remains(businessId, "meta_entity_observation_runs", "business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`).toEqual(archiveBefore);
    } finally { await getDb()`DROP TABLE db_normalization_orphan_core_legacy`; }
  });

  it("rolls every change back when an unforeseen indirect foreign key refuses deletion", async () => {
    const { businessId } = await fixture();
    await getDb()`CREATE TABLE business_delete_fk_fixture (member_id uuid REFERENCES memberships(id) ON DELETE RESTRICT)`;
    await getDb()`INSERT INTO business_delete_fk_fixture SELECT id FROM memberships WHERE business_id = ${businessId}`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "23503" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await remains(businessId, "meta_entity_observation_runs", "business_id")).toBe(true);
      expect(await remains(businessId, "provider_connections", "business_id")).toBe(true);
    } finally { await getDb()`DROP TABLE business_delete_fk_fixture`; }
  });

  it("does not delete while a provider runner owns a live lease", async () => {
    const { businessId } = await fixture();
    await getDb()`INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
      VALUES (${businessId}, 'meta', 'disposable-owner', now() + interval '10 minutes')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "business_busy" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("allows data removal under a growth refusal, without changing the growth budget", async () => {
    const { businessId } = await fixture();
    const old = process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
    process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = "1";
    try {
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES).toBe("1");
    } finally {
      if (old === undefined) delete process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
      else process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = old;
    }
  });

  it("refuses contradictory canonical and text ownership without touching either tenant", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO provider_connections (business_id, business_ref_id, provider)
      VALUES (${businessId}, ${otherId}, 'shopify')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "scope_conflict" });
    expect(await remains(businessId)).toBe(true);
    expect(await remains(otherId)).toBe(true);
  });

  it("keeps the assignment kill switch authoritative", async () => {
    const { businessId } = await fixture();
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    await expect(deleteBusinessWithData(businessId)).rejects.toThrow("disabled");
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("returns not found without attempting a purge for an absent business", async () => {
    await expect(deleteBusinessWithData(randomUUID())).rejects.toBeInstanceOf(BusinessDeletionError);
  });

  it("preserves frozen campaign label history instead of introducing a new writer", async () => {
    const { businessId } = await fixture();
    await getDb()`INSERT INTO meta_campaign_labels (business_id, campaign_id, campaign_kind)
      VALUES (${businessId}, 'frozen-history', 'main')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "protected_history" });
    expect(await remains(businessId, "meta_campaign_labels", "business_id")).toBe(true);
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });
});
