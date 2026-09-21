import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationDbMockModule } from "@/lib/__tests__/pinned-migration-client-mock";

/**
 * The storage contract for the commerce cost structure.
 *
 * These assertions are about SHAPE, and every one of them is load-bearing at
 * runtime: the unique history index is what makes a version immutable, the
 * CASCADE is what makes deleting a business remove its costs, and the revision
 * CHECK is what stops a stored row from impersonating "nothing stored".
 *
 * The index statements in phase 4 are all built under `.catch(() => {})`, so a
 * failed build cannot be seen at deploy time. That is why the definitions are
 * pinned here and in `lib/migration-verification.ts` rather than trusted.
 */

vi.mock("@/lib/migration-verification", () => ({
  // This suite drives the migration statements against a fake SQL client, so
  // there is no catalog for the post-migration verifier to read. Its own
  // behaviour is covered in lib/migration-verification.test.ts.
  verifyMigrationSchemaContract: vi.fn(async () => ({ verified: 0 })),
}));

vi.mock("@/lib/meta/automation-claim-schema-verification", () => ({
  assertMetaAutomationClaimSchema: vi.fn(async () => []),
}));

vi.mock("@/lib/meta/budget-schema-verification", () => ({
  assertD088BudgetSchema: vi.fn(async () => ({
    contract: "meta.d088-budget-schema-verification.v1",
    verified: [],
  })),
  D088BudgetSchemaError: class extends Error {},
}));

const CURRENT_TABLE = "business_commerce_cost_structures";
const HISTORY_TABLE = "business_commerce_cost_structure_history";
const SHOPIFY_COST_TABLE = "shopify_variant_unit_costs";
const SHOPIFY_COST_HISTORY_TABLE = "shopify_variant_unit_cost_history";

async function collectMigrationStatements(): Promise<string[]> {
  const queries: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    }),
    {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    },
  );

  vi.doMock("@/lib/db", () => migrationDbMockModule(sql, { catalog: "small" }));
  vi.doMock("@/lib/startup-diagnostics", () => ({
    logStartupError: vi.fn(),
    logStartupEvent: vi.fn(),
  }));

  const { runMigrations } = await import("@/lib/migrations");
  await runMigrations({
    force: true,
    reason: "test",
    verifyNativeSchemaCapabilities: false,
  });

  return queries;
}

/** The body of one CREATE TABLE, so a column assertion cannot match elsewhere. */
function tableBody(joined: string, table: string): string {
  const start = joined.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start, `${table} is created`).toBeGreaterThan(-1);
  const rest = joined.slice(start);
  return rest.slice(0, rest.indexOf(")`") > -1 ? rest.indexOf("\n") + 4000 : 4000);
}

