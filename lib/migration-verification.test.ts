import { beforeEach, describe, expect, it, vi } from "vitest";

const getDbWithTimeout = vi.fn();

vi.mock("@/lib/db", () => ({ getDbWithTimeout }));

const {
  verifyMigrationSchemaContract,
  MigrationVerificationError,
  parseIndexDefinition,
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
  /** Replace an index's key list, keeping its name and predicate. */
  driftIndexKeys?: { name: string; keys: string[] };
  /** Strip an index's partial predicate, keeping its name and keys. */
  dropIndexPredicate?: string;
  /** Add a predicate to an index declared to have none. */
  addIndexPredicate?: { name: string; predicate: string };
  /** Rebuild an index with a non-btree access method. */
  changeAccessMethod?: { name: string; method: string };
  /** Claim more key attributes than the key list contains (INCLUDE columns). */
  inflateKeyCount?: string;
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
  // Definitions are synthesized in the exact shape `pg_get_indexdef` emits, so
  // the parser under test is exercised rather than bypassed. A spec that only
  // declares fragments still gets a plausible key list built from them.
  const indexes = VERIFIED_INDEXES.filter(
    (spec) => spec.name !== damage.dropIndex,
  ).map((spec) => {
    const keys =
      damage.driftIndexKeys?.name === spec.name
        ? damage.driftIndexKeys.keys
        : (spec.keyExpressions ?? spec.definitionMustContain ?? []);
    const predicate =
      damage.dropIndexPredicate === spec.name
        ? null
        : damage.addIndexPredicate?.name === spec.name
          ? damage.addIndexPredicate.predicate
          : spec.predicate !== undefined
            ? spec.predicate
            : (spec.definitionMustContain ?? []).find((fragment) =>
                  fragment.startsWith("WHERE "),
                )
              ? (spec.definitionMustContain ?? [])
                  .find((fragment) => fragment.startsWith("WHERE "))!
                  .slice("WHERE ".length)
              : null;
    const keyList = keys
      .filter((key) => !key.startsWith("WHERE ") && key !== "UNIQUE")
      .join(", ");
    const method =
      damage.changeAccessMethod?.name === spec.name
        ? damage.changeAccessMethod.method
        : (spec.accessMethod ?? "btree");
    return {
      index_name: spec.name,
      table_name: spec.table,
      schema_name: "public",
      is_unique: spec.unique,
      is_valid: spec.name !== damage.invalidateIndex,
      is_ready: true,
      is_live: true,
      key_attribute_count:
        damage.inflateKeyCount === spec.name
          ? (spec.keyExpressions?.length ?? 0) + 1
          : (spec.keyExpressions?.length ?? 0),
      definition:
        `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX ${spec.name} ` +
        `ON public.${spec.table} USING ${method} (${keyList})` +
        (predicate ? ` WHERE ${predicate}` : ""),
    };
  });

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

  it("refuses a same-name repair-plan arbiter keyed on a SUBSET of the columns", async () => {
    // The 42P10 case. `CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
    // ON sync_repair_plans (build_id)` is a real unique index with the right
    // name and the right table, and every production `ON CONFLICT (build_id,
    // environment, provider_scope, plan_mode)` write against it fails.
    healthyCatalog({
      driftIndexKeys: {
        name: "sync_repair_plans_scope_mode_identity",
        keys: ["build_id", "environment"],
      },
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /sync_repair_plans_scope_mode_identity: key expressions are \(build_id, environment\)/,
    );
  });

  it("refuses a repair-plan arbiter that became PARTIAL", async () => {
    // A partial unique index cannot be inferred by an unqualified ON CONFLICT,
    // so this passes every name/column check and still breaks every write.
    healthyCatalog({
      addIndexPredicate: {
        name: "sync_repair_plans_scope_mode_identity",
        predicate: "(eligible)",
      },
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /sync_repair_plans_scope_mode_identity: predicate is '\(eligible\)', expected absent/,
    );
  });

  it("refuses an is_selected index drifted to (id) WHERE is_selected", async () => {
    // The exact drift the old `LIKE '%WHERE is_selected%'` check accepted: a
    // valid partial index that cannot serve the ordered current-selection read.
    healthyCatalog({
      driftIndexKeys: {
        name: "idx_business_provider_accounts_selected",
        keys: ["id"],
      },
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /idx_business_provider_accounts_selected: key expressions are \(id\)/,
    );
  });

  it("refuses an is_selected index that lost its predicate", async () => {
    healthyCatalog({ dropIndexPredicate: "idx_business_provider_accounts_selected" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /idx_business_provider_accounts_selected: predicate is absent, expected 'is_selected'/,
    );
  });

  it("refuses a release-gate index rebuilt with a non-btree access method", async () => {
    // A hash index on the same columns satisfies name, table, uniqueness and
    // column set, and cannot serve ORDER BY emitted_at DESC at all.
    healthyCatalog({
      changeAccessMethod: { name: "idx_sync_release_gates_key_latest", method: "hash" },
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /idx_sync_release_gates_key_latest: access method is hash/,
    );
  });

  it("refuses an index whose declared keys are actually INCLUDE columns", async () => {
    // INCLUDE columns are stored but not keys: they cannot serve an arbiter or
    // an ordering, so a definition whose key count disagrees with its key list
    // is a different index from the one asserted.
    healthyCatalog({ inflateKeyCount: "idx_sync_release_gates_key_latest" });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(/indnkeyatts is 7/);
  });

  it("refuses a release-gate index that lost the id tie-break", async () => {
    healthyCatalog({
      driftIndexKeys: {
        name: "idx_sync_release_gates_key_latest",
        keys: [
          "build_id",
          "environment",
          "gate_kind",
          "provider_scope",
          "emitted_at DESC",
        ],
      },
    });
    await expect(verifyMigrationSchemaContract()).rejects.toThrow(
      /idx_sync_release_gates_key_latest: key expressions are/,
    );
  });
});

describe("parseIndexDefinition", () => {
  it("keeps a parenthesised expression with a quoted literal as ONE key", () => {
    // The reason this is a scanner and not a `split(",")`: the comma inside
    // COALESCE belongs to the expression, and the one after it separates keys.
    const parsed = parseIndexDefinition(
      `CREATE INDEX x ON public.t USING btree (a, (COALESCE(b, 'meta'::text)), c DESC) WHERE (d IS NOT NULL)`,
    );
    expect(parsed.accessMethod).toBe("btree");
    expect(parsed.keyExpressions).toEqual([
      "a",
      "(COALESCE(b, 'meta'::text))",
      "c DESC",
    ]);
    expect(parsed.predicate).toBe("(d IS NOT NULL)");
  });

  it("reports no predicate for a total index and keeps quoted identifiers", () => {
    const parsed = parseIndexDefinition(
      `CREATE UNIQUE INDEX y ON public.t USING btree (business_id, "position", id)`,
    );
    expect(parsed.keyExpressions).toEqual(["business_id", '"position"', "id"]);
    expect(parsed.predicate).toBeNull();
  });
});
