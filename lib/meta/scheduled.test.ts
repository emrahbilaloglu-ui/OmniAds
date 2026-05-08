import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMetaSnapshotJobIfDue } from "@/lib/meta/scheduled";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/meta/snapshot", () => ({
  runMetaSnapshotForAllBusinesses: vi.fn(),
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(),
}));

const db = await import("@/lib/db");
const readiness = await import("@/lib/db-schema-readiness");
const snapshot = await import("@/lib/meta/snapshot");
const activeBusinesses = await import("@/lib/sync/active-businesses");

function makeSqlMock(snapshotBusinessCount: number) {
  const tag = vi.fn(() => Promise.resolve([{ business_count: snapshotBusinessCount }])) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn();
  return tag;
}

describe("runMetaSnapshotJobIfDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-05-08T00:00:00.000Z",
    });
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_1", name: "Biz 1" },
      { id: "biz_2", name: "Biz 2" },
    ] as never);
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue({
      snapshotDate: "2026-05-08",
      businessCount: 2,
      results: [],
    });
  });

  it("skips outside the daily UTC slot", async () => {
    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T02:00:00.000Z"));

    expect(result).toEqual({ skipped: true, reason: "outside_slot", snapshotDate: "2026-05-08" });
    expect(snapshot.runMetaSnapshotForAllBusinesses).not.toHaveBeenCalled();
  });

  it("does not treat calibration-only or partial snapshot coverage as already-run", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock(1));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T03:10:00.000Z"));

    expect(result.skipped).toBe(false);
    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith("2026-05-08");
  });

  it("skips only when all active businesses already have snapshot rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock(2));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T03:10:00.000Z"));

    expect(result).toEqual({ skipped: true, reason: "already_ran", snapshotDate: "2026-05-08" });
    expect(snapshot.runMetaSnapshotForAllBusinesses).not.toHaveBeenCalled();
  });
});
