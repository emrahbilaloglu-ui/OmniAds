import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));

import {
  listStageableLaunchDecisions,
  projectMetaLaunchIntents,
} from "@/lib/meta/launch-intent-producer";

const BUSINESS_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

describe("launch candidate query snapshot boundary", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it("binds the requested historical date through the production reader", async () => {
    const result = await projectMetaLaunchIntents({
      businessId: BUSINESS_ID,
      snapshotDate: "2026-08-19",
      readCreativeMode: async () => "semi_auto",
      stageIntent: async () => { throw new Error("no candidate may stage"); },
    });
    expect(result.candidates).toBe(0);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual([
      BUSINESS_ID, ["scale", "refresh"], "add_to_existing", "new_campaign", "2026-08-19",
    ]);
    expect(sql).toContain("s.as_of_date <= $5::date");
    expect(sql).not.toMatch(/CURRENT_DATE|NOW\(\)/i);
    expect(sql).toContain("s.business_ref_id = $1::uuid");
    expect(sql).toContain("b.business_id = $1::uuid");
    expect(sql).toContain("d.business_id = $1::uuid");
    expect(sql).toContain("d.provider_account_id = b.provider_account_id");
  });

  it("accepts a real leap-day ceiling unchanged", async () => {
    await listStageableLaunchDecisions(BUSINESS_ID, "2028-02-29");
    expect(query.mock.calls[0]![1][4]).toBe("2028-02-29");
  });

  it.each(["2026-02-29", "2026-02-30", "2026-9-05", "2026-09-05T00:00:00Z"])(
    "refuses an invalid query date before database access: %s",
    async (date) => {
      await expect(listStageableLaunchDecisions(BUSINESS_ID, date))
        .rejects.toThrow("launch_intent_snapshot_date_invalid");
      expect(query).not.toHaveBeenCalled();
    },
  );
});
