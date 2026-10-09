import { describe, expect, it, vi } from "vitest";
import { ensureBusinessErasureStateRunIndex } from "@/lib/business-deletion-state-run-index";
const valid = { shape_valid: true, bounds_valid: true, lineage_valid: true, lookup_ready: true, named_index_conflict: false };
function fixture(overrides = {}, completes = true) {
  let built = false;
  return { query: vi.fn(async (text: string) => {
    if (text.startsWith("CREATE")) { built = completes; return []; }
    return [{ ...valid, ...overrides, ...(built ? { lookup_ready: true } : {}) }];
  }) };
}
describe("bounded state-run RI lookup", () => {
  it("adopts a valid full prefix without touching disk", async () => {
    const sql = fixture(), admit = vi.fn();
    expect((await ensureBusinessErasureStateRunIndex(sql as never, admit)).built).toBe(false);
    expect(admit).not.toHaveBeenCalled();
  });
  it("creates only the missing bounded lookup after capacity admission", async () => {
    const sql = fixture({ lookup_ready: false }), admit = vi.fn();
    expect((await ensureBusinessErasureStateRunIndex(sql as never, admit)).built).toBe(true);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(sql.query.mock.calls.find(([s]) => s.startsWith("CREATE"))?.[0]).toContain("WITH (fillfactor=90)");
  });
  it.each([{ shape_valid: false }, { bounds_valid: false }, { lineage_valid: false },
    { bounds_valid: "true" }, { named_index_conflict: true }, { lookup_ready: undefined }])(
    "refuses unsupported catalog evidence %j before admission or DDL", async overrides => {
      const sql = fixture(overrides), admit = vi.fn();
      await expect(ensureBusinessErasureStateRunIndex(sql as never, admit)).rejects.toThrow("state_run_index_contract");
      expect(admit).not.toHaveBeenCalled();
      expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
    });
  it("preserves a physical refusal and does not infer readiness from CREATE", async () => {
    const sql = fixture({ lookup_ready: false });
    await expect(ensureBusinessErasureStateRunIndex(sql as never, async () => { throw Error("capacity"); })).rejects.toThrow("capacity");
    expect(sql.query.mock.calls.every(([q]) => !q.startsWith("CREATE"))).toBe(true);
    await expect(ensureBusinessErasureStateRunIndex(fixture({ lookup_ready: false }, false) as never, vi.fn())).rejects.toThrow("not_ready");
  });
});
