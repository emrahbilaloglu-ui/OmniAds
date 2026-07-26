import { beforeEach, describe, expect, it, vi } from "vitest";

const getDbWithTimeout = vi.fn();

vi.mock("@/lib/db", () => ({ getDbWithTimeout }));

const {
  verifyMigrationSchemaContract,
  MigrationVerificationError,
  VERIFIED_COLUMNS,
  VERIFIED_TABLES,
  VERIFIED_FOREIGN_KEYS,
  VERIFIED_INDEXES,
} = await import("@/lib/migration-verification");

/**
 * A catalog that satisfies every declared contract, which individual cases then
 * damage in exactly one place. Building the healthy shape FROM the contracts
 * means a new contract entry cannot be added without the fixture answering it.
 */
function healthyCatalog(damage: {
  dropColumn?: string;
  dropTable?: string;
  dropIndex?: string;
  invalidateIndex?: string;
  flipForeignKeyAction?: string;
  wrongDefault?: string;
  writerThrows?: boolean;
} = {}) {
  const columns = VERIFIED_COLUMNS.filter(
    (spec) => `${spec.table}.${spec.column}` !== damage.dropColumn,
  ).map((spec) => ({
    table_name: spec.table,
    column_name: spec.column,
    data_type: spec.dataType,
    is_nullable: spec.isNullable ? "YES" : "NO",
    column_default:
      `${spec.table}.${spec.column}` === damage.wrongDefault
        ? "true"
        : (spec.columnDefault ?? null),
  }));
  const tables = VERIFIED_TABLES.filter((name) => name !== damage.dropTable).map(
    (name) => ({ table_name: name }),
  );
  const foreignKeys = VERIFIED_FOREIGN_KEYS.map((spec) => ({
    table_name: spec.table,
    column_name: spec.column,
    referenced_table: spec.referencedTable,
    on_delete:
      `${spec.table}.${spec.column}` === damage.flipForeignKeyAction
        ? "n"
        : spec.onDelete,
  }));
  const indexes = VERIFIED_INDEXES.filter(
    (spec) => spec.name !== damage.dropIndex,
  ).map((spec) => ({
    index_name: spec.name,
    table_name: spec.table,
    is_unique: spec.unique,
    is_valid: spec.name !== damage.invalidateIndex,
    is_ready: true,
    is_live: true,
    definition: `CREATE INDEX ${spec.name} ON ${spec.table} ${spec.definitionMustContain.join(" ")}`,
  }));

  const query = vi.fn(async (text: string) => {
    if (text.includes("BEGIN") || text.includes("ROLLBACK")) return [];
    if (text.includes("INSERT INTO") || text.startsWith("SELECT 1 FROM")) {
      if (damage.writerThrows) throw new Error("no unique or exclusion constraint matching");
      return [];
    }
    if (text.includes("information_schema.columns")) return columns;
    if (text.includes("information_schema.tables")) return tables;
    if (text.includes("pg_constraint")) return foreignKeys;
    if (text.includes("pg_get_indexdef")) return indexes;
    return [];
  });
  getDbWithTimeout.mockReturnValue({ query } as never);
  return query;
}

describe("verifyMigrationSchemaContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes on a schema that satisfies every declared contract", async () => {
    healthyCatalog();
    await expect(verifyMigrationSchemaContract()).resolves.toEqual({
      verified:
        VERIFIED_COLUMNS.length +
        VERIFIED_TABLES.length +
        VERIFIED_FOREIGN_KEYS.length +
        VERIFIED_INDEXES.length,
    });
  });

  it("fails on a missing column", async () => {
    healthyCatalog({ dropColumn: "meta_raw_snapshots.content_key" });
    // Adding the column is what every migration statement above swallows the
    // failure of, so this is the check standing between a swallowed error and
    // a "migrations_completed" over a schema that cannot store content keys.
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      MigrationVerificationError,
    );
  });

  it("fails on a missing table", async () => {
    healthyCatalog({ dropTable: "meta_raw_snapshot_observations" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /meta_raw_snapshot_observations/,
    );
  });

  it("fails on a missing index", async () => {
    healthyCatalog({ dropIndex: "meta_raw_snapshots_content_identity" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /meta_raw_snapshots_content_identity/,
    );
  });

  it("fails on an index left INVALID by an interrupted concurrent build", async () => {
    // The case that motivates the whole check: the index exists, is named
    // correctly, and IF NOT EXISTS will never recreate it — but PostgreSQL
    // will not use it, so the destructive path silently runs on a seq scan.
    healthyCatalog({ invalidateIndex: "shopify_raw_snapshots_content_identity" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(/not usable/);
  });

  it("fails when a load-bearing ON DELETE action is wrong", async () => {
    // RESTRICT -> SET NULL is silent data loss: retention would delete
    // referenced content and null the provenance instead of refusing.
    healthyCatalog({
      flipForeignKeyAction: "meta_raw_snapshot_observations.snapshot_id",
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(/ON DELETE/);
  });

  it("fails when the selection default did not flip to false", async () => {
    healthyCatalog({ wrongDefault: "business_provider_accounts.is_selected" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /column_default/,
    );
  });

  it("fails when the writer's ON CONFLICT arbiter is not inferable", async () => {
    // Every catalog assertion can pass while the exact statement the
    // application issues still fails, so the contract includes a real write.
    healthyCatalog({ writerThrows: true });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /writer_compatibility/,
    );
  });

  it("rolls back the compatibility write even when it fails", async () => {
    const query = healthyCatalog({ writerThrows: true });
    await verifyMigrationSchemaContract().catch(() => undefined);
    expect(query.mock.calls.some(([text]) => String(text).includes("ROLLBACK"))).toBe(
      true,
    );
  });
});
