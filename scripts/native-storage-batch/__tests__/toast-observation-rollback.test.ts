import { describe, expect, it } from "vitest";
import { observeTargetToast, toastObservationAcknowledged } from "../maintenance";
import { CONTEXT, EVAL } from "../common";
const rows = [CONTEXT, EVAL].sort().map((relation, i) => ({ relation, toast_oid: String(100 + i), relpages: "1", reltuples: "1",
  relallvisible: "1", toast_bytes: "8192", toast_index_bytes: "8192", live: "1", dead: "0", inserted: "1", deleted: "0",
  vacuum_count: "1", autovacuum_count: "0", vacuum_in_progress: false, read_only: "on", observed_at: "2026-10-05T17:30:00Z",
  last_vacuum: null, last_autovacuum: null }));
function db(failRollback: boolean) {
  const sent: string[] = [];
  return { sent, query: async (sql: string) => {
    sent.push(sql); if (sql === "ROLLBACK" && failRollback) throw new Error("ROOT_ROLLBACK_FAILURE");
    return { rows: sql.startsWith("SELECT c.relname") ? rows : [] };
  } };
}
describe("post-retirement observation explicit rollback authority", () => {
  it("cannot acknowledge the read when explicit ROLLBACK fails", async () => {
    const client = db(true);
    await expect(observeTargetToast(client as unknown as Parameters<typeof observeTargetToast>[0])).rejects.toThrow("ROOT_ROLLBACK_FAILURE");
    expect(client.sent.at(-1)).toBe("ROLLBACK");
  });
  it("acknowledges successful READ ONLY observation only after actual ROLLBACK", async () => {
    const client = db(false); const observed = await observeTargetToast(client as unknown as Parameters<typeof observeTargetToast>[0]);
    expect(client.sent.at(-1)).toBe("ROLLBACK"); expect(toastObservationAcknowledged(observed)).toBe(true);
    expect(observed.vacuumCommandExecuted).toBe(false); expect(observed.toastVacuumAcknowledged).toBe(false);
  });
});
