import { beforeEach, expect, it, vi } from "vitest";
import { runWithMetaVerificationTimezoneObservations } from "./verification-timezone-observation";

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.sql, getDbWithTimeout: () => mocks.sql, runDbTransaction: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({ assertDbSchemaReady: vi.fn(async () => undefined) }));
vi.mock("@/lib/migrations", () => ({ runMigrations: vi.fn() }));
const { getMetaPublishedVerificationSummary } = await import("./warehouse");
const input = { businessId: "owned", providerAccountIds: ["act_owned"], surfaces: ["account_daily" as const], startDate: "2026-10-11", endDate: "2026-10-17" };
beforeEach(() => { mocks.sql.mockReset().mockResolvedValue([]); });
const timezones = () => mocks.sql.mock.calls.filter(([parts]) => parts.join("").includes("WITH manifest_accounts AS"));

it("loads timezone facts once while retaining independent date/surface verification reads", async () => {
  await runWithMetaVerificationTimezoneObservations(async () => {
    const result = await Promise.all([
      getMetaPublishedVerificationSummary(input),
      getMetaPublishedVerificationSummary({ ...input, startDate: input.endDate }),
      getMetaPublishedVerificationSummary({ ...input, surfaces: ["campaign_daily"] }),
    ]);
    expect(result.map((r) => r.totalDays)).toEqual([7, 1, 7]);
    expect(result.every((r) => !r.truthReady)).toBe(true);
    expect(timezones()).toHaveLength(1);
    expect(mocks.sql).toHaveBeenCalledTimes(16);
  });
});

it("keeps non-scoped callers independent", async () => {
  await Promise.all([getMetaPublishedVerificationSummary(input), getMetaPublishedVerificationSummary(input), getMetaPublishedVerificationSummary(input)]);
  expect(timezones()).toHaveLength(3);
  expect(mocks.sql).toHaveBeenCalledTimes(18);
});

it("does not combine business, account or deadline boundaries", async () => {
  await runWithMetaVerificationTimezoneObservations(async () => {
    await getMetaPublishedVerificationSummary(input);
    await getMetaPublishedVerificationSummary({ ...input, businessId: "other" });
    await getMetaPublishedVerificationSummary({ ...input, providerAccountIds: ["other_account"] });
    await getMetaPublishedVerificationSummary({ ...input, timeoutMs: 5000 });
  });
  expect(timezones()).toHaveLength(4);
});

it.runIf(process.env.ADSECUTE_VERIFICATION_TZ_OWNED_PG === "1")("executes the unchanged timezone SQL once on guarded owned PostgreSQL, retaining all date verification reads", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe("/adsecute_verification_timezone");
  expect([5432, 15432]).not.toContain(Number(url.port));
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url.href, ssl: false, max: 1 });
  const client = await pool.connect();
  let queryTail = Promise.resolve();
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TEMP TABLE meta_authoritative_source_manifests
        (business_id text, provider_account_id text, account_timezone text, updated_at timestamptz);
      CREATE TEMP TABLE meta_account_daily
        (business_id text, provider_account_id text, account_timezone text, date date, updated_at timestamptz);
      INSERT INTO meta_authoritative_source_manifests
        SELECT 'owned', 'decoy_'||n, 'UTC', now() FROM generate_series(1,20000) n;
      INSERT INTO meta_authoritative_source_manifests VALUES
        ('owned','act_owned','America/Anchorage',now()),
        ('owned','act_owned','UTC',now()-interval '1 day'),
        ('other','act_owned','Europe/Paris',now()),
        ('owned','other_account','Asia/Tokyo',now());
      INSERT INTO meta_account_daily VALUES
        ('owned','act_owned','UTC',date '2026-10-17',now());
      CREATE INDEX ON meta_authoritative_source_manifests(business_id,provider_account_id,updated_at DESC);
      CREATE INDEX ON meta_account_daily(business_id,provider_account_id,date DESC,updated_at DESC);
    `);
    const statements: Array<{ text: string; args: unknown[]; rows: unknown[] }> = [];
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray, ...args: unknown[]) => {
      const text = parts.reduce((value, part, index) => value + (index ? `$${index}` : "") + part, "");
      if (!text.includes("WITH manifest_accounts AS")) return [];
      const query = queryTail.then(() => client.query(text, args));
      queryTail = query.then(() => undefined, () => undefined);
      const rows = (await query).rows;
      statements.push({ text, args, rows });
      return rows;
    });
    const read = () => Promise.all([
      getMetaPublishedVerificationSummary(input),
      getMetaPublishedVerificationSummary({ ...input, startDate: input.endDate }),
      getMetaPublishedVerificationSummary({ ...input, surfaces: ["campaign_daily"] }),
    ]);
    const independent = await read();
    expect(statements).toHaveLength(3);
    expect(mocks.sql).toHaveBeenCalledTimes(18);
    expect(statements[0]!.rows).toEqual([{ provider_account_id: "act_owned", account_timezone: "America/Anchorage" }]);
    const original = statements[0]!;
    mocks.sql.mockClear(); statements.length = 0;
    const observed = await runWithMetaVerificationTimezoneObservations(read);
    expect(statements).toHaveLength(1);
    expect(mocks.sql).toHaveBeenCalledTimes(16);
    expect(statements[0]).toEqual(original);
    expect(observed).toEqual(independent);
    expect(observed.map((row) => row.totalDays)).toEqual([7, 1, 7]);
    expect(observed.every((row) => !row.truthReady)).toBe(true);
    console.log("owned-verification-timezone", JSON.stringify({
      independentTimezoneQueries: 3, scopedTimezoneQueries: 1,
      independentAllQueries: 18, scopedAllQueries: 16,
      sameSqlBindingsAndRows: true, sameIndependentDateProofs: true,
      decoyAccounts: 20000, productionAccess: false,
    }));
  } finally {
    await queryTail;
    await client.query("ROLLBACK"); client.release(); await pool.end();
  }
});
