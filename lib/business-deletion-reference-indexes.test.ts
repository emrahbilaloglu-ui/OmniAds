import { describe, expect, it, vi } from "vitest";
import { BUSINESS_ERASURE_REFERENCE_INDEXES, ensureBusinessErasureReferenceIndexes } from "@/lib/business-deletion-reference-indexes";

const first = BUSINESS_ERASURE_REFERENCE_INDEXES[0];
const healthy = { relation_kind: "r", key_type: 2950, reference_foreign_key: true, lookup_ready: true, named_index_conflict: false };
function fixture(overrides: Record<string, unknown> = {}, completes = true) {
  let built = false;
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.startsWith("CREATE INDEX")) { built = completes; return []; }
    const selected = params?.[0] === first.table && params?.[1] === first.column;
    return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950, ...(selected ? overrides : {}), ...(selected && built ? { lookup_ready: true } : {}) }];
  });
  return { query };
}

describe("additive whole-business FK access schema", () => {
  it("adopts usable existing leading indexes without capacity reservation or DDL", async () => {
    const sql = fixture(), admit = vi.fn();
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, admit)).resolves.toMatchObject({ built: [] });
    expect(admit).not.toHaveBeenCalled();
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it("builds one missing nullable reference only after admission and verifies it", async () => {
    const sql = fixture({ lookup_ready: false }), admit = vi.fn();
    const result = await ensureBusinessErasureReferenceIndexes(sql as never, admit);
    expect(admit).toHaveBeenCalledExactlyOnceWith(`public.${first.table}`, "btree");
    expect(result.built).toEqual([first.index]);
    expect(sql.query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).toContain("CREATE INDEX CONCURRENTLY");
  });
  it("uses only the reviewed hash reference with a distinct admission basis", async () => {
    let built = false;
    const admit = vi.fn();
    const query = vi.fn(async (q: string, params?: unknown[]) => {
      if (q.startsWith("CREATE")) { built = true; return []; }
      return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950,
        lookup_ready: params?.[3] !== "hash" || built }];
    });
    const result = await ensureBusinessErasureReferenceIndexes({ query } as never, admit);
    expect(result.built).toEqual(["idx_biz_erase_campaign_reference"]);
    expect(admit).toHaveBeenCalledExactlyOnceWith("public.engine_v3_ad_decision_evaluations", "hash");
    expect(query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).toContain("USING hash (campaign_context_ref)");
  });
  it("uses supported parent/leaf DDL for a partitioned relation", async () => {
    const sql = fixture({ relation_kind: "p", lookup_ready: false });
    await ensureBusinessErasureReferenceIndexes(sql as never, vi.fn());
    expect(sql.query.mock.calls.find(([q]) => q.startsWith("CREATE"))?.[0]).not.toContain("CONCURRENTLY");
  });
  it("propagates physical refusal before creating any index", async () => {
    const sql = fixture({ lookup_ready: false });
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, async () => { throw Error("physical refusal"); })).rejects.toThrow("physical refusal");
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it.each([
    { key_type: 25 }, { reference_foreign_key: false }, { reference_foreign_key: "true" },
    { named_index_conflict: true }, { named_index_conflict: undefined },
    { lookup_ready: "true" }, { relation_kind: "v" },
  ])("refuses unsupported/ambiguous catalog evidence %j without mutation", async overrides => {
    const sql = fixture(overrides), admit = vi.fn();
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, admit)).rejects.toThrow("business_erasure_reference_index_contract");
    expect(admit).not.toHaveBeenCalled();
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
  });
  it("does not announce success when an acknowledged DDL leaves the lookup unusable", async () => {
    await expect(ensureBusinessErasureReferenceIndexes(fixture({ lookup_ready: false }, false) as never, vi.fn())).rejects.toThrow("reference_index_not_ready");
  });
  it("propagates catalog/DDL failure without repairing or dropping unknown indexes", async () => {
    const sql = fixture({ lookup_ready: false });
    sql.query.mockImplementation(async (q, params) => { if (q.startsWith("CREATE")) throw Error("DDL failed"); return [{ ...healthy, key_type: params?.[3] === "hash" ? 17 : 2950, lookup_ready: false }]; });
    await expect(ensureBusinessErasureReferenceIndexes(sql as never, vi.fn())).rejects.toThrow("DDL failed");
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("DROP"))).toBe(true);
  });
});
