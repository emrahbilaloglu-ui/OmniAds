import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordMetaDecisionResponse,
  runMetaDecisionIgnoredMarker,
  runMetaDecisionIgnoredMarkerIfDue,
} from "@/lib/meta/decision-responses";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

const db = await import("@/lib/db");
const readiness = await import("@/lib/db-schema-readiness");

function makeSqlMock(rows: unknown[] = []) {
  const calls: string[] = [];
  const tag = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve(rows);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn();
  return { tag, calls };
}

describe("meta decision responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-05-06T00:00:00.000Z",
    });
  });

  it("persists an operator response row", async () => {
    const sql = makeSqlMock([
      {
        rec_id: "rec_1",
        business_id: "biz_1",
        action: "acted",
        action_subtype: "bid_applied",
        timestamp: "2026-05-06T10:00:00.000Z",
        reappear_at: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await recordMetaDecisionResponse({
      recId: "rec_1",
      businessId: "biz_1",
      action: "acted",
      actionSubtype: "bid_applied",
    });

    expect(result).toEqual({
      recId: "rec_1",
      businessId: "biz_1",
      action: "acted",
      actionSubtype: "bid_applied",
      timestamp: "2026-05-06T10:00:00.000Z",
      reappearAt: null,
    });
    expect(sql.calls[0]).toContain("INSERT INTO meta_decision_responses");
  });

  it("marks stale recommendations ignored when no response exists", async () => {
    const sql = makeSqlMock([{ rec_id: "rec_1" }, { rec_id: "rec_2" }]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaDecisionIgnoredMarker({
      now: new Date("2026-05-14T04:00:00.000Z"),
    });

    expect(result.markedIgnored).toBe(2);
    expect(sql.calls[0]).toContain("auto_7d_no_response");
    expect(sql.calls[0]).toContain("NOT EXISTS");
  });

  it("runs the ignored marker only during the 04:00 UTC slot", async () => {
    const sql = makeSqlMock([]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await expect(
      runMetaDecisionIgnoredMarkerIfDue(new Date("2026-05-14T03:00:00.000Z")),
    ).resolves.toMatchObject({ skipped: true, reason: "not_due" });

    await expect(
      runMetaDecisionIgnoredMarkerIfDue(new Date("2026-05-14T04:00:00.000Z")),
    ).resolves.toMatchObject({ skipped: false, markedIgnored: 0 });
  });
});
