import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db";
import { readNativeAdCalibrationSourceRows, READ_NATIVE_AD_CALIBRATION_SOURCE_BATCH_SQL } from "../../jobs/ad-calibration-job";

const input = { businessId: "00000000-0000-4000-8000-000000000001", providerAccountRefId: "00000000-0000-4000-8000-000000000002", providerAccountId: "act_test", asOf: "2026-09-28", computationCutoff: "2026-09-28T10:00:00.000Z" };

describe("bounded native calibration source read", () => {
  it("covers every day exactly once with the same account, as-of and knowledge cutoff", async () => {
    const seen: string[] = [];
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toBe(READ_NATIVE_AD_CALIBRATION_SOURCE_BATCH_SQL);
      expect(params.slice(0, 5)).toEqual([input.businessId, input.asOf, input.providerAccountRefId, input.providerAccountId, input.computationCutoff]);
      const rows = [];
      for (let day = new Date(`${params[5]}T00:00:00Z`); day <= new Date(`${params[6]}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
        const date = day.toISOString().slice(0, 10); seen.push(date);
        rows.push({ ad_id: "1", date, source_row_id: date });
      }
      return rows;
    });
    const rows = await readNativeAdCalibrationSourceRows({ query } as unknown as DbClient, input);
    expect(query).toHaveBeenCalledTimes(6);
    expect(rows).toHaveLength(90);
    expect(new Set(seen).size).toBe(90);
    expect(seen[0]).toBe("2026-07-01");
    expect(seen.at(-1)).toBe("2026-09-28");
  });

  it("restores reference lexical Ad/date/source order across interleaved chunks",async()=>{
    const query=vi.fn().mockResolvedValueOnce([
      {ad_id:"2",date:"2026-07-01",source_row_id:"b"},
      {ad_id:"10",date:"2026-07-02",source_row_id:"a"},
      {ad_id:"10",date:"2026-07-01",source_row_id:"b"},
    ]).mockResolvedValueOnce([{ad_id:"10",date:"2026-07-01",source_row_id:"a"}])
      .mockResolvedValue([]);
    expect(await readNativeAdCalibrationSourceRows({query} as unknown as DbClient,input)).toEqual([
      {ad_id:"10",date:"2026-07-01",source_row_id:"a"},
      {ad_id:"10",date:"2026-07-01",source_row_id:"b"},
      {ad_id:"10",date:"2026-07-02",source_row_id:"a"},
      {ad_id:"2",date:"2026-07-01",source_row_id:"b"},
    ]);
  });

  it("propagates a failed chunk rather than publishing a partial calibration", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ ad_id: "1", date: "2026-07-01", source_row_id: "1" }])
      .mockRejectedValueOnce(Object.assign(new Error("statement timeout"), { code: "57014" }));
    await expect(readNativeAdCalibrationSourceRows({ query } as unknown as DbClient, input)).rejects.toMatchObject({ code: "57014" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refuses an as-of/cutoff day mismatch before reading", async () => {
    const query = vi.fn();
    await expect(readNativeAdCalibrationSourceRows({ query } as unknown as DbClient, { ...input, computationCutoff: "2026-09-29T00:00:00Z" })).rejects.toThrow("current-only");
    expect(query).not.toHaveBeenCalled();
  });
});
