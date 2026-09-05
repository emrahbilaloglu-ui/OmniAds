import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  metaSnapshotSlotFor,
  runMetaSnapshotJobIfDue,
} from "@/lib/meta/scheduled";

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

function makeSqlMock(rows: Array<{ business_id: string; has_campaign_rows: boolean; has_adset_rows: boolean }>) {
  const tag = vi.fn(() => Promise.resolve(rows)) as unknown as ReturnType<typeof db.getDb>;
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

  it("skips before the day's first slot opens", async () => {
    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T02:00:00.000Z"));

    expect(result).toEqual({ skipped: true, reason: "outside_slot", snapshotDate: "2026-05-08" });
    expect(snapshot.runMetaSnapshotForAllBusinesses).not.toHaveBeenCalled();
  });

  it("runs the day's second slot in the afternoon", async () => {
    /*
      The reason there is a second slot at all: native `cut` decisions are
      withheld when their inputs are older than 12 hours, so a single 03:00
      production refused everything from 15:00 onwards. The mock's run table
      is empty, so the 03 slot is still outstanding and gets picked first —
      which is the catch-up behaviour, and the point of running at all.
    */
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock([]));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T15:10:00.000Z"));

    expect(result.skipped).toBe(false);
    expect(result.slot).toBe(3);
    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith("2026-05-08");
  });

  it("does not treat calibration-only or partial snapshot coverage as already-run", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock([
      { business_id: "biz_1", has_campaign_rows: false, has_adset_rows: true },
    ]));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T03:10:00.000Z"));

    expect(result.skipped).toBe(false);
    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith("2026-05-08");
  });

  it("skips only when all active businesses already have campaign and adset snapshot rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock([
      { business_id: "biz_1", has_campaign_rows: true, has_adset_rows: true },
      { business_id: "biz_2", has_campaign_rows: true, has_adset_rows: true },
    ]));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T03:10:00.000Z"));

    expect(result).toEqual({
      skipped: true, reason: "already_ran", snapshotDate: "2026-05-08", slot: 3,
    });
    expect(snapshot.runMetaSnapshotForAllBusinesses).not.toHaveBeenCalled();
  });

  it("reruns when a business has adset rows but no campaign rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock([
      { business_id: "biz_1", has_campaign_rows: false, has_adset_rows: true },
      { business_id: "biz_2", has_campaign_rows: true, has_adset_rows: true },
    ]));

    const result = await runMetaSnapshotJobIfDue(new Date("2026-05-08T03:10:00.000Z"));

    expect(result.skipped).toBe(false);
    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith("2026-05-08");
  });
});

describe("metaSnapshotSlotFor", () => {
  /*
    Windows, not instants. The cron ticks every ten minutes and a tick can be
    missed; `=== 3` meant a missed 03:00 cost the whole day's production, and
    everything downstream of it.
  */
  it.each([
    ["02:59", "2026-05-08T02:59:00.000Z", null],
    ["03:00", "2026-05-08T03:00:00.000Z", 3],
    ["03:40 — a late tick still lands in the 03 slot", "2026-05-08T03:40:00.000Z", 3],
    ["14:59 — still the morning slot's window", "2026-05-08T14:59:00.000Z", 3],
    ["15:00", "2026-05-08T15:00:00.000Z", 15],
    ["23:50 — the afternoon slot stays open all evening", "2026-05-08T23:50:00.000Z", 15],
  ])("%s", (_label, iso, expected) => {
    expect(metaSnapshotSlotFor(new Date(iso))).toBe(expected);
  });
});
