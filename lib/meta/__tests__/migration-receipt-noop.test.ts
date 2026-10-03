import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReceiptIdentityMigrationCapacity, RECEIPT_IDENTITY_INDEX_CONTRACTS } from "@/lib/migrations";

type Status = { index_name: string; receipt_index_satisfied: unknown };
const complete = (): Status[] => RECEIPT_IDENTITY_INDEX_CONTRACTS.map((x) => ({ index_name: x.index_name, receipt_index_satisfied: true }));
afterEach(() => vi.unstubAllEnvs());

function client(statuses: unknown, catalogError?: Error) {
  return { query: vi.fn(async (text: string) => {
    if (text.includes("AS receipt_index_satisfied")) {
      if (catalogError) throw catalogError;
      return statuses;
    }
    if (text.includes("COALESCE(pg_total_relation_size")) {
      return [{ relation_bytes: "6243614720", database_bytes: "173740203031" }];
    }
    if (text.includes("s.payload")) {
      return [{ payload: { disks: [{ path: "/var/lib/postgresql", availableBytes: 58262749184 }] }, age_seconds: "1" }];
    }
    throw new Error("unexpected catalog query");
  }) };
}

describe("only exact completed receipt index contracts omit the heavy-build reserve", () => {
  it("uses one catalog read with all five exact definitions and does no size/sample read for a complete replay", async () => {
    const sql = client(complete());
    await expect(assertReceiptIdentityMigrationCapacity(sql as never)).resolves.toMatchObject({ engaged: false });
    expect(sql.query).toHaveBeenCalledTimes(1);
    expect(sql.query.mock.calls[0]?.[0].trim()).toMatch(/^SELECT/);
  });
  it.each(RECEIPT_IDENTITY_INDEX_CONTRACTS.map((x) => x.index_name))("keeps the unchanged physical refusal if %s needs work", async (name) => {
    const rows = complete(); rows.find((x) => x.index_name === name)!.receipt_index_satisfied = false;
    const sql = client(rows);
    await expect(assertReceiptIdentityMigrationCapacity(sql as never))
      .rejects.toThrow("migration_capacity_refused:meta_entity_observation_receipt_identity");
    expect(sql.query).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "duplicate", "unknown", "string-true", "null", "not-array"])("cannot treat %s catalog evidence as a complete replay", async (kind) => {
    const rows = complete();
    if (kind === "missing") rows.pop();
    if (kind === "duplicate") rows[0] = { ...rows[1] };
    if (kind === "unknown") rows[0].index_name = "foreign_index";
    if (kind === "string-true") rows[0].receipt_index_satisfied = "true";
    if (kind === "null") rows[0].receipt_index_satisfied = null;
    const sql = client(kind === "not-array" ? { rows } : rows);
    await expect(assertReceiptIdentityMigrationCapacity(sql as never)).rejects.toThrow("migration_capacity_refused");
  });
  it("propagates an unreadable catalog without admitting a guessed no-op", async () => {
    const sql = client(complete(), new Error("catalog unavailable"));
    await expect(assertReceiptIdentityMigrationCapacity(sql as never)).rejects.toThrow("catalog unavailable");
    expect(sql.query).toHaveBeenCalledTimes(1);
  });
  it("does not let an operator override bypass a measured physical shortfall for required work", async () => {
    vi.stubEnv("ADSECUTE_MIGRATION_CAPACITY_OVERRIDE", "fixture-override");
    const rows = complete(); rows[0].receipt_index_satisfied = false;
    await expect(assertReceiptIdentityMigrationCapacity(client(rows) as never))
      .rejects.toThrow("cannot bypass a physical capacity refusal");
  });
});