describe("commerce cost structure migrations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("ENABLE_RUNTIME_MIGRATIONS", "true");
  });

  it("creates the current row and its history additively", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${CURRENT_TABLE} (`);
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (`);

    for (const table of [CURRENT_TABLE, HISTORY_TABLE]) {
      const body = tableBody(joined, table);
      expect(body, `${table} cascades from businesses`).toContain(
        "business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE",
      );
      // Removing a user must not remove the record of what they stored.
      expect(body, `${table} keeps its audit row`).toContain(
        "updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL",
      );
      expect(body, `${table} stores the structure as jsonb`).toContain(
        "structure            JSONB NOT NULL",
      );
      expect(body, `${table} bounds the version`).toContain("CHECK (version > 0)");
      // The row and the JSON can never disagree about whose structure this is.
      expect(body).toContain("CHECK (lower(structure->>'businessId') = business_id::text)");
      expect(body).toContain("CHECK ((structure->>'version')::integer = version)");
      expect(body).toContain("CHECK (jsonb_typeof(structure) = 'object')");
    }
  });

  it("reserves the all-zero revision so a stored row cannot impersonate absence", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    // 64 zeros is reserved and can never collide with a real stored revision.
    // back. If a stored row could carry it, that token would stop meaning
    // "nothing is stored" and a stale first save could overwrite a real version.
    for (const table of [CURRENT_TABLE, HISTORY_TABLE]) {
      expect(tableBody(joined, table)).toContain(
        "CHECK (revision ~ '^[0-9a-f]{64}$' AND revision !~ '^0{64}$')",
      );
    }
  });

  it("holds one current row per business and a unique version per history entry", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    expect(tableBody(joined, CURRENT_TABLE)).toContain("UNIQUE (business_id)");

    // What makes the history append-only rather than append-mostly.
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uniq_business_commerce_cost_history_version",
    );
    expect(joined).toContain(`ON ${HISTORY_TABLE} (business_id, version)`);
    // The current table must NOT constrain (business_id, version): it holds one
    // row that changes version, and a unique index there would say nothing.
    expect(tableBody(joined, CURRENT_TABLE)).not.toContain("UNIQUE (business_id, version)");
  });

  it("does not impose the target-pack time ordering, because a cost may be forward-dated", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    // business_target_pack_history asserts effective_at <= recorded_at. A cost
    // structure declared today to take effect next month is correct input, so
    // the same check here would reject legitimate operator intent.
    for (const table of [CURRENT_TABLE, HISTORY_TABLE]) {
      expect(tableBody(joined, table)).not.toContain("CHECK (effective_from <= recorded_at)");
      expect(tableBody(joined, table)).toContain("effective_from       TIMESTAMPTZ NOT NULL");
      expect(tableBody(joined, table)).toContain("recorded_at          TIMESTAMPTZ NOT NULL");
    }
  });

  it("indexes both time orders the history is read in", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    // Transaction time: the newest version first.
    expect(joined).toContain(
      "CREATE INDEX IF NOT EXISTS idx_business_commerce_cost_history_recorded",
    );
    expect(joined).toContain(
      `ON ${HISTORY_TABLE} (business_id, recorded_at DESC, version DESC, id DESC)`,
    );
    // Valid time: which structure applied on a given day.
    expect(joined).toContain(
      "CREATE INDEX IF NOT EXISTS idx_business_commerce_cost_history_effective",
    );
    expect(joined).toContain(
      `ON ${HISTORY_TABLE} (business_id, effective_from DESC, recorded_at DESC, id DESC)`,
    );
  });

  it("keeps every index name inside PostgreSQL's 63-byte identifier limit", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    // `CREATE INDEX IF NOT EXISTS` matches by NAME. A name over 63 bytes is
    // silently truncated, so two long names can collide and the second index is
    // then never built -- under `.catch(() => {})`, invisibly.
    const names = [...joined.matchAll(/INDEX IF NOT EXISTS (\S+)/g)]
      .map((match) => match[1] as string)
      .filter(
        (name) => name.includes("commerce_cost") || name.includes("shopify_variant_unit_cost"),
      );

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(Buffer.byteLength(name, "utf8"), name).toBeLessThanOrEqual(63);
    }
    expect(new Set(names).size, "index names are distinct").toBe(names.length);
  });

  it("never drops, rewrites or backfills either table", async () => {
    const statements = await collectMigrationStatements();
    const joined = statements.join("\n");

    for (const table of [
      CURRENT_TABLE,
      HISTORY_TABLE,
      SHOPIFY_COST_TABLE,
      SHOPIFY_COST_HISTORY_TABLE,
    ]) {
      expect(joined).not.toContain(`DROP TABLE ${table}`);
      expect(joined).not.toContain(`DROP TABLE IF EXISTS ${table}`);
      expect(joined).not.toMatch(new RegExp(`ALTER TABLE ${table}\\s+DROP COLUMN`));
      expect(joined).not.toContain(`TRUNCATE ${table}`);
    }

    // No bootstrap backfill, deliberately. The legacy percentages are served as
    // a read-only preview at request time; writing them here would store an
    // unconfirmed estimate as though an operator had declared it, and every
    // business would appear to have a confirmed cost structure it never saw.
    expect(joined).not.toMatch(new RegExp(`INSERT INTO ${CURRENT_TABLE}`));
    expect(joined).not.toMatch(new RegExp(`INSERT INTO ${HISTORY_TABLE}`));
    expect(joined).not.toMatch(new RegExp(`UPDATE ${HISTORY_TABLE}`));
  });

  it("creates each table before the statements that index it", async () => {
    const statements = await collectMigrationStatements();
    const indexOfMatch = (needle: string) =>
      statements.findIndex((statement) => statement.includes(needle));

    for (const table of [
      CURRENT_TABLE,
      HISTORY_TABLE,
      SHOPIFY_COST_TABLE,
      SHOPIFY_COST_HISTORY_TABLE,
    ]) {
      const created = indexOfMatch(`CREATE TABLE IF NOT EXISTS ${table} (`);
      const firstIndex = statements.findIndex(
        (statement) => statement.includes("INDEX IF NOT EXISTS") && statement.includes(table),
      );
      expect(created, `${table} created`).toBeGreaterThan(-1);
      expect(firstIndex, `${table} indexed`).toBeGreaterThan(created);
    }
  });

  it("creates a separate Shopify unit-cost catalog with missing-cost and history semantics", async () => {
    const joined = (await collectMigrationStatements()).join("\n");

    for (const table of [SHOPIFY_COST_TABLE, SHOPIFY_COST_HISTORY_TABLE]) {
      const body = tableBody(joined, table);
      expect(body).toContain(
        "business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE",
      );
      expect(body).toContain("unit_cost             NUMERIC(20, 6)");
      expect(body).toContain("CHECK ((unit_cost IS NULL) = (currency_code IS NULL))");
      expect(body).toContain("CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$')");
    }
    expect(tableBody(joined, SHOPIFY_COST_TABLE)).toContain(
      "UNIQUE (business_id, provider_account_id, variant_id)",
    );
    expect(tableBody(joined, SHOPIFY_COST_HISTORY_TABLE)).toContain(
      "change_kind           TEXT NOT NULL CHECK (change_kind IN ('observed', 'removed'))",
    );
    expect(joined).toContain("idx_shopify_variant_unit_costs_missing");
    expect(joined).toContain("WHERE unit_cost IS NULL");
  });

  it("issues only idempotent statements for these tables, so every deploy re-runs safely", async () => {
    const first = await collectMigrationStatements();
    vi.resetModules();
    const second = await collectMigrationStatements();

    const ours = (statements: string[]) =>
      statements.filter(
        (statement) =>
          statement.includes("commerce_cost_structure") ||
          statement.includes("shopify_variant_unit_cost"),
      );

    expect(ours(second)).toEqual(ours(first));
    for (const statement of ours(first)) {
      expect(statement.trim()).toMatch(
        /^(CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS|ALTER TABLE .* ADD COLUMN IF NOT EXISTS)/,
      );
    }
  });

  it("is registered in the gates that prove the tables exist after a from-zero deploy", async () => {
    // importActual: this suite mocks the verifier's runtime entry point, but the
    // registration lists it exports are exactly what is under assertion here.
    const [{ VERIFIED_TABLES, VERIFIED_FOREIGN_KEYS, VERIFIED_INDEXES }, fromZero] =
      await Promise.all([
        vi.importActual<typeof import("@/lib/migration-verification")>(
          "@/lib/migration-verification",
        ),
        import("node:fs/promises").then((fs) =>
          fs.readFile("scripts/ephemeral-postgres-migrations-check.ts", "utf8"),
        ),
      ]);

    for (const table of [
      CURRENT_TABLE,
      HISTORY_TABLE,
      SHOPIFY_COST_TABLE,
      SHOPIFY_COST_HISTORY_TABLE,
    ]) {
      expect(VERIFIED_TABLES, `${table} post-migration assertion`).toContain(table);
      expect(fromZero, `${table} from-zero assertion`).toContain(`"${table}"`);
      expect(
        VERIFIED_FOREIGN_KEYS.some(
          (key) =>
            key.table === table && key.column === "business_id" && key.onDelete === "c",
        ),
        `${table} business cascade`,
      ).toBe(true);
    }

    expect(
      VERIFIED_INDEXES.some(
        (index) =>
          index.name === "uniq_business_commerce_cost_history_version" &&
          index.unique &&
          index.predicate === null,
      ),
      "the unique history index is verified against the real catalog",
    ).toBe(true);
  });
});
